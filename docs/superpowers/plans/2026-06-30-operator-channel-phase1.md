# Operator Channel (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bidirectional operator channel to the maestro pipeline so a user can inject context mid-run (for the current or next node) and any agent can ask the user a free-text question mid-run.

**Architecture:** A single `operatorContext` bus channel (a JSON store at `<pipelineDir>/operator-context.json`) is auto-injected into every node's `## Inputs`. A new `contextIntake` agent normalizes raw operator messages + file paths into classified entries in that store. Inbound (user→pipeline) rides `pause()`/`resume()` for "apply now" and a silent append for "apply next". Outbound (agent→user) generalizes the clarify pattern: an agent emits a `*.questions.json`, the orchestrator blocks on the existing `_ask` gate with `kind:'agent-question'` (free text), folds the answer into `operatorContext`, and re-runs the node.

**Tech Stack:** Node.js ESM (`.mjs`, Node ≥22.13), `node:sqlite`, `node:test`, vanilla HTML/CSS/JS UI, `express` + `ws`.

## Global Constraints

- Node `>=22.13.0`. Plain ESM `.mjs`. Dependencies limited to `express` + `ws` (no new deps).
- Tests: `node:test` + `node:assert/strict`. Run with `MAESTRO_HOME=.maestro-test`; orchestrator integration tests set `MAESTRO_MOCK=1`.
- No `Date.now()`/`Math.random()` ban applies only to workflow scripts — orchestrator runtime may use `new Date().toISOString()` (matches existing code).
- Channel ids must match `/^[A-Za-z][A-Za-z0-9_-]{0,63}$/`. `operatorContext` is the one new channel id.
- Custom channel store filename: `operator-context.json` (plain basename, JSON kind).
- Nothing is written into the user's repo working tree — the store lives in the pipeline dir alongside `clarify.json`.
- Follow existing patterns: channels in `src/core/channels.mjs`, protocol parsing in `src/core/protocol.mjs`, agent files as `agents/<key>.meta.json` + `agents/maestro-<name>.md`.

---

## File Structure

- **Create** `src/core/operator-context.mjs` — pure helpers for the operator store: path, read/normalize, append-entry (with dedup), classify-fallback. One responsibility: the on-disk operator-context store.
- **Modify** `src/core/channels.mjs` — register `operatorContext` in `CHANNEL_IDS` and add an `allocate()` branch returning a JSON artifact handle.
- **Modify** `src/core/protocol.mjs` — add `readQuestions(path)` to parse a generic agent-emitted questions file (reusing the clarify normalizer) and `hasQuestions()`.
- **Create** `agents/contextIntake.meta.json` + `agents/maestro-context-intake.md` — the intake agent (producer) that classifies operator messages into the store.
- **Modify** `src/core/orchestrator.mjs` — seed `operatorContext` on the bus; auto-inject it into every node in `_bindNodeIo`; add `postOperatorMessage()`, `_runContextIntake()`; detect agent `*.questions.json` after a node runs and re-run after `_ask({kind:'agent-question'})`.
- **Modify** `src/core/phases.mjs` — `genericIoBlock` renders a labeled `operatorContext` input line so agents know to read+honor it.
- **Modify** `ui/server.mjs` — `POST /api/operator-message`; allow `kind:'agent-question'` answers through existing `/api/answer`.
- **Modify** `ui/public/app.js` — operator chat panel: post messages (with apply-now/next), render the operator log, render `agent-question` as free-text.
- **Create/extend** tests under `test/`.

Task order is dependency-driven: pure store (1) → channel registration (2) → protocol questions (3) → intake agent (4) → orchestrator inbound (5) → orchestrator outbound (6) → server (7) → UI (8).

---

### Task 1: operator-context store module

**Files:**
- Create: `src/core/operator-context.mjs`
- Test: `test/operator-context.test.mjs`

**Interfaces:**
- Consumes: nothing (leaf module; only `node:fs/promises`, `node:path`).
- Produces:
  - `operatorStorePath(pipelineDir): string` → `<pipelineDir>/operator-context.json`
  - `normalizeOperatorStore(data): { entries: Array<{id,kind,text,file,source,ts}> }`
  - `async readOperatorStore(pipelineDir): Promise<{entries:[...]}>`
  - `async appendOperatorEntries(pipelineDir, entries, nowIso): Promise<{entries:[...]}>` — appends, assigns ids `op-N`, dedups exact `(kind,text,file)` repeats, returns the new store.
  - `ENTRY_KINDS = ['requirement','correction','file','warning','note']`

- [ ] **Step 1: Write the failing test**

