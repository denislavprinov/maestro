# Recoverable-error retry gate

**Date:** 2026-06-26
**Status:** Approved (design)

## Problem

When a pipeline node calls `claude` headless and the call fails with an
authentication error (e.g. `Failed to authenticate. API Error: 401 Invalid
authentication credentials`), the error propagates out of `_runNode` →
`_runStep` → `_dispatch` → `run()`'s catch, which sets the pipeline status to
`error`. The whole run dies, discarding all prior work, even though the failure
is fully recoverable: the user only needs to re-authenticate.

The same is true for other transient/recoverable failures — rate limits,
overloaded API, network blips, and quota/billing problems. None of these are
bugs in the run; all are fixable by the user (or by waiting) and then retrying.

## Goal

When a node hits a **recoverable** error, do not kill the pipeline. Instead:

- **Interactive runs:** prompt the user with the error and a Retry / Abort
  choice. The user fixes the underlying problem (re-authenticates, waits out a
  rate limit, tops up credit), clicks **Retry**, and the same node re-runs in
  place — no worktree teardown, in-memory bus state preserved. **Abort** falls
  back to today's behavior (status `error`).
- **Auto / non-interactive runs** (`--yes`, scheduled): no human is present, so
  retry the node a bounded number of times with backoff. If still failing,
  fall back to today's behavior (status `error`).

Non-recoverable errors (real bugs) keep failing immediately, exactly as today.

## Recoverable error classes

All four are in scope:

| Class        | Examples                                                              |
|--------------|----------------------------------------------------------------------|
| `auth`       | 401, "invalid authentication", "authentication_error", not logged in |
| `rate_limit` | 429, 529, "rate limit", "overloaded"                                  |
| `quota`      | "credit balance too low", "usage limit", "quota", billing            |
| `network`    | ECONNRESET, ETIMEDOUT, ENOTFOUND, EAI_AGAIN, "socket hang up", "fetch failed" |

## Why this works with the existing architecture

- `runReal` already folds the real cause of a failed headless call (including
  the auth string above) into its reject message — in stream-json mode `claude`
  reports auth/model/API failures as a terminal `result` event with
  `is_error:true` on stdout and exits non-zero, and `runReal` surfaces that text
  (`src/core/claude-runner.mjs:289-304`). So classification can run off
  `err.message`.
- The orchestrator already has a question gate (`_ask` / `answer` /
  `pendingQuestion`, kinds `clarify` | `gate`) that freezes the active-time
  clock, emits a `question` event to UI/CLI, and resolves when `answer(id,
  payload)` is called. A recovery prompt is a third kind that reuses all of it.
- The orchestrator already has pause/stop semantics that reject the pending
  question; these continue to win over a recovery prompt (Ctrl-C / pause during a
  recovery prompt unwinds normally).

## Components

### 1. `src/core/recoverable-error.mjs` (new) — classifier

A single pure function, the one source of truth for "is this recoverable, and
which class":

```js
export function classifyError(err) {
  const msg = String(err?.message || err || '');
  if (/\b401\b|invalid authentication|authentication_error|please run .*login|not logged in/i.test(msg)) return 'auth';
  if (/\b429\b|\b529\b|rate.?limit|overloaded/i.test(msg)) return 'rate_limit';
  if (/credit balance|usage limit|quota|insufficient_quota|billing/i.test(msg)) return 'quota';
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|connection (refused|reset)/i.test(msg)) return 'network';
  return null; // not recoverable → fail as today
}
```

Pure and isolated → unit-tested on its own.

### 2. `_runNode` — catch and route to a recovery loop

The runner call in `_runNode` (`src/core/orchestrator.mjs:1426-1442`) is wrapped
in a retry loop. The existing vanished-session fallback is extracted verbatim
into `_runOnce(node, ctx)` (today's inner runner call + single fresh re-run on a
dead session), so that path is unchanged.

```js
for (let attempt = 1; ; attempt++) {
  try {
    result = await this._runOnce(node, ctx);
    break;
  } catch (err) {
    if (this.pauseRequested && (isAbort(err) || isPause(err) || this.pauseAbort.signal.aborted)) {
      endMark = 'paused'; throw pauseErr();
    }
    if (isAbort(err) || isPause(err)) throw err;
    const cls = classifyError(err);
    if (!cls) throw err;                       // not recoverable → today's path
    const decision = await this._recover({ node, cls, err, attempt });
    if (decision === 'abort') throw err;       // user/auto gave up → fail as today
    this._nodeStep(node, stepIndex, cycle, 'retry');  // UI: node back to running
    // loop → re-run the node fresh
  }
}
```

