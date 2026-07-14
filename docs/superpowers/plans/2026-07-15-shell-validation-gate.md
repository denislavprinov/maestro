# Shell Validation Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user-supplied shell command (e.g. `npm test`) runs as a deterministic verifier node between the implementer and the code reviewer; failure feeds back to the implementer as a canonical blocking review.

**Architecture:** New synthetic verifier agent `shellGate` (meta.json only, never spawns Claude) whose runner executes the commands via `sh -c` in the worktree. `resolveWorkflow` inserts the gate node + a `fb_gate` feedback edge at resolve time when the run carries validation commands. `fb_gate` and the existing review edge share one cycle budget via a new `loopGroup` field. Everything downstream (blocked verdict → rewind → implementer FIX mode → `_ask` overflow gate) is existing machinery, untouched.

**Tech Stack:** Node.js ≥22.13 ESM (`.mjs`), `node:child_process`, `node:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-15-shell-validation-gate-design.md`

## Global Constraints

- Plain Node ESM, no TypeScript, no new npm dependencies (repo ships `express` + `ws` only).
- No commands supplied → resolved plan and all behavior **byte-identical** to today.
- Tolerant readers: internal gate errors degrade to a blocking review, never crash the pipeline.
- `DEFAULT_WORKFLOW` stays code, never a DB row (ARCHITECTURE §5.8); do not modify it.
- Reviews DB `kind` is an open set (`db.mjs:300`); `shellGate-review` needs no schema change.
- Test command: `npm test` runs `rm -rf .maestro-test && MAESTRO_HOME=.maestro-test node --test test/*.mjs`. Single file: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/<file>.test.mjs`.
- Default gate timeout: 10 minutes per command (`600000` ms), env override `MAESTRO_GATE_TIMEOUT_MS`.
- Output tail kept in the failure review: last 200 lines of merged stdout+stderr.

---

### Task 1: `runShellGate` core runner

**Files:**
- Create: `src/core/shell-gate.mjs`
- Test: `test/shell-gate.test.mjs`

**Interfaces:**
- Consumes: ctx shape from `orchestrator._nodeCtx` — reads `ctx.node.commands` (string[]), `ctx.projectDir` (worktree cwd), `ctx.outputs.review` (`{mdPath, jsonPath, reviewKind}` handle from `channels.allocate`), `ctx.cycle`, `ctx.signal` (AbortSignal), `ctx.onEvent` (log emitter).
- Produces: `runShellGate(ctx) → Promise<{review: {issues, summary}, reviewMdPath: string}>` — same return shape as `runGenericVerifier` (`phases.mjs:998`), so `runners.verifier` can wrap it with `verdict()` unchanged. Also exports `DEFAULT_GATE_TIMEOUT_MS`.

- [ ] **Step 1: Write the failing test**

```js
// test/shell-gate.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShellGate } from '../src/core/shell-gate.mjs';

const tmpDirs = [];
async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-gate-'));
  tmpDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

function ctxFor(dir, commands, extra = {}) {
  return {
    projectDir: dir,
    pipelineDir: dir,
    cycle: 1,
    signal: undefined,
    onEvent: () => {},
    node: { nodeId: 's_gate', key: 'shellGate', commands },
    outputs: {
      review: {
        kind: 'review',
        mdPath: join(dir, 'shellGate-review-cycle1.md'),
        jsonPath: join(dir, 'shellGate-review-cycle1.json'),
        reviewKind: 'shellGate-review',
      },
    },
    ...extra,
  };
}

test('runShellGate: passing command yields empty-issue review', async () => {
  const dir = await makeTmpDir();
  const { review, reviewMdPath } = await runShellGate(ctxFor(dir, ['exit 0']));
  assert.equal(review.issues.length, 0);
  assert.match(review.summary, /validation passed/i);
  const json = JSON.parse(await readFile(join(dir, 'shellGate-review-cycle1.json'), 'utf8'));
  assert.deepEqual(json.issues, []);
  assert.match(await readFile(reviewMdPath, 'utf8'), /validation passed/i);
});

test('runShellGate: failing command yields one critical issue with exit code + tail', async () => {
  const dir = await makeTmpDir();
  const { review } = await runShellGate(ctxFor(dir, ['echo boom-output; exit 3']));
  assert.equal(review.issues.length, 1);
  assert.equal(review.issues[0].severity, 'critical');
  assert.match(review.issues[0].title, /Validation failed/);
  assert.match(review.issues[0].detail, /exit code 3/);
  assert.match(review.issues[0].detail, /boom-output/);
});

test('runShellGate: commands run sequentially, first failure stops the sequence', async () => {
  const dir = await makeTmpDir();
  const marker = join(dir, 'ran-second');
  const { review } = await runShellGate(
    ctxFor(dir, ['exit 1', `touch ${marker}`]),
  );
  assert.equal(review.issues.length, 1);
  await assert.rejects(readFile(marker)); // second command never ran
});

test('runShellGate: missing binary fails with critical issue, does not throw', async () => {
  const dir = await makeTmpDir();
  const { review } = await runShellGate(ctxFor(dir, ['definitely-not-a-real-binary-xyz']));
  assert.equal(review.issues.length, 1);
  assert.equal(review.issues[0].severity, 'critical');
});

test('runShellGate: timeout kills the command and fails', async () => {
  const dir = await makeTmpDir();
  const ctx = ctxFor(dir, ['sleep 30']);
  ctx.node.timeoutMs = 300; // per-node override used by tests only
  const { review } = await runShellGate(ctx);
  assert.equal(review.issues.length, 1);
  assert.match(review.issues[0].detail, /timed out after/);
});