```javascript
// test/operator-context.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  operatorStorePath, normalizeOperatorStore, readOperatorStore,
  appendOperatorEntries, ENTRY_KINDS,
} from '../src/core/operator-context.mjs';

test('operatorStorePath points at operator-context.json in the pipeline dir', () => {
  assert.equal(operatorStorePath('/p/run'), '/p/run/operator-context.json');
});

test('normalizeOperatorStore coerces junk to an empty entries array', () => {
  assert.deepEqual(normalizeOperatorStore(null), { entries: [] });
  assert.deepEqual(normalizeOperatorStore({ entries: 'x' }), { entries: [] });
});

test('normalizeOperatorStore keeps valid entries and defaults kind to note', () => {
  const out = normalizeOperatorStore({ entries: [
    { id: 'op-1', kind: 'requirement', text: 'use redis', file: null, source: 'intake', ts: 't' },
    { kind: 'bogus', text: 'hello' },
  ] });
  assert.equal(out.entries.length, 2);
  assert.equal(out.entries[0].kind, 'requirement');
  assert.equal(out.entries[1].kind, 'note'); // bogus -> note
});

test('readOperatorStore returns empty store when file missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opctx-'));
  assert.deepEqual(await readOperatorStore(dir), { entries: [] });
});

test('appendOperatorEntries assigns ids, persists, and dedups exact repeats', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opctx-'));
  await appendOperatorEntries(dir, [{ kind: 'warning', text: 'flaky test', file: null, source: 'user' }], 't1');
  const store = await appendOperatorEntries(dir, [
    { kind: 'warning', text: 'flaky test', file: null, source: 'user' }, // dup -> dropped
    { kind: 'file', text: 'read this', file: '/a.txt', source: 'user' },
  ], 't2');
  assert.deepEqual(store.entries.map((e) => e.id), ['op-1', 'op-2']);
  assert.equal(store.entries[1].kind, 'file');
  const onDisk = JSON.parse(await readFile(join(dir, 'operator-context.json'), 'utf8'));
  assert.equal(onDisk.entries.length, 2);
});

test('ENTRY_KINDS lists the five classifications', () => {
  assert.deepEqual(ENTRY_KINDS, ['requirement', 'correction', 'file', 'warning', 'note']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/operator-context.test.mjs`
Expected: FAIL — `Cannot find module '../src/core/operator-context.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/core/operator-context.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ENTRY_KINDS = ['requirement', 'correction', 'file', 'warning', 'note'];

export function operatorStorePath(pipelineDir) {
  return join(pipelineDir, 'operator-context.json');
}

const asStr = (v) => (v == null ? '' : String(v));

function normalizeEntry(raw, i) {
  if (!raw || typeof raw !== 'object') return null;
  const text = asStr(raw.text).trim();
  const file = raw.file ? asStr(raw.file).trim() : null;
  if (!text && !file) return null;
  const kind = ENTRY_KINDS.includes(raw.kind) ? raw.kind : 'note';
  const source = raw.source === 'user' ? 'user' : 'intake';
  return {
    id: asStr(raw.id).trim() || `op-${i + 1}`,
    kind, text, file, source,
    ts: asStr(raw.ts).trim() || '',
  };
}

export function normalizeOperatorStore(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.entries)) return { entries: [] };
  const entries = [];
  for (let i = 0; i < data.entries.length; i++) {
    const e = normalizeEntry(data.entries[i], i);
    if (e) entries.push(e);
  }
  return { entries };
}

export async function readOperatorStore(pipelineDir) {
  let text;
  try {
    text = await readFile(operatorStorePath(pipelineDir), 'utf8');
  } catch {
    return { entries: [] };
  }
  try {
    return normalizeOperatorStore(JSON.parse(text));
  } catch {
    return { entries: [] };
  }
}

const dedupKey = (e) => `${e.kind} ${e.text} ${e.file || ''}`;

export async function appendOperatorEntries(pipelineDir, newEntries, nowIso) {
  const store = await readOperatorStore(pipelineDir);
  const seen = new Set(store.entries.map(dedupKey));
  let n = store.entries.length;
  for (const raw of Array.isArray(newEntries) ? newEntries : []) {
    const e = normalizeEntry({ ...raw, id: '', ts: raw?.ts || nowIso || '' }, n);
    if (!e) continue;
    const k = dedupKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    e.id = `op-${n + 1}`;
    store.entries.push(e);
    n++;
  }
  await writeFile(operatorStorePath(pipelineDir), JSON.stringify(store, null, 2));
  return store;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/operator-context.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/operator-context.mjs test/operator-context.test.mjs
git commit -m "feat: operator-context store module"
```

---

### Task 2: register operatorContext channel

**Files:**
- Modify: `src/core/channels.mjs` (`CHANNEL_IDS` line 12; `allocate()` line 31)
- Test: `test/channels-operator.test.mjs`

**Interfaces:**
- Consumes: `operatorStorePath` semantics from Task 1 (path is `<pipelineDir>/operator-context.json`).
- Produces: `allocate('operatorContext', ctx)` → `{ kind: 'json', path: '<pipelineDir>/operator-context.json', channel: 'operatorContext' }`. `'operatorContext'` is now a member of `CHANNEL_IDS`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/channels-operator.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate, CHANNEL_IDS } from '../src/core/channels.mjs';

test('operatorContext is a known channel id', () => {
  assert.ok(CHANNEL_IDS.includes('operatorContext'));
});