Abort/pause are checked **before** classification so a stop/pause always wins
over a recoverable error.

### 3. `_recover()` — shared recovery gate

One in-flight recovery per error class. Concurrent sibling nodes (fan-out /
workspace steps run via `Promise.all` in `_runStep`) that fail with the same
class dedupe onto a single prompt; one Retry re-runs them all.

```js
async _recover({ node, cls, err, attempt }) {
  this._log(node.key, 'warn', `recoverable ${cls} error: ${err.message}`);
  await appendAudit(this.pipeline.dir, `Recoverable **${cls}** error on ${node.key}: ${firstLine(err.message)}`).catch(() => {});

  // Auto / non-interactive: bounded backoff, no human.
  if (this.auto) {
    if (attempt > RECOVERY_MAX_AUTO_ATTEMPTS) return 'abort';
    await this._backoff(attempt, this.pauseAbort.signal); // abort-aware
    return 'retry';
  }

  // Interactive: ONE shared prompt per class; siblings await the same promise.
  this._recovery ||= new Map();
  if (!this._recovery.has(cls)) {
    const p = this._ask({
      id: `recovery-${cls}-${this._recoveryNonce()}`,
      kind: 'recovery',
      recovery: { cls, message: firstLine(err.message) },
    })
      .then((ans) => (ans?.decision === 'abort' ? 'abort' : 'retry'))
      .finally(() => this._recovery.delete(cls));
    this._recovery.set(cls, p);
  }
  return this._recovery.get(cls);
}
```

- `_ask` already freezes the clock, emits `question`, and waits on
  `pendingQuestion`; recovery reuses it.
- Pause/stop while a recovery prompt is open rejects `pendingQuestion`, so
  `_ask` throws and the run unwinds as a pause/abort — correct.
- Constants: `RECOVERY_MAX_AUTO_ATTEMPTS = 3` (override via
  `MAESTRO_RECOVERY_MAX_ATTEMPTS`); backoff `1s / 2s / 4s`, abort-aware via the
  pause-only signal. `_recoveryNonce()` is a small monotonic counter on the
  instance (the codebase forbids `Date.now()`-style nondeterminism in some
  contexts and a counter keeps ids stable and test-friendly).

### 4. UI + CLI