test('runShellGate: streams output lines through onEvent', async () => {
  const dir = await makeTmpDir();
  const lines = [];
  const ctx = ctxFor(dir, ['echo hello-gate'], { onEvent: (e) => lines.push(e) });
  await runShellGate(ctx);
  assert.ok(lines.some((e) => String(e.text || '').includes('hello-gate')));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/shell-gate.test.mjs`
Expected: FAIL — `Cannot find module '../src/core/shell-gate.mjs'`

- [ ] **Step 3: Write the implementation**

```js
// src/core/shell-gate.mjs
// Deterministic shell validation gate: the runner behind the synthetic
// `shellGate` verifier node. Runs the user's validation commands via `sh -c`
// in the worktree and converts the outcome into the canonical protocol review
// (empty on pass; one critical issue on fail), so the existing feedback-edge
// machinery (blocked verdict -> rewind -> implementer FIX mode) needs no changes.
// Never spawns Claude. Never throws on command failure — only on abort.

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

/** Per-command wall-clock cap. Env override for operators; node.timeoutMs for tests. */
export const DEFAULT_GATE_TIMEOUT_MS = 600_000;

const TAIL_LINES = 200;

function gateTimeoutMs(node) {
  const own = Number(node?.timeoutMs);
  if (Number.isFinite(own) && own > 0) return own;
  const env = Number(process.env.MAESTRO_GATE_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_GATE_TIMEOUT_MS;
}

/**
 * Run one command via `sh -c`, streaming merged output through onLine.
 * Resolves { code, tail, timedOut } — never rejects except on signal abort.
 */
function runCommand(cmd, { cwd, timeoutMs, signal, onLine }) {
  return new Promise((resolvePromise, rejectPromise) => {
    // detached => own process group, so the timeout kill reaps grandchildren too.
    const child = spawn(cmd, { shell: true, cwd, detached: true });
    const tail = [];
    let timedOut = false;

    const push = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line) continue;
        tail.push(line);
        if (tail.length > TAIL_LINES) tail.shift();
        onLine(line);
      }
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);

    const killTree = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
    const onAbort = () => { killTree(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      // spawn-level failure (e.g. no /bin/sh): degrade to a non-zero result.
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      push(String(err.message || err));
      resolvePromise({ code: 127, tail, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        rejectPromise(Object.assign(new Error('shell gate aborted'), { name: 'AbortError' }));
        return;
      }
      resolvePromise({ code: code ?? 1, tail, timedOut });
    });
  });
}

/**
 * Gate runner. Same return contract as runGenericVerifier (phases.mjs): writes
 * the review md + json to ctx.outputs.review paths and returns
 * { review, reviewMdPath } for runners.verifier's verdict wrap.
 * @param {object} ctx node ctx from orchestrator._nodeCtx (+ _bindNodeIo outputs)
 */
export async function runShellGate(ctx) {
  const commands = (ctx.node?.commands || []).map(String).map((s) => s.trim()).filter(Boolean);
  const cycle = Number(ctx.cycle) > 0 ? Number(ctx.cycle) : 1;
  const out = ctx.outputs?.review || {};
  const reviewMdPath = out.mdPath || `${String(ctx.pipelineDir || '.').replace(/\/+$/, '')}/shellGate-review-cycle${cycle}.md`;
  const reviewJsonPath = out.jsonPath || `${String(ctx.pipelineDir || '.').replace(/\/+$/, '')}/shellGate-review-cycle${cycle}.json`;
  const timeoutMs = gateTimeoutMs(ctx.node);
  // _onAgentEvent (orchestrator.mjs:2061) surfaces `e.text` as a pipeline 'log'
  // line; no other fields are needed for plain output.
  const onLine = (line) => { try { ctx.onEvent?.({ text: line }); } catch { /* log-only */ } };

  let review;
  for (const cmd of commands) {
    onLine(`$ ${cmd}`);
    const { code, tail, timedOut } = await runCommand(cmd, {
      cwd: ctx.projectDir, timeoutMs, signal: ctx.signal, onLine,
    });
    if (code !== 0) {
      const why = timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `exit code ${code}`;
      review = {
        issues: [{
          severity: 'critical',
          title: `Validation failed: ${cmd}`,
          detail: `Command \`${cmd}\` failed (${why}).\n\nLast output:\n${tail.join('\n')}`,
          location: '',
        }],
        summary: `Validation failed: \`${cmd}\` (${why}).`,
      };
      break;
    }
  }
  review ||= { issues: [], summary: `Validation passed: ${commands.map((c) => `\`${c}\``).join(', ')}.` };

  const md = [
    `# Validation gate (cycle ${cycle})`,
    '',
    review.summary,
    '',
    ...review.issues.map((i) => `## ${i.title}\n\n${i.detail}`),
    '',
  ].join('\n');
  await writeFile(reviewMdPath, md, 'utf8');
  await writeFile(reviewJsonPath, JSON.stringify(review, null, 2), 'utf8');
  return { review, reviewMdPath };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/shell-gate.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/shell-gate.mjs test/shell-gate.test.mjs
git commit -m "feat(gate): runShellGate deterministic shell validation runner"
```

---

### Task 2: `shellGate` agent registration + runner branch

**Files:**
- Create: `agents/shellGate.meta.json`
- Modify: `src/core/runners.mjs` (verifier switch, imports)
- Test: `test/shell-gate-runner.test.mjs`

**Interfaces:**
- Consumes: `runShellGate` from Task 1; `verdict()` helper already in `runners.mjs:38`.
- Produces: registry key `shellGate` (runnerType `verifier`, loopSource true, consumes `['code']`, produces `['review']`); `runners.verifier` handles `ctx.node.key === 'shellGate'` and returns `{status, issues, review, summary, reviewMdPath}`.

- [ ] **Step 1: Write the failing test**

```js
// test/shell-gate-runner.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runners } from '../src/core/runners.mjs';
import { loadAgentRegistry } from '../src/core/agent-registry.mjs';