test('allocate(operatorContext) points at operator-context.json', () => {
  const out = allocate('operatorContext', {
    projectDir: '/p', pipelineDir: '/p/.maestro/run', baseName: 'demo', datePrefix: '01-01-26', cycle: 1, key: 'planner',
  });
  assert.equal(out.kind, 'json');
  assert.equal(out.path, '/p/.maestro/run/operator-context.json');
  assert.equal(out.channel, 'operatorContext');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/channels-operator.test.mjs`
Expected: FAIL — `CHANNEL_IDS.includes('operatorContext')` is false / allocate returns the generic default branch (wrong kind).

- [ ] **Step 3: Add the channel id and allocate branch**

In `src/core/channels.mjs`, add `'operatorContext'` to the exported `CHANNEL_IDS` array (line 12):

```javascript
export const CHANNEL_IDS = ['userPrompt', 'plan', 'review', 'checklist', 'code', 'workspace', 'clarify', 'decomposition', 'graph', 'readiness', 'operatorContext'];
```

In `allocate(channel, ctx)`, add a branch before the custom/default branch (alongside the existing `clarify` branch, ~line 90):

```javascript
  if (channel === 'operatorContext') {
    return { kind: 'json', path: join(ctx.pipelineDir, 'operator-context.json'), channel: 'operatorContext' };
  }
```

(`join` is already imported in channels.mjs.)

- [ ] **Step 4: Run test to verify it passes**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/channels-operator.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the existing channels tests to confirm no regression**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/channels.test.mjs test/channels-custom.test.mjs`
Expected: PASS (unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/core/channels.mjs test/channels-operator.test.mjs
git commit -m "feat: register operatorContext channel"
```

---

### Task 3: generic agent-question protocol parsing

**Files:**
- Modify: `src/core/protocol.mjs` (reuse `normalizeClarify` at line 143)
- Test: `test/protocol-questions.test.mjs`

**Interfaces:**
- Consumes: existing `normalizeClarify(data)` (already exports `{questions:[{id,question,options,allowFreeText}]}`).
- Produces:
  - `async readQuestions(path): Promise<{questions:[...]}>` — reads an agent-emitted questions file, normalized exactly like clarify (free text always allowed, capped).
  - `hasQuestions(parsed): boolean` — true iff `parsed.questions.length > 0`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/protocol-questions.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readQuestions, hasQuestions } from '../src/core/protocol.mjs';

test('readQuestions returns empty when file missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'q-'));
  const out = await readQuestions(join(dir, 'planner.questions.json'));
  assert.deepEqual(out, { questions: [] });
  assert.equal(hasQuestions(out), false);
});

test('readQuestions normalizes agent-emitted questions like clarify', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'q-'));
  const p = join(dir, 'planner.questions.json');
  await writeFile(p, JSON.stringify({ questions: [
    { id: 'db', question: 'Which DB?', options: ['Postgres', 'Sqlite'] },
    { question: '', options: [] }, // blank question dropped
  ] }));
  const out = await readQuestions(p);
  assert.equal(out.questions.length, 1);
  assert.equal(out.questions[0].id, 'db');
  assert.equal(out.questions[0].allowFreeText, true);
  assert.equal(hasQuestions(out), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/protocol-questions.test.mjs`
Expected: FAIL — `readQuestions`/`hasQuestions` are not exported.

- [ ] **Step 3: Add the helpers**

In `src/core/protocol.mjs`, add (reusing the existing `normalizeClarify` and `safeParseJson`, and `readFile` which is already imported):

```javascript
export async function readQuestions(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { questions: [] };
  }
  return normalizeClarify(safeParseJson(text));
}

export function hasQuestions(parsed) {
  return !!(parsed && Array.isArray(parsed.questions) && parsed.questions.length > 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/protocol-questions.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/protocol.mjs test/protocol-questions.test.mjs
git commit -m "feat: generic agent-question protocol parsing"
```

---

### Task 4: contextIntake agent definition

**Files:**
- Create: `agents/contextIntake.meta.json`
- Create: `agents/maestro-context-intake.md`
- Test: `test/agent-registry-context-intake.test.mjs`

**Interfaces:**
- Consumes: agent-registry loader (`normalizeMeta`, `loadAgentRegistry`) from `src/core/agent-registry.mjs`.
- Produces: a registry entry keyed `contextIntake` whose `produces` includes `operatorContext`, declared via `channelDefs` so `collectChannelDefs` knows the channel. Runner type `producer`. NOT part of `DEFAULT_WORKFLOW` steps — it is invoked ad hoc by the orchestrator (Task 5).

- [ ] **Step 1: Write the failing test**

```javascript
// test/agent-registry-context-intake.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAgentRegistry } from '../src/core/agent-registry.mjs';

test('contextIntake is registered and produces operatorContext', async () => {
  const reg = await loadAgentRegistry();
  const a = reg.contextIntake;
  assert.ok(a, 'contextIntake agent should be registered');
  assert.equal(a.runnerType, 'producer');
  assert.ok(a.produces.includes('operatorContext'));
});
```

(If `loadAgentRegistry` requires args in this codebase, match the call used in `test/agent-registry.test.mjs` — open that file and copy the exact loader invocation before writing this test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/agent-registry-context-intake.test.mjs`
Expected: FAIL — `reg.contextIntake` is undefined.

- [ ] **Step 3: Create the meta sidecar**

```json
// agents/contextIntake.meta.json
{
  "key": "contextIntake",
  "domain": "coding",
  "displayName": "Context Intake",
  "description": "normalize operator messages and files into structured context",
  "color": "amber",
  "icon": "<path d=\"M4 5h16M4 12h16M4 19h10\" stroke-linecap=\"round\" fill=\"none\"/>",
  "agentFile": "maestro-context-intake.md",
  "runnerType": "producer",
  "loopSource": false,
  "fanOut": false,
  "consumes": ["operatorContext"],
  "optionalConsumes": ["operatorContext"],
  "produces": ["operatorContext"],
  "channelDefs": [
    { "id": "operatorContext", "kind": "json", "filename": "operator-context.json" }
  ],
  "connectsTo": [],
  "order": 99
}
```

- [ ] **Step 4: Create the agent prompt body**

```markdown
<!-- agents/maestro-context-intake.md -->
---
name: maestro-context-intake
description: Context-intake agent for the orchestrator pipeline. Takes a raw operator message (and any attached file paths) supplied mid-run by the human operator and normalizes it into the structured operatorContext store the other pipeline agents read. Classifies each item as requirement / correction / file / warning / note. Never invents content; copies the operator's intent faithfully. Invoked ad hoc by the deterministic orchestrator, never directly by a human.
tools: Read, Write, Edit, Bash, Grep, Glob, Skill
model: inherit
---

You normalize a raw operator message into the `operatorContext` store.

## What you get

- The raw operator message text is appended to your prompt under `## Operator message`.
- Zero or more attached file paths are listed under `## Attached files`.
- The existing store is at the `operatorContext` input path (read it; you APPEND, never discard prior entries).

## What to do

1. Read the existing `operator-context.json` at the `operatorContext` input path. Keep every existing entry verbatim.
2. Turn the new operator message into one or more entries. Classify each:
   - `requirement` — a new thing the work must now satisfy.
   - `correction` — a fix to something already done or assumed.
   - `file` — "read/use this file"; put the path in `file`.
   - `warning` — something observed (e.g. a log problem) the agents should watch for.
   - `note` — anything that does not fit the above.
3. For each attached file path, add a `file` entry whose `text` summarizes why it matters (one short sentence) and whose `file` is the path.
4. Write the merged store back to the same path. Shape:

\`\`\`json
{
  "entries": [
    { "id": "op-1", "kind": "requirement", "text": "Sessions must use Redis, not Postgres.", "file": null, "source": "intake", "ts": "" }
  ]
}
\`\`\`

Do not set `id` for new entries — leave it empty or omit it; the orchestrator assigns stable ids. Set `source` to `intake`. Keep `text` faithful to the operator — do not embellish or invent requirements they did not state.
```

- [ ] **Step 5: Run test to verify it passes**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/agent-registry-context-intake.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run registry + channel-def tests for no regression**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/agent-registry.test.mjs test/agent-registry-schema-v2.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add agents/contextIntake.meta.json agents/maestro-context-intake.md test/agent-registry-context-intake.test.mjs
git commit -m "feat: contextIntake agent definition"
```

---

### Task 5: orchestrator inbound — seed channel, auto-inject, postOperatorMessage

**Files:**
- Modify: `src/core/orchestrator.mjs` (`_dispatch` bus literal ~line 1159; `_bindNodeIo` line 1668; add `postOperatorMessage`, `_runContextIntake`)
- Modify: `src/core/phases.mjs` (`genericIoBlock` line 922)
- Test: `test/operator-inbound.test.mjs`

**Interfaces:**
- Consumes: `appendOperatorEntries`, `readOperatorStore`, `operatorStorePath` (Task 1); `allocate` (Task 2); `pause()`/`resume()`/`_runNode`/runner plumbing (existing).
- Produces:
  - bus seed: `bus.operatorContext = { kind: 'json', path: operatorStorePath(pipelineDir), channel: 'operatorContext' }` in `_dispatch`.
  - `_bindNodeIo` always sets `inputs.operatorContext = snapshot.operatorContext` when present (even if the node does not declare it).
  - `genericIoBlock` renders `operatorContext` as a labeled line.
  - `async postOperatorMessage({ text, file, timing }): Promise<{status,store}>` — `timing ∈ 'now'|'next'`. Appends a raw `user` entry immediately (fallback-safe), runs `_runContextIntake` to classify, and for `timing==='now'` triggers `pause()` then `resume()` so the in-flight node re-runs with the context; for `timing==='next'` returns without disrupting the run. If the node already finished before the pause lands, downgrade to `'next'` (no error).

- [ ] **Step 1: Write the failing test (auto-inject + genericIoBlock)**

```javascript
// test/operator-inbound.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { genericIoBlock } from '../src/core/phases.mjs';

test('genericIoBlock renders operatorContext as a labeled, read-and-honor input', () => {
  const md = genericIoBlock(
    { plan: { path: '/p/plan.md' }, operatorContext: { kind: 'json', path: '/p/operator-context.json' } },
    {},
  );
  assert.match(md, /operatorContext/);
  assert.match(md, /operator-context\.json/);
  assert.match(md, /honor/i); // labeled so the agent knows to read + honor it
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/operator-inbound.test.mjs`
Expected: FAIL — `genericIoBlock` lists `operatorContext: <path>` but not the "honor" label.

- [ ] **Step 3: Label operatorContext in genericIoBlock**

In `src/core/phases.mjs` `genericIoBlock` (line 922), where it renders one `- <channel>: <path>` line per input, special-case `operatorContext` so its line reads:

```javascript
    if (ch === 'operatorContext') {
      lines.push(`- operatorContext (operator notes — read this file and honor any requirements/corrections/files/warnings it lists): ${val.path}`);
      continue;
    }
```

(Insert inside the existing inputs loop, before the generic `- ${ch}: ${path}` push. Match the loop variable names used in the current function.)

- [ ] **Step 4: Run test to verify it passes**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/operator-inbound.test.mjs`
Expected: PASS.

- [ ] **Step 5: Seed the bus + auto-inject (no new test yet — covered by Step 7 integration)**

In `src/core/orchestrator.mjs` `_dispatch`, in the `const bus = { ... }` literal (~line 1159), add:

```javascript
    operatorContext: { kind: 'json', path: join(this.pipeline.dir, 'operator-context.json'), channel: 'operatorContext' },
```

In `_bindNodeIo` (line 1668), after `const inputs = bindInputs(consumes, optional, snapshot);`, add:

```javascript
    // Operator channel is available to EVERY node regardless of declared consumes.
    if (snapshot && snapshot.operatorContext && !inputs.operatorContext) {
      inputs.operatorContext = snapshot.operatorContext;
    }
```

- [ ] **Step 6: Add postOperatorMessage + _runContextIntake**

Add these methods to the orchestrator class. Import at top of `orchestrator.mjs`:

```javascript
import { appendOperatorEntries } from './operator-context.mjs';
```

Methods:

```javascript
  /**
   * Inbound operator message. Appends a raw entry immediately (never lost), then
   * runs the contextIntake agent to classify. timing 'now' pauses+resumes so the
   * in-flight node re-runs with the new context; 'next' leaves the run untouched.
   * @param {{text?:string, file?:string, timing?:'now'|'next'}} msg
   */
  async postOperatorMessage({ text = '', file = null, timing = 'next' } = {}) {
    const dir = this.pipeline?.dir;
    if (!dir) return { status: 'no-run' };
    const nowIso = new Date().toISOString();
    // Raw, fallback-safe append so the note is never lost even if intake fails.
    await appendOperatorEntries(dir, [{ kind: file ? 'file' : 'note', text, file, source: 'user' }], nowIso);
    this._emit('operator', { direction: 'inbound', text, file, timing });
    try {
      await this._runContextIntake({ text, file });
    } catch (err) {
      this._log('orchestrator', 'warn', `contextIntake failed; kept raw note: ${err?.message || err}`);
    }
    const canApplyNow = timing === 'now' && this.state.status === 'running';
    if (canApplyNow) {
      this.pause();
      // resume() re-enters at the paused node; its _bindNodeIo now sees operatorContext.
      await this.resume();
      return { status: 'applied-now' };
    }
    return { status: 'queued-next' };
  }

  /**
   * Run the contextIntake agent once, ad hoc, to fold {text,file} into the store.
   * Uses the generic producer runner with the contextIntake registry entry. The
   * operator message + attached file are passed as extra prompt context.
   */
  async _runContextIntake({ text, file }) {
    const node = this._resolveAdHocNode('contextIntake'); // see Step 6a
    const io = this._bindNodeIo(node, 1, this._currentBusSnapshot());
    const ctx = {
      ...io,
      projectDir: this.projectDir,
      pipelineDir: this.pipeline.dir,
      operatorMessage: text,
      operatorFile: file,
    };
    await this._runners.producer(ctx); // existing producer runner
  }
```

- [ ] **Step 6a: Helper plumbing**

`_resolveAdHocNode(key)` and `_currentBusSnapshot()` are thin wrappers — implement them using the registry + bus the orchestrator already holds. Read the existing `_dispatch` to see how a node is shaped by `resolveWorkflow` and how the live bus snapshot is taken (the dispatch loop already snapshots the bus before each node). Mirror that:

```javascript
  _resolveAdHocNode(key) {
    const meta = this.registry?.[key];
    if (!meta) throw new Error(`ad-hoc node ${key} not in registry`);
    return {
      nodeId: `adhoc_${key}`, key,
      consumes: meta.consumes || [], optionalConsumes: meta.optionalConsumes || [],
      produces: meta.produces || [], runnerType: meta.runnerType || 'producer',
      fanOut: false, tools: meta.tools, model: meta.model,
    };
  }

  _currentBusSnapshot() {
    return JSON.parse(JSON.stringify(this._bus || {}));
  }
```

Confirm the live bus is reachable as `this._bus` (or whatever `_dispatch` stores it as — read `_dispatch` and bind to the real field; if the bus is a local in `_dispatch`, hoist it to `this._bus = bus` at the top of the dispatch loop so `postOperatorMessage` can read it). The contextIntake agent body reads/writes `operator-context.json` directly via its `operatorContext` input/output path, so even a stale snapshot only affects the prompt's rendered path, not correctness.

The producer runner appends the agent body + `genericIoBlock`. Pass the operator message into the prompt: extend the producer ctx so the runner includes an `## Operator message` / `## Attached files` block when `ctx.operatorMessage` is set. Add to `runGenericProducer` in `phases.mjs` (line ~974), right after `genericIoBlock(...)`:

```javascript
    + (ctx.operatorMessage || ctx.operatorFile
        ? `\n## Operator message\n\n${ctx.operatorMessage || '(none)'}\n\n## Attached files\n\n${ctx.operatorFile ? `- ${ctx.operatorFile}` : '(none)'}\n`
        : '')
```

- [ ] **Step 7: Write the integration test (mock run)**

Model this on `test/clarify-node.test.mjs` and `test/cli-resume.test.mjs` (open both for the exact mock-orchestrator construction and `MAESTRO_MOCK=1` harness). The test:

```javascript
// test/operator-inbound-run.test.mjs  (integration — uses MAESTRO_MOCK)
import test from 'node:test';
import assert from 'node:assert/strict';
// ... construct an orchestrator over examples/sandbox with MAESTRO_MOCK=1 exactly as clarify-node.test.mjs does ...

test('postOperatorMessage(next) appends a classified entry to the store', async () => {
  // start a mock run, await the first node boundary, then:
  const res = await orch.postOperatorMessage({ text: 'Use Redis for sessions', timing: 'next' });
  assert.equal(res.status, 'queued-next');
  const store = JSON.parse(await readFile(join(orch.pipeline.dir, 'operator-context.json'), 'utf8'));
  assert.ok(store.entries.length >= 1);
  assert.ok(store.entries.some((e) => /redis/i.test(e.text)));
});
```

(In `MAESTRO_MOCK` mode the intake agent does not call a real model; assert against the raw `user` entry the fallback append guarantees, so the test is deterministic without a live agent.)

- [ ] **Step 8: Run the integration test**

Run: `MAESTRO_MOCK=1 MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/operator-inbound-run.test.mjs`
Expected: PASS.

- [ ] **Step 9: Full suite for regression**

Run: `npm test`
Expected: PASS (no existing test broken — `operatorContext` is additive on the bus and inputs).

- [ ] **Step 10: Commit**

```bash
git add src/core/orchestrator.mjs src/core/phases.mjs test/operator-inbound.test.mjs test/operator-inbound-run.test.mjs
git commit -m "feat: orchestrator inbound operator context (seed, inject, postOperatorMessage)"
```

---

### Task 6: orchestrator outbound — agent questions re-run loop

**Files:**
- Modify: `src/core/orchestrator.mjs` (`_runNode` per-node wrapper; reuse `_ask` line 1765, `_writeClarifyAnswers` shape)
- Test: `test/operator-outbound.test.mjs`

**Interfaces:**
- Consumes: `readQuestions`, `hasQuestions` (Task 3); `_ask` (existing); `appendOperatorEntries` (Task 1).
- Produces: after a node's runner resolves, the orchestrator checks for `<pipelineDir>/<nodeKey>.questions.json`. If `hasQuestions`, it: (1) `_emit('question', {kind:'agent-question', ...})` via `_ask`, (2) folds each `{id,question,choice}` answer into `operatorContext` as a `note` entry text `"Q: <question> A: <choice>"`, (3) deletes the questions file, (4) re-runs the same node once. A per-node re-run counter caps at `MAESTRO_MAX_AGENT_QUESTION_ROUNDS` (default 3) to prevent loops.

- [ ] **Step 1: Write the failing test**

```javascript
// test/operator-outbound.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readQuestions, hasQuestions } from '../src/core/protocol.mjs';

// Unit-level contract test for the detection helper the orchestrator uses.
test('agent questions file is detected then consumed (deleted) after answering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oq-'));
  const qp = join(dir, 'planner.questions.json');
  await writeFile(qp, JSON.stringify({ questions: [{ id: 'db', question: 'Which DB?', options: ['pg'] }] }));
  assert.equal(hasQuestions(await readQuestions(qp)), true);
  // Simulate the orchestrator consuming it:
  const { unlink } = await import('node:fs/promises');
  await unlink(qp);
  await assert.rejects(access(qp)); // gone -> re-run will not re-trigger
});
```

- [ ] **Step 2: Run test to verify it fails (red for the not-yet-wired path)**

This unit test passes immediately (it exercises Task 3 helpers). The RED signal for the orchestrator wiring is the integration test in Step 5. Run the unit test now to confirm the contract:

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/operator-outbound.test.mjs`
Expected: PASS.

- [ ] **Step 3: Wire detection + re-run into the per-node path**

Open `_dispatch` / `_runNode` in `orchestrator.mjs` and find where a node's runner result is awaited and before `_publishNodeIo` is called. Insert the agent-question check. The questions path uses the node key: `join(this.pipeline.dir, `${node.key}.questions.json`)`.

```javascript
  /** After a node runs, honor any agent-emitted questions, then signal whether to re-run. */
  async _handleAgentQuestions(node) {
    const qpath = join(this.pipeline.dir, `${node.key}.questions.json`);
    const parsed = await readQuestions(qpath);
    if (!hasQuestions(parsed)) return false;
    const rounds = (this._agentQRounds ||= new Map());
    const seen = rounds.get(node.key) || 0;
    const cap = Number(process.env.MAESTRO_MAX_AGENT_QUESTION_ROUNDS) || 3;
    if (seen >= cap) {
      this._log('orchestrator', 'warn', `agent questions cap reached for ${node.key}; ignoring`);
      await unlink(qpath).catch(() => {});
      return false;
    }
    rounds.set(node.key, seen + 1);
    const answer = await this._ask({ id: `agentq-${node.key}-${seen + 1}`, kind: 'agent-question', questions: parsed.questions });
    const answers = normalizeClarifyAnswer(answer, parsed.questions);
    const entries = answers.map((a) => ({
      kind: 'note', source: 'user', file: null,
      text: `Q: ${parsed.questions.find((q) => q.id === a.id)?.question || a.id} A: ${a.choice}`,
    }));
    await appendOperatorEntries(this.pipeline.dir, entries, new Date().toISOString());
    await unlink(qpath).catch(() => {});
    return true; // caller re-runs this node
  }
```

At the call site (after the runner resolves, before publish):

```javascript
      if (await this._handleAgentQuestions(node)) {
        continue; // re-run the same node with the answer now in operatorContext
      }
```

Adapt `continue` to the actual loop structure (it may need to decrement the step index or re-invoke `_runNode` depending on how `_dispatch` iterates — read the loop and match it; the goal is "run this same node once more"). Add imports: `import { unlink } from 'node:fs/promises';` and `import { readQuestions, hasQuestions } from './protocol.mjs';` (extend the existing protocol import).

`_ask` already emits `_emit('question', {id, kind, questions, ...})`; `kind:'agent-question'` flows through unchanged. In auto mode `_ask` auto-answers with the first option (existing behavior) — acceptable for headless runs.

- [ ] **Step 4: Write the integration test**

Model on `test/clarify-node.test.mjs`. Use a mock agent that writes a `planner.questions.json` on its first invocation and nothing on its second (the harness in MAESTRO_MOCK lets you stub the agent output — copy the stubbing approach from clarify-node.test.mjs). Assert: `_ask` fired once with `kind:'agent-question'`, the store gained a `Q:/A:` note, the questions file is gone, and the node ran twice.

```javascript
// test/operator-outbound-run.test.mjs
// ... mock orchestrator; subscribe to 'question' events; auto-answer agent-question with free text ...
test('an agent question blocks, is answered, folded into store, and the node re-runs', async () => {
  // assert the 'question' event had kind 'agent-question'
  // assert operator-context.json contains a Q:/A: note
  // assert planner.questions.json no longer exists
});
```

- [ ] **Step 5: Run the integration test**

Run: `MAESTRO_MOCK=1 MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/operator-outbound-run.test.mjs`
Expected: PASS.

- [ ] **Step 6: Full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/orchestrator.mjs test/operator-outbound.test.mjs test/operator-outbound-run.test.mjs
git commit -m "feat: orchestrator outbound agent-question re-run loop"
```

---

### Task 7: server endpoint for operator messages

**Files:**
- Modify: `ui/server.mjs` (add `POST /api/operator-message`; `EVENT_NAMES` line 140; `/api/answer` line 723 already passes payload through)
- Test: `test/api-operator-message.test.mjs`

**Interfaces:**
- Consumes: `runs` Map (line 87), `entry.orch.postOperatorMessage` (Task 5), existing `entry.orch.answer` (handles `agent-question` answers unchanged).
- Produces:
  - `POST /api/operator-message` — body `{ runId, text?, file?, timing? }` → calls `entry.orch.postOperatorMessage({text,file,timing})`, returns `{ ok:true, status }`.
  - `'operator'` added to `EVENT_NAMES` so the inbound/outbound `_emit('operator', ...)` events broadcast to the UI.

- [ ] **Step 1: Write the failing test**

Model on `test/api-agents-domain.test.mjs` / `test/config-api.test.mjs` for the express-app test harness (they import the app/handler and use a fetch or supertest-style call — copy that exact pattern). The test posts to `/api/operator-message` against a stubbed `runs` entry whose `orch.postOperatorMessage` records its args.

```javascript
// test/api-operator-message.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
// ... import the app the way config-api.test.mjs does; register a fake run with a stub orch ...
test('POST /api/operator-message forwards to orch.postOperatorMessage', async () => {
  let got = null;
  // fake entry: { orch: { postOperatorMessage: async (m) => { got = m; return { status: 'queued-next' }; } } }
  const res = await fetch(`${base}/api/operator-message`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId, text: 'note', timing: 'next' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(got, { text: 'note', file: null, timing: 'next' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/api-operator-message.test.mjs`
Expected: FAIL — 404 (route not defined).

- [ ] **Step 3: Add the endpoint and event name**

In `ui/server.mjs`, add `'operator'` to `EVENT_NAMES` (line 140):

```javascript
const EVENT_NAMES = ['phase', 'log', 'question', 'artifact', 'state', 'done', 'error', 'subagent', 'stepskills', 'title', 'operator'];
```

Add the route (next to `/api/answer`, line 723):

```javascript
app.post('/api/operator-message', async (req, res) => {
  const { runId, text = '', file = null, timing = 'next' } = req.body || {};
  if (!runId || !runs.has(runId)) return badRequest(res, 'unknown runId');
  const entry = runs.get(runId);
  try {
    const out = await entry.orch.postOperatorMessage({ text, file, timing });
    res.json({ ok: true, status: out?.status });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/api-operator-message.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/server.mjs test/api-operator-message.test.mjs
git commit -m "feat: POST /api/operator-message endpoint"
```

---

### Task 8: UI operator chat panel

**Files:**
- Modify: `ui/public/app.js` (question handling ~line 331; `renderClarifyPanel` ~line 6328; `/api/answer` poster ~line 3075)
- Modify: `ui/public/index.html` + CSS as needed for the panel container (match existing panel markup)
- Test: manual (UI), plus a small `node:test` for any extracted pure helper

**Interfaces:**
- Consumes: WS `question` events with `kind:'agent-question'`; WS `operator` events; `POST /api/operator-message`; existing `POST /api/answer`.
- Produces: a chat panel that (a) sends operator messages with an apply-now / apply-next toggle, (b) renders the operator log from `operator` events, (c) renders an inbound `agent-question` as a free-text prompt and answers it via `/api/answer` with `{answers:[{id,choice}]}`.

- [ ] **Step 1: Render `agent-question` as free-text**

In the `question` event handler (~line 331), branch on `kind`. For `kind:'agent-question'`, render each question with a free-text input (the questions carry `allowFreeText:true`; options, if any, render as quick-fill chips). Reuse the existing answer poster (`POST /api/answer`) with payload `{ runId, id, payload: { answers: [{ id, choice }] } }` — the same shape clarify already posts (line 3075).

- [ ] **Step 2: Add the operator composer**

Add a small composer (textarea + file-path input + an "Apply now / Apply next" toggle + Send). On Send:

```javascript
await fetch('/api/operator-message', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runId: currentRunId, text, file: filePath || null, timing: applyNow ? 'now' : 'next' }),
});
```

- [ ] **Step 3: Render the operator log**

On a WS `operator` event (`{ direction:'inbound'|'outbound', text, file, timing }`), append a line to the panel's message log so the user sees their injected context and any agent questions in one timeline.

- [ ] **Step 4: Manual verification**

Run: `MAESTRO_MOCK=1 npm start`, open the UI, start a mock run, and:
1. Post an operator message with "Apply next" → confirm it appears in the log and `operator-context.json` in the run dir gains an entry.
2. Post with "Apply now" mid-node → confirm the run pauses and resumes (status transitions visible).
3. Drive a mock agent that emits a `*.questions.json` → confirm the free-text prompt appears and submitting an answer resumes the node.

Expected: all three behaviors observable; no console errors.

- [ ] **Step 5: Commit**

```bash
git add ui/public/app.js ui/public/index.html
git commit -m "feat: operator chat panel (inject context + agent questions)"
```

---

## Self-Review

**Spec coverage:**
- A inbound, apply-next → Task 5 (`postOperatorMessage` timing `'next'`) + Task 7/8. ✓
- A inbound, apply-now (pause+re-run) → Task 5 (`timing 'now'` → `pause()`/`resume()`, downgrade if finished). ✓
- B clarify-style outbound (any agent) → Task 6 (detect `*.questions.json`, `_ask({kind:'agent-question'})`, fold + re-run). ✓
- contextIntake agent classifies notes+files → Task 4 + Task 5 (`_runContextIntake`). ✓
- operatorContext auto-injected into every node → Task 5 (`_bindNodeIo` unconditional inject + `genericIoBlock` label). ✓
- Chat surface (one timeline both directions) → Task 8. ✓
- Error handling: intake failure → raw fallback append (Task 5 `postOperatorMessage` try/catch + pre-append). Pause race → downgrade to next (Task 5). Question loop cap → Task 6 (`MAESTRO_MAX_AGENT_QUESTION_ROUNDS`). ✓
- Phase 2 (`ask_user` MCP) → explicitly OUT of this plan (separate plan). ✓

**Placeholder scan:** No "TBD"/"handle edge cases". Two tasks (5, 6, 7, 8 integration/UI) instruct the implementer to open a named existing test/file and match its exact harness — that is a grounding instruction, not a placeholder, because the precise mock-orchestrator construction lives in those files and must not be guessed.

**Type consistency:**
- Store entry shape `{id,kind,text,file,source,ts}` consistent across Tasks 1, 4, 5, 6.
- `readQuestions`/`hasQuestions` names consistent Tasks 3, 6.
- `postOperatorMessage({text,file,timing})` signature consistent Tasks 5, 7, 8.
- `_emit('operator', {direction,...})` consistent Tasks 5, 7, 8.
- Answer payload `{answers:[{id,choice}]}` matches existing clarify contract (Tasks 6, 8).

**Known grounding caveats for the implementer (not placeholders):**
- Confirm the live bus field name in `_dispatch` (hoist to `this._bus` if it is a local) before wiring `_currentBusSnapshot` (Task 5 Step 6a).
- Confirm `loadAgentRegistry`'s exact call signature from `test/agent-registry.test.mjs` (Task 4 Step 1).
- Match the re-run mechanism in Task 6 Step 3 to the real `_dispatch` loop shape.