**UI** (`ui/public/app.js`):
- `renderQpanel` gains a `pq.kind === 'recovery'` branch → `renderRecoveryBody`:
  title "`<class>` error — action needed", the error message, an intro ("Fix the
  problem — e.g. re-authenticate — then Retry"), and buttons **Retry** (primary)
  / **Abort run**.
- Click delegation (`ui/public/app.js:4957`): `.recovery-retry` →
  `postAnswer(r, { decision: 'retry' })`; `.recovery-abort` →
  `postAnswer(r, { decision: 'abort' })`.
- `ui/server.mjs` already forwards arbitrary `question` events and stores
  `pendingQuestion`; no server change needed.

**CLI** (`src/cli/maestro.mjs:338`):
- Add `else if (kind === 'recovery')` → `askRecovery(rl, recovery)`: prints the
  class + error and reads `r`etry / `a`bort, returns `{ decision }`.
- The `--yes` auto path never reaches the prompt — auto mode is handled inside
  `_recover` before `_ask` — so `--yes` means bounded retry then abort,
  consistent with the UI auto behavior.

## Data flow

```
runner throws
  └─ _runOnce rethrows
       └─ _runNode catch
            ├─ abort/pause?  → rethrow (pause/abort wins)
            ├─ classifyError == null? → rethrow (status error, as today)
            └─ _recover(cls)
                 ├─ auto:  backoff(attempt) → 'retry' | (attempt>max) → 'abort'
                 └─ interactive: shared _ask(kind:'recovery') per class
                       → user Retry → 'retry'   (loop re-runs node)
                       → user Abort → 'abort'   (rethrow → status error)
```

## Error handling / edge cases

- **Pause or stop during a recovery prompt:** existing `pause()` / `stop()`
  reject `pendingQuestion`; `_ask` throws pause/abort; run unwinds correctly,
  no special-casing.
- **A node that keeps failing in interactive mode:** each failure re-opens the
  shared prompt; the user can Abort at any time. No attempt cap interactively
  (the human is the cap).
- **Different classes failing together:** keyed by class, so an auth failure and
  a network failure produce two distinct prompts; same-class siblings share one.
- **Non-recoverable errors:** `classifyError` returns null → unchanged path.

## Testing

- `test/recoverable-error.test.mjs` — classifier table: the exact 401 string
  from the report, 429, 529, ECONNRESET, "credit balance too low", and a plain
  bug message → null.
- `test/orchestrator-recovery.test.mjs` — fake runner injected via the runner
  registry:
  - auth-once-then-succeed + interactive `answer(id, {decision:'retry'})` → run
    completes `done`.
  - auth-once + `answer(id, {decision:'abort'})` → status `error`.
  - always-throw + `auto:true` → bounded attempts (3) then status `error`;
    assert backoff invoked.
  - two parallel nodes both throwing the same class → a single `question` event,
    one `answer`, both nodes retry (shared-gate dedupe).

## Out of scope (YAGNI)

- Auto-pause + DB-persisted resume across process restart for recoverable errors
  (the in-place prompt covers the reported need; the existing pause/resume path
  is still available manually).
- Per-class custom retry budgets / jitter beyond the simple bounded backoff.
- Detecting recoverable errors from anything other than the thrown message
  (e.g. structured error codes) — the message carries the cause today.


---

# Implementation Plan

# Recoverable-error retry gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a pipeline node fails with a recoverable error (auth / rate-limit / network / quota), prompt the user to retry in place (interactive) or bounded auto-retry (non-interactive) instead of killing the run.

**Architecture:** A pure `classifyError` module is the single source of truth for "is this recoverable, which class". `_runNode` wraps its runner call in a retry loop: on a classified error it calls `_recover`, which either runs a bounded backoff (auto mode) or opens one shared recovery prompt per error class through the existing `_ask`/`answer` question gate (interactive). UI and CLI gain a `recovery` question kind that renders the error plus Retry / Abort.

**Tech Stack:** Node.js ESM (`.mjs`), `node:test` + `node:assert/strict`, vanilla-JS browser UI (`ui/public/app.js`), readline CLI (`src/cli/maestro.mjs`).

## Global Constraints

- ESM only (`.mjs`), match existing module style — no TypeScript, no new deps.
- No `Date.now()` / `Math.random()` for ids in orchestrator code that feeds resume/replay determinism — use a monotonic instance counter (mirrors existing `_subAgentFallbackSeq`).
- Non-recoverable errors MUST keep failing immediately (status `error`) exactly as today.
- Abort (stop) and pause MUST win over a recovery prompt — check them before classification.
- UI DOM wiring has no jsdom harness in this repo; DOM-building code is verified by `MAESTRO_MOCK=1 npm run smoke` + manual check, following the existing `renderGateBody` precedent (pure logic is unit-tested, DOM building is not).

---

### Task 1: Error classifier module

**Files:**
- Create: `src/core/recoverable-error.mjs`
- Test: `test/recoverable-error.test.mjs`

**Interfaces:**
- Produces: `classifyError(err: Error|string|unknown): 'auth'|'rate_limit'|'quota'|'network'|null` — returns the recoverable class, or `null` when the error is not recoverable.

- [ ] **Step 1: Write the failing test**

Create `test/recoverable-error.test.mjs`:

```js
// test/recoverable-error.test.mjs — pure classifier unit tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../src/core/recoverable-error.mjs';

test('classifies the reported headless auth failure as auth', () => {
  const e = new Error('claude exited with code 1: Failed to authenticate. API Error: 401 Invalid authentication credentials');
  assert.equal(classifyError(e), 'auth');
});

test('classifies authentication_error / not-logged-in as auth', () => {
  assert.equal(classifyError(new Error('authentication_error: token expired')), 'auth');
  assert.equal(classifyError(new Error('Not logged in. Please run claude login')), 'auth');
});

test('classifies 429 / 529 / overloaded as rate_limit', () => {
  assert.equal(classifyError(new Error('API Error: 429 rate_limit_error')), 'rate_limit');
  assert.equal(classifyError(new Error('API Error: 529 Overloaded')), 'rate_limit');
});

test('classifies credit/quota/billing as quota', () => {
  assert.equal(classifyError(new Error('Your credit balance is too low to access the API')), 'quota');
  assert.equal(classifyError(new Error('usage limit reached')), 'quota');
});

test('classifies connectivity failures as network', () => {
  assert.equal(classifyError(new Error('request to https://api.anthropic.com failed, reason: ECONNRESET')), 'network');
  assert.equal(classifyError(new Error('fetch failed')), 'network');
  assert.equal(classifyError(new Error('socket hang up')), 'network');
});

test('returns null for a plain bug and accepts a raw string', () => {
  assert.equal(classifyError(new Error('TypeError: x is not a function')), null);
  assert.equal(classifyError('401 Invalid authentication credentials'), 'auth');
  assert.equal(classifyError(null), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/recoverable-error.test.mjs`
Expected: FAIL — `Cannot find module '../src/core/recoverable-error.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/recoverable-error.mjs`:

```js
// src/core/recoverable-error.mjs
// Single source of truth for "is this pipeline error recoverable, and which class".
// Recoverable errors are user/transient-fixable (re-auth, wait, top up, retry),
// NOT bugs. The orchestrator uses the class to drive a retry gate; a null result
// means "fail as today". Classification reads the thrown message because runReal
// folds the real headless cause (incl. the 401 auth string) into its reject text.
//
// @param {Error|string|unknown} err
// @returns {'auth'|'rate_limit'|'quota'|'network'|null}
export function classifyError(err) {
  const msg = String((err && err.message) || err || '');
  if (/\b401\b|invalid authentication|authentication_error|please run .*login|not logged in/i.test(msg)) return 'auth';
  if (/\b429\b|\b529\b|rate.?limit|overloaded/i.test(msg)) return 'rate_limit';
  if (/credit balance|usage limit|quota|insufficient_quota|billing/i.test(msg)) return 'quota';
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|connection (refused|reset)/i.test(msg)) return 'network';
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/recoverable-error.test.mjs`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/recoverable-error.mjs test/recoverable-error.test.mjs
git commit -m "feat: add recoverable-error classifier"
```

---

### Task 2: Orchestrator recovery loop + shared gate

**Files:**
- Modify: `src/core/orchestrator.mjs` — import block (`:23-39`), constructor fields (near `:186`), `_runNode` (`:1416-1454`), add `_runOnce` / `_recover` / `_backoff` / `_recoveryNonce` methods, module const near the bottom helpers (`:2485`).
- Test: `test/orchestrator-recovery.test.mjs`

**Interfaces:**
- Consumes: `classifyError` (Task 1); existing `isAbort`, `isPause`, `pauseErr`, `firstLine` (orchestrator module scope); existing `this._ask({ id, kind, ... })`, `this.answer(id, payload)`, `this._nodeStep(node, stepIndex, cycle, status)`, `this.auto`, `this.pauseAbort`.
- Produces:
  - `this._runOnce(node, ctx): Promise<any>` — runs the node's runner once, with the existing dead-session fresh re-run fallback.
  - `this._recover({ node, cls, err, attempt }): Promise<'retry'|'abort'>`.
  - `this._backoff(attempt, signal): Promise<void>` — abort-aware delay; base ms from `MAESTRO_RECOVERY_BACKOFF_MS` (default 1000), doubling per attempt.
  - `this._recoveryNonce(): number` — monotonic per-instance id source.
  - module const `RECOVERY_MAX_AUTO_ATTEMPTS` (default 3, override `MAESTRO_RECOVERY_MAX_ATTEMPTS`).

- [ ] **Step 1: Write the failing test**

Create `test/orchestrator-recovery.test.mjs`:

```js
// test/orchestrator-recovery.test.mjs — recoverable-error retry gate.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { useTempHome } from './helpers/temp-home.mjs';
import { createOrchestrator } from '../src/core/orchestrator.mjs';

useTempHome(after);
process.env.MAESTRO_RECOVERY_BACKOFF_MS = '0'; // no real waiting in tests

function gitDir() {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-recovery-'));
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: dir });
  return dir;
}