const tmpDirs = [];
async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-gate-runner-'));
  tmpDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

function gateCtx(dir, commands) {
  return {
    projectDir: dir,
    pipelineDir: dir,
    cycle: 1,
    signal: undefined,
    onEvent: () => {},
    node: { nodeId: 's_gate', key: 'shellGate', runnerType: 'verifier', commands },
    outputs: {
      review: {
        kind: 'review',
        mdPath: join(dir, 'shellGate-review-cycle1.md'),
        jsonPath: join(dir, 'shellGate-review-cycle1.json'),
        reviewKind: 'shellGate-review',
      },
    },
  };
}

test('registry: shellGate meta loads as a verifier', () => {
  const reg = loadAgentRegistry();
  const meta = reg.shellGate;
  assert.ok(meta, 'shellGate present in registry');
  assert.equal(meta.runnerType, 'verifier');
  assert.equal(meta.loopSource, true);
  assert.deepEqual(meta.produces, ['review']);
  assert.deepEqual(meta.consumes, ['code']);
});

test('runners.verifier: shellGate pass -> status ok', async () => {
  const dir = await makeTmpDir();
  const res = await runners.verifier(gateCtx(dir, ['exit 0']));
  assert.equal(res.status, 'ok');
  assert.equal(res.review.issues.length, 0);
});