const AUTH_ERR = () => new Error('claude exited with code 1: Failed to authenticate. API Error: 401 Invalid authentication credentials');
const okVerifier = async () => ({ status: 'ok', issues: [], review: { issues: [] }, summary: '' });

// Producer that throws an auth error on its FIRST call, then succeeds.
function authOnceProducer() {
  let thrown = false;
  return async () => {
    if (!thrown) { thrown = true; throw AUTH_ERR(); }
    return { status: 'ok', summary: 'done' };
  };
}

// Auto-answer clarify with the first option; route recovery to a fixed decision.
function answerWith(getOrch, recoveryDecision) {
  return ({ id, kind, questions }) => {
    if (kind === 'clarify') {
      getOrch().answer(id, { answers: (questions || []).map((q) => ({ id: q.id, choice: (q.options || ['auto'])[0] })) });
    } else if (kind === 'recovery') {
      getOrch().answer(id, { decision: recoveryDecision });
    } else {
      getOrch().answer(id, { decision: 'continue' }); // gates
    }
  };
}

test('interactive: recoverable error -> Retry re-runs the node, run completes', async () => {
  const dir = gitDir();
  let orch;
  orch = createOrchestrator({
    projectDir: dir, prompt: 'demo', auto: false, claude: { mock: true },
    runners: { producer: authOnceProducer(), verifier: okVerifier },
  });
  orch.on('question', answerWith(() => orch, 'retry'));
  const res = await orch.run();
  assert.equal(res.status, 'done');
});

test('interactive: recoverable error -> Abort fails the run as today', async () => {
  const dir = gitDir();
  let orch;
  orch = createOrchestrator({
    projectDir: dir, prompt: 'demo', auto: false, claude: { mock: true },
    runners: { producer: authOnceProducer(), verifier: okVerifier },
  });
  orch.on('question', answerWith(() => orch, 'abort'));
  const res = await orch.run();
  assert.equal(res.status, 'error');
});

test('auto: bounded retry then fail when the error never clears', async () => {
  const dir = gitDir();
  let calls = 0;
  const alwaysAuth = async () => { calls++; throw AUTH_ERR(); };
  const orch = createOrchestrator({
    projectDir: dir, prompt: 'demo', auto: true, claude: { mock: true },
    runners: { producer: alwaysAuth, verifier: okVerifier },
  });
  const res = await orch.run();
  assert.equal(res.status, 'error');
  // First producer node: 1 initial + RECOVERY_MAX_AUTO_ATTEMPTS retries = 4 calls.
  assert.equal(calls, 4);
});

test('shared gate: two concurrent recoveries of one class open ONE prompt', async () => {
  const dir = gitDir();
  const orch = createOrchestrator({ projectDir: dir, prompt: 'x', auto: false, claude: { mock: true } });
  orch.pipeline = { id: 1, dir, promptText: 'x' };   // minimal ctx for appendAudit/log
  let asks = 0;
  orch._ask = async ({ id }) => { asks++; orch.__rid = id; return { decision: 'retry' }; };
  const node = { key: 'planner', nodeId: 'n1' };
  const [a, b] = await Promise.all([
    orch._recover({ node, cls: 'auth', err: AUTH_ERR(), attempt: 1 }),
    orch._recover({ node, cls: 'auth', err: AUTH_ERR(), attempt: 1 }),
  ]);
  assert.equal(a, 'retry');
  assert.equal(b, 'retry');
  assert.equal(asks, 1, 'one shared prompt for both same-class failures');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/orchestrator-recovery.test.mjs`
Expected: FAIL — the first test ends with status `error` (auth error propagates today; no recovery), and `orch._recover` is `undefined` in the shared-gate test.

- [ ] **Step 3: Add the import**

In `src/core/orchestrator.mjs`, after the `./store.mjs` import (`:40`), add:

```js
import { classifyError } from './recoverable-error.mjs';
```

- [ ] **Step 4: Add constructor fields**

In the constructor, immediately after `this.pendingQuestion = null;` (`:186`), add:

```js
    this._recovery = null;      // class -> in-flight Promise<'retry'|'abort'> (shared gate)
    this._recoverySeq = 0;      // monotonic id source for recovery prompts (determinism-safe)
```

- [ ] **Step 5: Add the module const**

In `src/core/orchestrator.mjs`, just above `function isAbort(err)` (`:2485`), add:

```js
/** Max auto-mode retries for a recoverable error before falling back to status error. */
const RECOVERY_MAX_AUTO_ATTEMPTS = (() => {
  const n = Number(process.env.MAESTRO_RECOVERY_MAX_ATTEMPTS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
})();
```

- [ ] **Step 6: Extract `_runOnce` and wrap `_runNode` in the retry loop**

Replace the body of `_runNode` from the first `let result;` line through the closing of the inner try/catch (`src/core/orchestrator.mjs:1424-1451`) with the loop below. The inner dead-session fallback moves verbatim into `_runOnce`.

```js
    let result;
    let endMark = 'done';
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          result = await this._runOnce(node, ctx);
          break;
        } catch (err) {
          // Pause/stop always win over a recoverable error.
          if (this.pauseRequested && (isAbort(err) || isPause(err) || this.pauseAbort.signal.aborted)) {
            endMark = 'paused';
            throw pauseErr();
          }
          if (isAbort(err) || isPause(err)) throw err;
          const cls = classifyError(err);
          if (!cls) throw err;                    // not recoverable -> today's path
          const decision = await this._recover({ node, cls, err, attempt });
          if (decision === 'abort') throw err;    // user/auto gave up -> fail as today
          this._nodeStep(node, stepIndex, cycle, 'start'); // node back to running for the retry
          // loop -> re-run the node fresh
        }
      }
    } catch (err) {
      if (this.pauseRequested && (isAbort(err) || isPause(err) || this.pauseAbort.signal.aborted)) {
        endMark = 'paused';
        throw pauseErr();
      }
      throw err;
    } finally {
      this._nodeStep(node, stepIndex, cycle, endMark);
    }
    // CONV-6: no shared-bus mutation here — _runStep merges results in node order.
    return { node, result, ctx };
  }

  /** Run a node's runner once, with the spec §7 vanished-session fresh re-run
   *  fallback (a dead `--resume` session must not fail the run). Extracted from
   *  _runNode so the recovery loop wraps a single clean call. */
  async _runOnce(node, ctx) {
    const runner = this._runners[node.runnerType];
    if (typeof runner !== 'function') throw new Error(`no runner for type "${node.runnerType}"`);
    try {
      return await runner(ctx);
    } catch (err) {
      if (ctx.resumeSessionId && !isAbort(err) && !isPause(err) && !this.pauseRequested) {
        this._log(node.key, 'warn', `session resume failed (${err?.message || err}); re-running the step fresh`);
        await appendAudit(this.pipeline.dir, `Resume fallback: node ${node.nodeId} re-ran fresh (session resume failed).`).catch(() => {});
        ctx.resumeSessionId = undefined;
        return await runner(ctx);
      }
      throw err;
    }
  }

  /** Decide how to recover from a classified error. Auto mode: bounded backoff
   *  then give up. Interactive: ONE shared prompt per error class — concurrent
   *  sibling nodes failing with the same class await the same answer, so a single
   *  Retry re-runs them all. Returns 'retry' | 'abort'. */
  async _recover({ node, cls, err, attempt }) {
    this._log(node.key, 'warn', `recoverable ${cls} error: ${err.message}`);
    await appendAudit(this.pipeline.dir, `Recoverable **${cls}** error on ${node.key}: ${firstLine(err.message)}`).catch(() => {});

    if (this.auto) {
      if (attempt > RECOVERY_MAX_AUTO_ATTEMPTS) return 'abort';
      await this._backoff(attempt, this.pauseAbort.signal);
      return 'retry';
    }

    this._recovery ||= new Map();
    if (!this._recovery.has(cls)) {
      const p = this._ask({
        id: `recovery-${cls}-${this._recoveryNonce()}`,
        kind: 'recovery',
        recovery: { cls, message: firstLine(err.message) },
      })
        .then((ans) => (ans && ans.decision === 'abort' ? 'abort' : 'retry'))
        .finally(() => { if (this._recovery) this._recovery.delete(cls); });
      this._recovery.set(cls, p);
    }
    return this._recovery.get(cls);
  }

  /** Abort-aware backoff: base * 2^(attempt-1) ms, resolving early (and still
   *  'retry') if the pause-only signal fires so a pause is not delayed. */
  _backoff(attempt, signal) {
    const base = (() => {
      const n = Number(process.env.MAESTRO_RECOVERY_BACKOFF_MS);
      return Number.isFinite(n) && n >= 0 ? n : 1000;
    })();
    const ms = base * Math.pow(2, Math.max(0, attempt - 1));
    if (!ms) return Promise.resolve();
    return new Promise((res) => {
      const t = setTimeout(res, ms);
      t.unref?.();
      if (signal) {
        if (signal.aborted) { clearTimeout(t); res(); }
        else signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
      }
    });
  }

  /** Monotonic id source for recovery prompts (no Date.now/random — replay-safe). */
  _recoveryNonce() {
    return ++this._recoverySeq;
  }