test('runners.verifier: shellGate fail -> blocked verdict with reviewMdPath', async () => {
  const dir = await makeTmpDir();
  const res = await runners.verifier(gateCtx(dir, ['exit 1']));
  assert.equal(res.status, 'blocked');
  assert.equal(res.issues.length, 1);
  assert.equal(res.issues[0].severity, 'critical');
  assert.equal(res.reviewMdPath, join(dir, 'shellGate-review-cycle1.md'));
  await readFile(res.reviewMdPath, 'utf8'); // md written
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/shell-gate-runner.test.mjs`
Expected: FAIL — `shellGate present in registry` assertion fails; verifier falls to the generic branch and tries to spawn claude.

- [ ] **Step 3: Add the meta sidecar**

```json
{
  "key": "shellGate",
  "domain": "coding",
  "displayName": "Validation Gate",
  "description": "Runs the configured shell validation commands; failure blocks like a critical review.",
  "color": "amber",
  "icon": "shield-check",
  "runnerType": "verifier",
  "loopSource": true,
  "fanOut": false,
  "consumes": ["code"],
  "produces": ["review"],
  "connectsTo": ["implementer", "reviewer"],
  "order": 9
}
```

Save as `agents/shellGate.meta.json`. Note: **no `agentFile`** — the node never spawns Claude; `loadAgentFile(null)` in `workflows.mjs:49` tolerates this (empty prompt).

- [ ] **Step 4: Add the verifier branch**

In `src/core/runners.mjs`, add the import:

```js
import { runShellGate } from './shell-gate.mjs';
```

and a new case in `verifier()` before `default:` (after the `manualWebUiTesting` case):

```js
    case 'shellGate': {
      // Deterministic shell gate: no Claude spawn. Same verdict wrap + md-path
      // threading (CONV-5) as every other verifier, so a loop rewind puts the
      // implementer in fix mode consuming the gate's review.
      const { review, reviewMdPath } = await runShellGate(ctx);
      return { ...verdict(review), reviewMdPath };
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/shell-gate-runner.test.mjs`
Expected: PASS (3 tests)

Also run the neighbors to catch registry regressions:
`MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/agent-registry.test.mjs test/runners.test.mjs test/agents-meta.test.mjs`
Expected: PASS. If `agents-meta.test.mjs` enumerates agent files and asserts each meta has an `agentFile`/`.md`, extend its expectations to allow the promptless `shellGate` (adjust the test's fixture list, not the registry code).

- [ ] **Step 6: Commit**

```bash
git add agents/shellGate.meta.json src/core/runners.mjs test/shell-gate-runner.test.mjs
git commit -m "feat(gate): register shellGate verifier agent + runner branch"
```

---

### Task 3: resolve-time gate insertion + `loopGroup`

**Files:**
- Modify: `src/core/workflows.mjs` (`resolveWorkflow`, signature + insertion helper)
- Test: `test/workflows-gate-insert.test.mjs`

**Interfaces:**
- Consumes: registry key `shellGate` (Task 2).
- Produces: `resolveWorkflow(projectDir, workflowId, registry, agentsDir, opts)` accepts `opts.validateCommands: string[]`. When non-empty AND an anchor exists, the returned plan contains a gate node `{nodeId:'s_gate', key:'shellGate', runnerType:'verifier', commands, ...}` in its own step directly before the anchor verifier's step, plus feedback `{id:'fb_gate', from:'s_gate', to:<anchor.to>, maxCycles:<anchor.maxCycles>, gate:'hasBlocking', loopGroup:'impl'}`; the anchor feedback gains `loopGroup:'impl'`. No anchor → `plan.gateSkipped === true`. Anchor definition: the first feedback edge whose `from` node has `runnerType === 'verifier'` and `from !== to`.

- [ ] **Step 1: Write the failing test**

```js
// test/workflows-gate-insert.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkflow } from '../src/core/workflows.mjs';
import { loadAgentRegistry } from '../src/core/agent-registry.mjs';
import { validateWorkflow } from '../src/core/workflow-validator.mjs';

const registry = loadAgentRegistry();

test('no commands: resolved default plan has no gate node (byte-identical topology)', async () => {
  const plan = await resolveWorkflow(process.cwd(), 'wf_default', registry);
  assert.ok(!plan.steps.flat().some((n) => n.key === 'shellGate'));
  assert.ok(!plan.feedbacks.some((fb) => fb.id === 'fb_gate'));
  assert.notEqual(plan.gateSkipped, true);
});

test('with commands: gate node inserted before reviewer, fb_gate targets implementer', async () => {
  const plan = await resolveWorkflow(process.cwd(), 'wf_default', registry, undefined, {
    validateCommands: ['npm test'],
  });
  const flatKeys = plan.steps.map((g) => g.map((n) => n.key));
  const gateStep = flatKeys.findIndex((g) => g.includes('shellGate'));
  const reviewStep = flatKeys.findIndex((g) => g.includes('reviewer'));
  const implStep = flatKeys.findIndex((g) => g.includes('implementer'));
  assert.ok(gateStep > implStep, 'gate after implementer');
  assert.equal(gateStep, reviewStep - 1, 'gate directly before reviewer');

  const gateNode = plan.steps.flat().find((n) => n.key === 'shellGate');
  assert.equal(gateNode.nodeId, 's_gate');
  assert.equal(gateNode.runnerType, 'verifier');
  assert.deepEqual(gateNode.commands, ['npm test']);

  const fbGate = plan.feedbacks.find((fb) => fb.id === 'fb_gate');
  const fbReview = plan.feedbacks.find((fb) => fb.id === 'fb_review');
  assert.equal(fbGate.from, 's_gate');
  assert.equal(fbGate.to, fbReview.to);           // both rewind to the implementer
  assert.equal(fbGate.maxCycles, fbReview.maxCycles);
  assert.equal(fbGate.loopGroup, 'impl');
  assert.equal(fbReview.loopGroup, 'impl');       // shared budget
});

test('inserted topology passes the workflow validator', async () => {
  const plan = await resolveWorkflow(process.cwd(), 'wf_default', registry, undefined, {
    validateCommands: ['npm test'],
  });
  const tpl = {
    steps: plan.steps.map((g) => g.map((n) => ({ id: n.nodeId, key: n.key }))),
    feedbacks: plan.feedbacks,
  };
  const v = validateWorkflow(tpl, registry);
  assert.equal(v.errors?.length || 0, 0, JSON.stringify(v.errors));
});

test('workflow without a review loop: gate skipped with marker', async () => {
  // wf_onboarding's only feedback originates at the evaluator (a verifier), so
  // build a synthetic verifier-less template via the registry-tolerant path:
  // resolveWorkflow on a stored workflow is covered by workflows.test.mjs; here
  // we assert the skip marker using a plan whose feedbacks are empty.
  const { writeWorkflow, deleteWorkflow } = await import('../src/core/workflows.mjs');
  const tpl = await writeWorkflow({
    name: 'gate-skip-fixture',
    steps: [[{ id: 'n1', key: 'planner' }], [{ id: 'n2', key: 'implementer' }]],
    feedbacks: [],
  });
  try {
    const plan = await resolveWorkflow(process.cwd(), tpl.id, registry, undefined, {
      validateCommands: ['npm test'],
    });
    assert.ok(!plan.steps.flat().some((n) => n.key === 'shellGate'));
    assert.equal(plan.gateSkipped, true);
  } finally {
    await deleteWorkflow(tpl.id);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/workflows-gate-insert.test.mjs`
Expected: FAIL — no gate node inserted.

- [ ] **Step 3: Implement the insertion**

In `src/core/workflows.mjs`:

1. Normalize the option at the top of `resolveWorkflow` (after `const isWorkspace = ...`):

```js
  const validateCommands = (Array.isArray(opts?.validateCommands) ? opts.validateCommands : [])
    .map(String).map((s) => s.trim()).filter(Boolean);
```

2. After the `feedbacks` mapping (below line ~324) and before the `return`, insert:

```js
  const plan = { id: tpl.id, name: tpl.name, steps, feedbacks };
  if (validateCommands.length) insertShellGate(plan, reg, validateCommands);
  return plan;
```

(replacing the existing `return { id: tpl.id, name: tpl.name, steps, feedbacks };`)

3. Add the helper at module level (below `resolveWorkflow`):

```js
/**
 * Insert the deterministic shell validation gate into a resolved plan (MUTATES
 * plan). Anchor: the first feedback edge whose `from` node is a verifier and
 * whose target differs (the implement→review loop shape). The gate lands in its
 * own step directly before the anchor verifier's step; `fb_gate` rewinds to the
 * anchor's target with the same maxCycles, and both edges share loopGroup 'impl'
 * so the dispatcher draws them from ONE cycle budget. No anchor → plan.gateSkipped
 * (the orchestrator audits the ignored commands; the plan is otherwise untouched).
 */
function insertShellGate(plan, reg, commands) {
  const nodeStep = new Map();
  plan.steps.forEach((group, i) => group.forEach((n) => nodeStep.set(n.nodeId, i)));
  const anchor = plan.feedbacks.find((fb) => {
    if (fb.from === fb.to) return false;
    const fromNode = plan.steps.flat().find((n) => n.nodeId === fb.from);
    return fromNode?.runnerType === 'verifier';
  });
  if (!anchor) { plan.gateSkipped = true; return; }

  const meta = reg.shellGate || {};
  const gateNode = {
    nodeId: 's_gate',
    key: 'shellGate',
    uiPhase: 'shellGate',
    runnerType: 'verifier',
    agentFile: null,
    agentPrompt: '',
    promptHints: '',
    model: undefined,
    effort: undefined,
    fanOut: false,
    tools: [],
    loopSource: true,
    consumes: meta.consumes || ['code'],
    optionalConsumes: [],
    produces: meta.produces || ['review'],
    connectsTo: meta.connectsTo || '*',
    commands,
  };
  const verifierIdx = nodeStep.get(anchor.from);
  plan.steps.splice(verifierIdx, 0, [gateNode]);
  anchor.loopGroup = 'impl';
  plan.feedbacks.push({
    id: 'fb_gate',
    from: 's_gate',
    to: anchor.to,
    maxCycles: anchor.maxCycles,
    gate: 'hasBlocking',
    loopGroup: 'impl',
  });
}
```

- [ ] **Step 4: Run tests**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/workflows-gate-insert.test.mjs test/workflows.test.mjs test/workflow-validator.test.mjs`
Expected: PASS. If the validator rejects `s_gate` (e.g. feedback-target ordering), fix the topology per its message — the back-edge rule at `workflow-validator.mjs:94-104` requires the target step to strictly precede the source, which `fb_gate` satisfies (implementer step < gate step).

- [ ] **Step 5: Commit**

```bash
git add src/core/workflows.mjs test/workflows-gate-insert.test.mjs
git commit -m "feat(gate): resolve-time shellGate insertion with shared loopGroup"
```

---

### Task 4: orchestrator wiring — opt intake, shared cycle budget, skip audit

**Files:**
- Modify: `src/core/orchestrator.mjs` (constructor ~line 143-255; the two `resolveWorkflow` call sites ~351 and ~686; `_dispatch` loop-state keying at lines 1211-1215 and 1244; gate-skip audit right after the first resolve)
- Test: `test/dispatcher-gate.test.mjs`

**Interfaces:**
- Consumes: Task 3's `opts.validateCommands` + `loopGroup` field; Task 2's runner.
- Produces: `createOrchestrator({ validateCommands: string[] })` threads commands into both `resolveWorkflow` calls; loop cycle state is keyed by `fb.loopGroup || fb.id` so `fb_gate` and `fb_review` consume one budget; a skipped gate writes an audit line.

- [ ] **Step 1: Write the failing test**

Model on `test/dispatcher.test.mjs` (it builds an orchestrator with `opts.runners` overrides and a hand-built plan, bypassing `run()` via `_dispatch`). Read that file first and mirror its setup helper. The test body:

```js
// test/dispatcher-gate.test.mjs
// Shared-budget semantics: fb_gate and fb_review with loopGroup 'impl' draw from
// ONE cycle counter. Plan: implementer -> gate -> reviewer. The stub gate blocks
// twice, then passes; the stub reviewer blocks once. maxCycles 3 means the loop
// may rewind twice in total (cycle 1 -> 2 -> 3); the third blocking verdict hits
// the _ask gate (auto mode answers 'continue').
import { test } from 'node:test';
import assert from 'node:assert/strict';
// ... setup helper copied/adapted from test/dispatcher.test.mjs ...

test('loopGroup: gate and review failures share one cycle budget', async () => {
  const calls = { impl: 0, gate: 0, review: 0 };
  const blockedResult = (key) => ({
    status: 'blocked',
    issues: [{ severity: 'critical', title: `${key} blocked` }],
    review: { issues: [{ severity: 'critical', title: `${key} blocked` }], summary: '' },
    summary: '',
    reviewMdPath: '/tmp/x.md',
  });
  const runners = {
    producer: async () => { calls.impl += 1; return { status: 'ok', summary: '' }; },
    verifier: async (ctx) => {
      if (ctx.node.key === 'shellGate') {
        calls.gate += 1;
        return calls.gate <= 2 ? blockedResult('gate') : { status: 'ok', issues: [], review: { issues: [], summary: '' }, summary: '' };
      }
      calls.review += 1;
      return calls.review === 1 ? blockedResult('review') : { status: 'ok', issues: [], review: { issues: [], summary: '' }, summary: '' };
    },
  };
  const plan = {
    id: 'wf_test', name: 'test',
    steps: [
      [{ nodeId: 's_impl', key: 'implementer', runnerType: 'producer', consumes: [], optionalConsumes: [], produces: [], connectsTo: '*' }],
      [{ nodeId: 's_gate', key: 'shellGate', runnerType: 'verifier', commands: ['true'], consumes: [], optionalConsumes: [], produces: [], connectsTo: '*' }],
      [{ nodeId: 's_rev', key: 'reviewer', runnerType: 'verifier', consumes: [], optionalConsumes: [], produces: [], connectsTo: '*' }],
    ],
    feedbacks: [
      { id: 'fb_gate', from: 's_gate', to: 's_impl', maxCycles: 3, gate: 'hasBlocking', loopGroup: 'impl' },
      { id: 'fb_review', from: 's_rev', to: 's_impl', maxCycles: 3, gate: 'hasBlocking', loopGroup: 'impl' },
    ],
  };
  const orch = makeOrch({ runners, auto: true }); // helper from dispatcher.test.mjs pattern
  await orch._dispatch(plan);
  // cycle budget 3 shared: gate fail (cycle->2), gate fail (cycle->3), gate pass,
  // review fail -> budget exhausted -> auto 'continue' (NO extra implementer run).
  assert.equal(calls.gate, 3);
  assert.equal(calls.review, 1);
  assert.equal(calls.impl, 3); // initial + 2 rewinds, none after the exhausted review
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/dispatcher-gate.test.mjs`
Expected: FAIL — with per-edge counters, `fb_review` still has budget after the gate rewinds, so `calls.impl === 4`.

- [ ] **Step 3: Implement**

In `src/core/orchestrator.mjs`:

1. Constructor (near `this.workflowId`, ~line 182):

```js
    // Deterministic shell validation gate (spec 2026-07-15): per-run commands.
    this.validateCommands = (Array.isArray(this.opts.validateCommands) ? this.opts.validateCommands : [])
      .map(String).map((s) => s.trim()).filter(Boolean);
```

2. Both `resolveWorkflow` call sites (~line 351 and ~686) gain the option:

```js
      const plan = await resolveWorkflow(this.projectDir, this.workflowId, registry, undefined, {
        isWorkspace: this.isWorkspace,
        validateCommands: this.validateCommands,
      });
```

3. Right after the first resolve, audit a skipped gate (mirrors the D4 warning style):

```js
      if (plan.gateSkipped) {
        await appendAudit(this.pipeline?.dir || this.projectDir,
          `Validation gate: no implement/review loop in workflow "${this.workflowId}"; --validate commands ignored.`);
      }
```

Note: at the ~351 call site `this.pipeline` may not exist yet — follow the surrounding code's ordering; if the audit helper needs the pipeline dir, move the audit to just after `createPipeline`, keeping `plan.gateSkipped` on the plan until then.

4. `_dispatch` loop-state keying — three spots, one change each. Lines 1215, 1244 (and the fbByFrom spread at 1145 already carries `loopGroup` through `{ ...fb }`):

```js
          // line ~1215 (gate re-entry)
          const st = (loopState[fb.loopGroup || fb.id] ||= { cycle: g.cycle || 1 });
```

```js
          // line ~1244 (loop firing)
          const st = (loopState[fb.loopGroup || fb.id] ||= { cycle: 1 });
```

Audit strings keep `fb.id` (they name the edge that fired, which stays correct).

- [ ] **Step 4: Run tests**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/dispatcher-gate.test.mjs test/dispatcher.test.mjs test/orchestrator-resume.test.mjs test/orchestrator-pause.test.mjs`
Expected: PASS — resume serializes `loopState` verbatim (`_buildResumePoint`), so group-keyed state round-trips unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/core/orchestrator.mjs test/dispatcher-gate.test.mjs
git commit -m "feat(gate): thread validateCommands + shared loopGroup cycle budget"
```

---

### Task 5: static detection (`validate-detect.mjs`)

**Files:**
- Create: `src/core/validate-detect.mjs`
- Test: `test/validate-detect.test.mjs`

**Interfaces:**
- Produces: `detectValidationCommands(projectDir) → Promise<string[]>` — ordered suggestions, empty when nothing matches. Never throws. Consumed by CLI (Task 6) and the UI detect endpoint (Task 7).

- [ ] **Step 1: Write the failing test**

```js
// test/validate-detect.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectValidationCommands } from '../src/core/validate-detect.mjs';

const tmpDirs = [];
async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-detect-'));
  tmpDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

test('npm: real test script -> npm test', async () => {
  const dir = await makeTmpDir();
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  assert.deepEqual(await detectValidationCommands(dir), ['npm test']);
});

test('npm: default placeholder script is NOT suggested', async () => {
  const dir = await makeTmpDir();
  await writeFile(join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.deepEqual(await detectValidationCommands(dir), []);
});

test('make: Makefile with test target -> make test', async () => {
  const dir = await makeTmpDir();
  await writeFile(join(dir, 'Makefile'), 'build:\n\techo hi\n\ntest:\n\techo t\n');
  assert.deepEqual(await detectValidationCommands(dir), ['make test']);
});

test('pytest: pytest.ini -> pytest', async () => {
  const dir = await makeTmpDir();
  await writeFile(join(dir, 'pytest.ini'), '[pytest]\n');
  assert.deepEqual(await detectValidationCommands(dir), ['pytest']);
});

test('cargo: Cargo.toml -> cargo test', async () => {
  const dir = await makeTmpDir();
  await writeFile(join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
  assert.deepEqual(await detectValidationCommands(dir), ['cargo test']);
});

test('multiple ecosystems: ordered npm-first', async () => {
  const dir = await makeTmpDir();
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  await writeFile(join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
  assert.deepEqual(await detectValidationCommands(dir), ['npm test', 'cargo test']);
});

test('empty / missing dir -> []', async () => {
  const dir = await makeTmpDir();
  assert.deepEqual(await detectValidationCommands(dir), []);
  assert.deepEqual(await detectValidationCommands(join(dir, 'nope')), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/validate-detect.test.mjs`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```js
// src/core/validate-detect.mjs
// Static test-command detection: probes well-known project files and suggests
// validation commands for the shell gate. Pure file inspection, no LLM, no
// process spawn. Prefill/suggestion only — the user's input stays authoritative;
// detection never auto-enables the gate. Never throws.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function readIfPresent(dir, name) {
  try { return await readFile(join(dir, name), 'utf8'); } catch { return null; }
}

/**
 * Ordered suggestions for a project's validation command(s). Empty when nothing
 * recognizable exists. Order: npm, make, pytest, cargo.
 * @param {string} projectDir
 * @returns {Promise<string[]>}
 */
export async function detectValidationCommands(projectDir) {
  const out = [];

  const pkgText = await readIfPresent(projectDir, 'package.json');
  if (pkgText) {
    try {
      const scripts = JSON.parse(pkgText)?.scripts || {};
      const t = String(scripts.test || '');
      // npm init's placeholder is a failure echo, not a test suite.
      if (t && !/no test specified/i.test(t)) out.push('npm test');
    } catch { /* malformed package.json -> no npm suggestion */ }
  }

  const makefile = (await readIfPresent(projectDir, 'Makefile')) ?? (await readIfPresent(projectDir, 'makefile'));
  if (makefile && /^test\s*:/m.test(makefile)) out.push('make test');

  const pyproject = await readIfPresent(projectDir, 'pyproject.toml');
  if ((await readIfPresent(projectDir, 'pytest.ini')) !== null ||
      (pyproject && /\[tool\.pytest/.test(pyproject))) {
    out.push('pytest');
  }

  if ((await readIfPresent(projectDir, 'Cargo.toml')) !== null) out.push('cargo test');

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/validate-detect.test.mjs`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/validate-detect.mjs test/validate-detect.test.mjs
git commit -m "feat(gate): static validation-command detection"
```

---

### Task 6: CLI `--validate` flag + detection hint

**Files:**
- Modify: `src/cli/maestro.mjs` (`parseArgs` ~line 50-90, help text ~line 160-175, `createOrchestrator` opts ~line 650, hint before run)
- Test: `test/cli-validate-flag.test.mjs`

**Interfaces:**
- Consumes: `detectValidationCommands` (Task 5); orchestrator `validateCommands` opt (Task 4).
- Produces: `maestro --prompt "x" --validate "npm test" --validate "npm run lint"` → orchestrator opts `validateCommands: ['npm test', 'npm run lint']`. Without `--validate`, a detected suggestion prints one hint line and the gate stays OFF.

- [ ] **Step 1: Read the existing pattern, write the failing test**

Read `test/cli-branch-flags.test.mjs` first and mirror how it exercises `parseArgs` / orchestrator opts (it may import internals or spawn the CLI with `--mock`). Follow that file's mechanism exactly; the assertions to encode:

```js
// test/cli-validate-flag.test.mjs  (mechanism per cli-branch-flags.test.mjs)
// 1) parseArgs: ['--validate', 'npm test', '--validate', 'npm run lint']
//    -> flags.validate deep-equals ['npm test', 'npm run lint']
// 2) '--validate=npm test' (equals form) -> ['npm test']
// 3) no --validate -> flags.validate is [] or undefined (orchestrator opts then omit/empty)
// 4) the orchestrator opts object built for a run carries
//    validateCommands: ['npm test'] when the flag was passed
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/cli-validate-flag.test.mjs`
Expected: FAIL — `--validate` unknown / dropped.

- [ ] **Step 3: Implement**

In `parseArgs` (`src/cli/maestro.mjs:53`): register `--validate` as a **repeatable** value flag. The parser maps flag→key around line 86; check how `--extras` accumulates (it yields an array). Add `'--validate': 'validate'` to the map and make its collection array-accumulating in the same style as extras. Support both `--validate value` and `--validate=value` forms (the parser already handles `=` per its header comment).

Help text (~line 172):

```
  --validate <cmd>         Shell validation command run between implement and review;
                           repeatable. Failure re-enters the implementer in fix mode.
```

Orchestrator opts (~line 650):

```js
    validateCommands: flags.validate || [],
```

Detection hint (in `main`, after `projectDir` resolution ~line 647, only when no flag given and not `--ui`/`--install`):

```js
  if (!flags.validate?.length) {
    const suggested = await detectValidationCommands(projectDir);
    if (suggested.length) {
      out(c('dim', `hint: detected ${suggested.map((s) => `"${s}"`).join(', ')} — pass --validate "<cmd>" to enable the validation gate`));
    }
  }
```

with the import at the top: `import { detectValidationCommands } from '../core/validate-detect.mjs';`

- [ ] **Step 4: Run tests**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/cli-validate-flag.test.mjs test/cli-branch-flags.test.mjs test/cli-subcommands.test.mjs`
Expected: PASS

Then smoke the whole thing end-to-end in mock mode (gate uses real shell even under mock):

Run: `MAESTRO_MOCK=1 MAESTRO_HOME=.maestro-smoke node --disable-warning=ExperimentalWarning src/cli/maestro.mjs --project examples/sandbox --prompt "demo task" --mock --yes --validate "exit 0"`
Expected: run completes; the phase sequence includes the gate between implement and review (visible in CLI phase output).

- [ ] **Step 5: Commit**

```bash
git add src/cli/maestro.mjs test/cli-validate-flag.test.mjs
git commit -m "feat(gate): CLI --validate flag + detection hint"
```

---

### Task 7: web UI — run form field, prefill endpoint, API threading

**Files:**
- Modify: `ui/server.mjs` (`/api/run` ~line 530-698; new `GET /api/validate-detect`)
- Modify: `ui/public/index.html` (new-run form), `ui/public/app.js` (POST body + prefill)
- Test: `test/server-validate.test.mjs`, `test/ui-validate-field.test.mjs`

**Interfaces:**
- Consumes: orchestrator `validateCommands` opt (Task 4); `detectValidationCommands` (Task 5).
- Produces: `POST /api/run` accepts `validateCommands: string[]` (both single-project and workspace branches); `GET /api/validate-detect?projectDir=<dir>` → `{ commands: string[] }`; the new-run form has textarea `#validateCommands` (one command per line) prefilled on project selection.

- [ ] **Step 1: Write the failing server test**

Read `test/server-event-names.test.mjs` or `test/projects-api.test.mjs` first for the established server-test bootstrap (how the express app is started against a temp `MAESTRO_HOME`, mock mode). Encode:

```js
// test/server-validate.test.mjs  (bootstrap per existing server tests)
// 1) GET /api/validate-detect?projectDir=<fixture with package.json scripts.test>
//    -> 200 { commands: ['npm test'] }
// 2) GET /api/validate-detect?projectDir=<empty fixture> -> 200 { commands: [] }
// 3) GET /api/validate-detect without projectDir -> 400
// 4) POST /api/run with body.validateCommands = ['exit 0'] and mock:true
//    -> orchestrator entry created; assert the created orchestrator's
//    validateCommands (reach it the same way existing tests reach `entry.orch`,
//    or assert via the run's resolved stepper manifest containing a shellGate node).
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/server-validate.test.mjs`
Expected: FAIL — 404 on `/api/validate-detect`.

- [ ] **Step 3: Implement the server side**

In `ui/server.mjs`, normalize once in `/api/run` (next to the `branch` normalization ~line 569):

```js
    const validateCommands = (Array.isArray(body.validateCommands) ? body.validateCommands : [])
      .map(String).map((s) => s.trim()).filter(Boolean);
```

and add `validateCommands,` to BOTH `createOrchestrator` calls (workspace ~line 626, single-project ~line 676).

New endpoint (near `/api/branches` ~line 1206):

```js
app.get('/api/validate-detect', async (req, res) => {
  const projectDir = typeof req.query.projectDir === 'string' ? req.query.projectDir.trim() : '';
  if (!projectDir) return badRequest(res, 'projectDir is required');
  res.json({ commands: await detectValidationCommands(projectDir) });
});
```

with the import: `import { detectValidationCommands } from '../src/core/validate-detect.mjs';`

- [ ] **Step 4: Write the failing UI test, then implement the form**

Read `test/ui-target-selector.test.mjs` for the established UI-test mechanism (string assertions against `index.html`/`app.js`). Encode: `index.html` contains `id="validateCommands"`; `app.js` references `validateCommands` in the `/api/run` POST body and calls `/api/validate-detect`.

`ui/public/index.html` — add to the new-run form (beside the branch selectors):

```html
<label class="field">
  <span>Validation commands <em class="hint">(optional — one per line; failure sends the implementer back to fix)</em></span>
  <textarea id="validateCommands" rows="2" placeholder="npm test"></textarea>
</label>
```

`ui/public/app.js` — three edits, following the file's existing `el.*` / fetch conventions:

1. Element ref beside the others (~line 86): `validateCommands: $('#validateCommands'),`
2. In the run-POST body builder, add:

```js
    validateCommands: (el.validateCommands?.value || '')
      .split('\n').map((s) => s.trim()).filter(Boolean),
```

3. Prefill on project selection (where the project picker already triggers `refreshBranches(projectDir)`, ~line 3458 — hook the same event):

```js
async function prefillValidate(projectDir) {
  if (!el.validateCommands || el.validateCommands.value.trim()) return; // user text wins
  try {
    const r = await fetch(`/api/validate-detect?projectDir=${encodeURIComponent(projectDir)}`);
    const { commands } = await r.json();
    if (Array.isArray(commands) && commands.length) el.validateCommands.value = commands.join('\n');
  } catch { /* prefill is best-effort */ }
}
```

- [ ] **Step 5: Run tests**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/server-validate.test.mjs test/ui-validate-field.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add ui/server.mjs ui/public/index.html ui/public/app.js test/server-validate.test.mjs test/ui-validate-field.test.mjs
git commit -m "feat(gate): UI validation-commands field, prefill endpoint, API threading"
```

---

### Task 8: end-to-end integration test + full suite + docs

**Files:**
- Create: `test/gate-e2e.test.mjs`
- Modify: `docs/ARCHITECTURE.md` (reviews-kind note §5.3, gate section), `README.md` (feature blurb + `--validate` in CLI options)

**Interfaces:**
- Consumes: everything above.
- Produces: proof the full loop works — implement → gate fail → implementer FIX mode consuming the gate review → gate pass → reviewer.

- [ ] **Step 1: Write the integration test**

Use the mock-claude path (`claude:{mock:true}`) like `test/orchestrator-resume.test.mjs` / `test/skill-mock.test.mjs` do — read one of them first for the fixture-project bootstrap. The gate's commands are real shell, so make failure state-dependent on disk:

```js
// test/gate-e2e.test.mjs  (bootstrap per orchestrator mock tests)
// Fixture: temp git project. validateCommands: ['test -f gate-ok']
// (fails until the file exists).
//
// Arrange: run a full mock pipeline with validateCommands and an opts.runners
// producer override whose implementer branch creates `gate-ok` ONLY when
// ctx.mode === 'fix' (i.e. on the second, review-consuming pass).
//
// Assert after run():
// 1) state.steps contains a shellGate step with cycle 1 (fail) and cycle 2 (pass)
// 2) the implementer step at cycle 2 ran in fix mode consuming
//    shellGate-review-cycle1.md (assert via the audit log or the review file existing)
// 3) the reviewer ran AFTER the gate passed (its step record's startedAt >= gate cycle-2)
// 4) pipeline status 'done'
```

- [ ] **Step 2: Run it**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/gate-e2e.test.mjs`
Expected: PASS. If binding fails (gate review not reaching the implementer), the bug is in publish/bind: the gate's review md must land on `bus.review` via `channels.publish` — check the gate result carries `reviewMdPath` and `outputs.review.mdPath` (Task 1/2), since `legacyFields` (`channels.mjs:240`) switches fix mode on `inputs.review?.mdPath` with `reviewKind !== 'plan-review'`.

- [ ] **Step 3: Full suite**

Run: `npm test`
Expected: PASS across the board. Triage any regression before proceeding — likely spots: agents-meta enumeration tests (new sidecar), composer palette tests (new registry key appears in the palette), workflow warning counts.

- [ ] **Step 4: Docs**

- `docs/ARCHITECTURE.md`: add a short "Validation gate" subsection under the dispatch/loop contract (§4): synthetic `shellGate` verifier, resolve-time insertion, `loopGroup` shared budget, review kind `shellGate-review` (open-set, no schema change). Update §5.3's kind comment to mention the open-set gate kind.
- `README.md`: add `--validate <cmd>` to the CLI options table and a 3-line feature paragraph under "What it is" step 4 (gate between implement and review, goose-inspired).

- [ ] **Step 5: Commit**

```bash
git add test/gate-e2e.test.mjs docs/ARCHITECTURE.md README.md
git commit -m "feat(gate): e2e loop test + architecture/readme docs"
```