```

> NOTE: confirm the replaced span. Before the edit, `_runNode` (`:1424-1451`) holds `let result; let endMark='done'; try { ... inner try/catch around runner ... } catch ... finally { this._nodeStep(...) }`. The new code keeps the SAME outer try/catch/finally and `return { node, result, ctx }`; it only swaps the inner single-call for the `for` loop and adds the four methods after `_runNode` closes.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/orchestrator-recovery.test.mjs`
Expected: PASS — 4 tests (interactive retry -> done, abort -> error, auto bounded -> error with 4 calls, shared gate -> 1 ask).

- [ ] **Step 8: Run the pause/resume suites to confirm no regression**

Run: `node --test test/orchestrator-pause.test.mjs test/orchestrator-resume.test.mjs`
Expected: PASS — unchanged. (`_runOnce` preserves the dead-session fallback; pause/abort still win.)

- [ ] **Step 9: Commit**

```bash
git add src/core/orchestrator.mjs test/orchestrator-recovery.test.mjs
git commit -m "feat: recover from recoverable node errors via retry gate"
```

---

### Task 3: UI recovery panel

**Files:**
- Modify: `ui/public/app.js` — `renderQpanel` (`:2586-2624`), add `renderRecoveryBody`, click delegation (`:4957-4964`).

**Interfaces:**
- Consumes: the `question` event `{ id, kind:'recovery', recovery: { cls, message } }` emitted by `_recover` (Task 2); existing `postAnswer(r, payload)`, `questionIcon()`, `PHASE_LABEL`.
- Produces: a recovery branch in `renderQpanel`; `postAnswer(r, { decision: 'retry'|'abort' })` on button click.

> No jsdom test harness exists for `app.js` (see `test/composer-ui.test.mjs` header). Like `renderGateBody`, this DOM-building code is verified by smoke + manual check, not a unit test.

- [ ] **Step 1: Add the recovery branch in `renderQpanel`**

In `ui/public/app.js`, change the kind discrimination in `renderQpanel` (`:2597`) and the body dispatch (`:2620-2621`). Replace:

```js
  const isGate = pq.kind === 'gate' || Array.isArray(pq.issues);
```

with:

```js
  const isRecovery = pq.kind === 'recovery';
  const isGate = !isRecovery && (pq.kind === 'gate' || Array.isArray(pq.issues));
```

Then update the title block and body dispatch. Replace:

```js
  if (isGate) {
    title.textContent = 'Cycle gate';
  } else {
```

with:

```js
  if (isRecovery) {
    const cls = (pq.recovery && pq.recovery.cls) || 'recoverable';
    title.textContent = `${cls.replace('_', ' ')} error — action needed`;
  } else if (isGate) {
    title.textContent = 'Cycle gate';
  } else {
```

And guard the clarify-only question count so it does not render for recovery — change `if (!isGate) {` (`:2611`) to:

```js
  if (!isGate && !isRecovery) {
```

Finally, replace the body dispatch (`:2620-2621`):

```js
  if (isGate) renderGateBody(r, panel, pq);
  else renderClarifyBody(r, panel, pq);
```

with:

```js
  if (isRecovery) renderRecoveryBody(r, panel, pq);
  else if (isGate) renderGateBody(r, panel, pq);
  else renderClarifyBody(r, panel, pq);
```

- [ ] **Step 2: Add `renderRecoveryBody`**

In `ui/public/app.js`, immediately after `renderGateBody` (ends near `:2796`), add:

```js
// Recovery prompt: a node hit a recoverable error (auth / rate-limit / network /
// quota). Show the cause and let the user fix it then Retry, or Abort the run.
function renderRecoveryBody(r, panel, pq) {
  const rec = pq.recovery || {};
  const intro = document.createElement('div');
  intro.className = 'gate-intro';
  const hint = rec.cls === 'auth'
    ? 'Re-authenticate (e.g. run `claude setup-token` or `/login`), then Retry.'
    : 'Fix the problem (wait out a limit, restore connectivity, top up credit), then Retry.';
  intro.textContent = `This step could not reach the model. ${hint}`;
  panel.appendChild(intro);

  if (rec.message) {
    const msg = document.createElement('div');
    msg.className = 'issue-detail';
    msg.textContent = rec.message;
    panel.appendChild(msg);
  }

  const foot = document.createElement('div');
  foot.className = 'qpanel-foot gate-actions';
  const abort = document.createElement('button');
  abort.type = 'button';
  abort.className = 'btn recovery-abort';
  abort.textContent = 'Abort run';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn btn-primary recovery-retry';
  retry.textContent = 'Retry';
  foot.append(abort, retry);
  panel.appendChild(foot);
}
```

- [ ] **Step 3: Wire the buttons in the click delegation**

In `ui/public/app.js`, extend the qpanel button selector (`:4957`) and handlers (`:4963-4964`). Replace:

```js
    const qbtn = e.target.closest && e.target.closest('.qpanel .btn-go, .qpanel .gate-continue, .qpanel .gate-another');
```

with:

```js
    const qbtn = e.target.closest && e.target.closest('.qpanel .btn-go, .qpanel .gate-continue, .qpanel .gate-another, .qpanel .recovery-retry, .qpanel .recovery-abort');
```

And add, alongside the existing `gate-continue` / `gate-another` branches (`:4963`):

```js
      else if (qbtn.classList.contains('recovery-retry')) postAnswer(r, { decision: 'retry' });
      else if (qbtn.classList.contains('recovery-abort')) postAnswer(r, { decision: 'abort' });
```

- [ ] **Step 4: Smoke-verify the panel renders and answers**

Run: `MAESTRO_MOCK=1 npm run smoke`
Expected: smoke passes. Then manual check (optional but recommended): start the UI, trigger a run with `MAESTRO_CLAUDE_BIN` pointed at a stub that exits non-zero with "401 Invalid authentication credentials"; confirm the recovery panel shows the message + Retry/Abort and that Retry re-runs the step.

- [ ] **Step 5: Commit**

```bash
git add ui/public/app.js
git commit -m "feat: recovery prompt panel in the run UI"
```

---

### Task 4: CLI recovery prompt

**Files:**
- Modify: `src/cli/maestro.mjs` — `question` handler (`:338-347`), add `askRecovery` near `askGate` (`:285-306`).

**Interfaces:**
- Consumes: the `question` event `{ id, kind:'recovery', recovery: { cls, message } }`; existing `question(rl, q)` prompt helper (`:240`), `out`, `c`, `orch.answer`.
- Produces: `askRecovery(rl, recovery): Promise<{ decision: 'retry'|'abort' }>`.

> The interactive readline prompts (`askClarify`, `askGate`) have no unit tests; `askRecovery` follows the same convention and is covered by the orchestrator auto-mode test (no human) plus manual CLI check.

- [ ] **Step 1: Add `askRecovery`**

In `src/cli/maestro.mjs`, immediately after `askGate` (ends `:306`), add:

```js
/**
 * Ask the user how to handle a recoverable error (auth / rate-limit / network /
 * quota). Shows the cause and waits for retry / abort. Returns { decision }.
 */
async function askRecovery(rl, recovery) {
  const rec = recovery || {};
  out('');
  out(c('yellow', c('bold', `Recoverable ${String(rec.cls || 'error').replace('_', ' ')} error — the pipeline could not reach the model.`)));
  if (rec.message) out(c('gray', `  ${rec.message}`));
  if (rec.cls === 'auth') out(c('gray', '  Fix: re-authenticate (claude setup-token or /login) in another terminal, then retry.'));
  else out(c('gray', '  Fix: wait out the limit / restore connectivity / top up credit, then retry.'));
  out('  1) Retry');
  out('  2) Abort the run');
  let decision = '';
  while (!decision) {
    const raw = (await question(rl, '> ')).trim();
    if (raw === '1' || /^retry/i.test(raw)) decision = 'retry';
    else if (raw === '2' || /^abort/i.test(raw)) decision = 'abort';
  }
  return { decision };
}
```

- [ ] **Step 2: Route the recovery kind in the question handler**

In `src/cli/maestro.mjs`, extend the `question` handler destructure and branch (`:338-347`). Replace:

```js
  orch.on('question', async ({ id, kind, questions, issues }) => {
```

with:

```js
  orch.on('question', async ({ id, kind, questions, issues, recovery }) => {
```

and add, after the `gate` branch (`:345-347`):

```js
      } else if (kind === 'recovery') {
        const payload = await askRecovery(rl, recovery);
        orch.answer(id, payload);
```

- [ ] **Step 3: Verify the CLI still parses/loads**

Run: `node --test test/cli-subcommands.test.mjs`
Expected: PASS — unchanged (no new subcommand; handler is additive).

- [ ] **Step 4: Commit**

```bash
git add src/cli/maestro.mjs
git commit -m "feat: recovery prompt in the CLI run loop"
```

---

### Task 5: Full-suite regression + docs note

**Files:**
- Modify: none required beyond a doc cross-link if the repo has a feature index (skip if none).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — all suites green, including the two new files.

- [ ] **Step 2: Smoke the end-to-end mock pipeline**

Run: `MAESTRO_MOCK=1 npm run smoke`
Expected: PASS — pipeline completes; no recovery path triggered in mock (sanity that the wrap is transparent on the happy path).

- [ ] **Step 3: Commit (if anything changed)**

```bash
git add -A
git commit -m "test: full-suite regression for recoverable-error retry gate"
```

---

## Self-Review

**Spec coverage:**
- Classifier (4 classes) → Task 1. ✔
- `_runNode` wrap, abort/pause win, non-recoverable unchanged → Task 2 Step 6. ✔
- Shared per-class gate, interactive prompt via `_ask` → Task 2 (`_recover`) + test. ✔
- Auto bounded backoff then fail → Task 2 (`_recover` auto branch, `RECOVERY_MAX_AUTO_ATTEMPTS`, `_backoff`) + test. ✔
- UI `recovery` kind panel + buttons → Task 3. ✔
- CLI `askRecovery` → Task 4. ✔
- Tests (classifier table, orchestrator scenarios) → Tasks 1, 2. ✔
- Out-of-scope items (auto-pause/DB-resume, jitter) correctly omitted. ✔

**Placeholder scan:** none — every code step shows full code; commands have expected output.

**Type consistency:** `classifyError` returns `'auth'|'rate_limit'|'quota'|'network'|null` everywhere; `_recover` returns `'retry'|'abort'`; payload is `{ decision: 'retry'|'abort' }` in orchestrator (`ans.decision`), UI (`postAnswer`), and CLI (`askRecovery`) consistently; question event carries `recovery: { cls, message }` in producer (Task 2) and all consumers (Tasks 3, 4).
