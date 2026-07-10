# Enable App Pause & Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Enable app full pause/continuation parity with maestro core pipelines — user-triggered pause on a live run, resume of paused/interrupted runs (manual pause and session-limit auto-pause), in both the live run screen and the history list.

**Architecture:** Pure reuse of existing engine primitives (`orch.pause()`, `readPipelineForResume`, `createOrchestrator({resume})`, `orch.resume()`). Core gains `resumeOnboarding()` in `src/core/onboarding.mjs` (sharing all event wiring with `runOnboarding()` via an extracted helper). The Enable server gains thin `/api/enable/pause` + `/api/enable/resume` routes; the renderer gains a pause button, a paused banner with Resume, and Resume buttons on resumable history entries.

**Tech Stack:** Node ESM (`.mjs`), express, ws, `node:test` + `node:assert/strict`, JSDOM for renderer tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-10-enable-pause-resume-design.md`

## Global Constraints

- No new npm dependencies.
- Run tests with: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/<file>` (full suite: `npm test`).
- Match existing style: 2-space indent, terse `//` comments explaining constraints only, single-quote strings.
- Project dir resolution for Enable resume MUST use `readStoreMeta(row.project_key)?.path` (store_meta), NOT `listProjects()` — Enable projects are not registered in the `projects` table (verified: bevup-studio has a store_meta dir but no `projects` row).
- The pipeline dir for readiness replay comes from `saved.resumePoint.pipelineDir` (always present — orchestrator writes it at `orchestrator.mjs:537` and in `_buildResumePoint`).
- Resume-guard status set (treat these as NOT live): `done`, `stopped`, `error`, `paused`, `interrupted` — same list as `ui/server.mjs:791`.

---

### Task 1: `hasResumePoint` on pipeline history rows

**Files:**
- Modify: `src/core/artifacts.mjs` — `rowToHistoryEntry` (~line 1279), `listPipelines` SELECT (~line 1338), `listAllPipelines` SELECT (~line 1361)
- Test: `test/artifacts-has-resume-point.test.mjs` (create)

**Interfaces:**
- Produces: every entry returned by `listPipelines()` / `listAllPipelines()` carries `hasResumePoint: boolean` (true iff the row's `resume_point` column is non-NULL). Task 4 consumes this.

- [ ] **Step 1: Write the failing test**

Create `test/artifacts-has-resume-point.test.mjs`:

```js
// hasResumePoint on history entries: true iff the pipelines row carries a
// resume_point. Backs the Enable UI's `resumable` flag.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';
import { listAllPipelines, listPipelines } from '../src/core/artifacts.mjs';

useTempHome(after);

test('listAllPipelines + listPipelines expose hasResumePoint', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'maestro-hrp-'));
  const { id: pausedId } = await seedPipeline(proj, {
    title: 'paused run', status: 'paused',
    resumePoint: { version: 1, kind: 'boundary', stepIndex: 0, stepCycle: [], loopState: {},
      bus: null, stepModels: null, workflowId: 'wf_default', plan: null, nodes: [], gate: null,
      pipelineDir: proj, pausedAt: '2026-07-10T00:00:00Z' },
  });
  const { id: doneId } = await seedPipeline(proj, { title: 'done run', status: 'done' });

  const all = await listAllPipelines();
  assert.equal(all.find((p) => p.id === pausedId).hasResumePoint, true);
  assert.equal(all.find((p) => p.id === doneId).hasResumePoint, false);

  const perProject = await listPipelines(proj);
  assert.equal(perProject.find((p) => p.id === pausedId).hasResumePoint, true);
  assert.equal(perProject.find((p) => p.id === doneId).hasResumePoint, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/artifacts-has-resume-point.test.mjs`
Expected: FAIL — `hasResumePoint` is `undefined`, not `true`.

- [ ] **Step 3: Implement**

In `src/core/artifacts.mjs`:

3a. `listAllPipelines` SELECT (~line 1361) — add the derived column:

```sql
    SELECT id, project_key, workspace_key, target, title, status, started_at, updated_at,
           total_cost_usd, total_active_ms, branch, workspace_meta,
           resume_point IS NOT NULL AS has_resume_point
    FROM pipelines
    ORDER BY started_at DESC
```

3b. `listPipelines` SELECT (~line 1338) — same addition:

```sql
    SELECT id, title, status, started_at, updated_at, total_cost_usd, total_active_ms, branch,
           resume_point IS NOT NULL AS has_resume_point
    FROM pipelines
```

3c. `rowToHistoryEntry` (~line 1279) — add one field to the `entry` object literal, after `status`:

```js
    status: row.status ?? 'unknown',
    hasResumePoint: !!row.has_resume_point,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/artifacts-has-resume-point.test.mjs`
Expected: PASS

- [ ] **Step 5: Regression check on artifacts/history consumers**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/history-api.test.mjs test/server-pause-resume.test.mjs test/enable-history-manage.test.mjs`
Expected: PASS (additive field; wire shape unchanged otherwise)

- [ ] **Step 6: Commit**

```bash
git add src/core/artifacts.mjs test/artifacts-has-resume-point.test.mjs
git commit -m "feat(artifacts): expose hasResumePoint on pipeline history entries"
```

---

### Task 2: Extract `wireOnboardingRun` from `runOnboarding` (pure refactor)

**Files:**
- Modify: `src/core/onboarding.mjs:126-197`
- Test: existing suite only (behavior-preserving refactor)

**Interfaces:**
- Produces (module-internal): `wireOnboardingRun(orch, { answers, interactive, kick, replayDir }) -> { runId, events, done, orch }`.
  - `kick: () => Promise<{status, pipelineDir}>` — starts the engine (`orch.run()` here; `orch.resume()` in Task 3).
  - `replayDir: string|null` — when set, re-emit readiness derived from files already in that pipeline dir BEFORE kicking (Task 3 uses it; `runOnboarding` passes null).
- `runOnboarding` public signature and return `{ runId, events, done, orch }` unchanged.

- [ ] **Step 1: Implement the extraction**

In `src/core/onboarding.mjs`, replace everything from `const events = new EventEmitter();` (line 145) through the end of `runOnboarding` (line 197) with a call to the new helper, and add the helper above `runOnboarding`:

```js
// Shared wiring for fresh and resumed Enable runs: event forwarding, gate
// answering, readiness derivation, and the done-promise. `kick` starts the
// engine (run() or resume()); `replayDir`, when set, re-emits readiness already
// on disk so a resumed/reconnecting UI gets its ring state back.
function wireOnboardingRun(orch, { answers = {}, interactive = false, kick, replayDir = null } = {}) {
  const events = new EventEmitter();
  const runId = randomUUID();

  // forward raw engine events verbatim (renderer/server consume these too)
  for (const name of ['state', 'phase', 'question', 'artifact', 'log', 'done', 'error']) {
    orch.on(name, (p) => events.emit(name, p));
  }

  wireGateAnswers(orch, events, { answers, interactive });

  // derive readiness from canonical files on phase-done boundaries (D5).
  // pipelineDir is set on state at orchestrator.mjs:411 (before dispatch), so
  // it is readable inside these mid-run phase listeners.
  let baselineEmitted = false;
  const cyclesEmitted = new Set();
  orch.on('phase', (ev) => {
    if (ev.status !== 'done') return;
    const dir = orch.getState().pipelineDir;
    if (!dir) return;
    if (!baselineEmitted && matchNode(ev, 's_analyze', 'onboardingAnalyzer')) {
      baselineEmitted = true;
      const b = readBaselineReadiness(dir);
      events.emit('readiness', { kind: 'baseline', score: b?.score ?? null, dimensions: b?.dimensions ?? null });
    }
    if (matchNode(ev, 's_eval', 'onboardingEvaluator')) {
      const cycle = ev.cycle || 1;
      if (!cyclesEmitted.has(cycle)) {
        cyclesEmitted.add(cycle);
        events.emit('readiness', { kind: 'cycle', cycle, score: readCycleScore(dir, cycle) });
      }
    }
  });

  // re-emit readiness a prior lifetime of this pipeline already produced, and
  // seed the dedup state so the live listeners above don't double-emit.
  const replayReadiness = (dir) => {
    const b = readBaselineReadiness(dir);
    if (b) {
      baselineEmitted = true;
      events.emit('readiness', { kind: 'baseline', score: b.score, dimensions: b.dimensions });
    }
    for (let c = 1; ; c++) {
      const s = readCycleScore(dir, c);
      if (s == null) break;
      cyclesEmitted.add(c);
      events.emit('readiness', { kind: 'cycle', cycle: c, score: s });
    }
  };

  // run, then emit final readiness + resolve summary. The setImmediate lets the
  // caller attach its events listeners (a microtask-continuation of our return)
  // before the replay frames fire — otherwise they'd be emitted into silence.
  const done = (async () => {
    await new Promise((r) => setImmediate(r));
    if (replayDir) replayReadiness(replayDir);
    const result = await kick();
    const dir = result.pipelineDir;
    const readiness = dir ? readFinalReadiness(dir) : null;
    const feature = orch.getState().branch?.feature ?? null;
    // A paused run is NOT final: emitting kind:'final' here would flip the
    // renderer to the results screen right before the paused banner shows.
    if (result.status !== 'paused') {
      events.emit('readiness', {
        kind: 'final',
        score: readiness?.score ?? null,
        baselineScore: readiness?.baselineScore ?? null,
        delta: readiness?.delta ?? null,
        dimensions: readiness?.dimensions ?? {},
        gaps: readiness?.gaps ?? [],
        branch: feature,                     // results screen renders this
      });
    }
    return { status: result.status, branch: feature, readiness };
  })();

  return { runId, events, done, orch };               // orch exposed for the server's answer route
}
```

`runOnboarding` keeps its steps 1–2 (workflow seeding + `createOrchestrator`) verbatim and ends with:

```js
  return wireOnboardingRun(orch, { answers, interactive, kick: () => orch.run() });
```

Note the behavior deltas, both intentional and safe:
- Engine start is deferred one `setImmediate` tick (event-delivery hardening; the engine's own first emissions already come after internal awaits).
- The `readiness.final` frame is SUPPRESSED when the run lands `paused` (a paused run is not final; the frame would flip the renderer to the results screen). Previously unreachable in Enable — nothing could pause — so no consumer changes behavior on done/error/stopped runs.

- [ ] **Step 2: Run the onboarding + enable suites**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/enable-server.mjs test/enable-interactive.test.mjs test/onboarding-api.mjs test/enable-history-manage.test.mjs`
Expected: PASS — pure refactor.

(If `test/onboarding-api.mjs` / `test/enable-server.mjs` aren't `--test`-runnable directly, run `npm test` for the full suite instead.)

- [ ] **Step 3: Commit**

```bash
git add src/core/onboarding.mjs
git commit -m "refactor(onboarding): extract wireOnboardingRun for run/resume sharing"
```

---

### Task 3: `resumeOnboarding()` in core

**Files:**
- Modify: `src/core/onboarding.mjs` (new export + imports)
- Test: `test/onboarding-resume.test.mjs` (create)

**Interfaces:**
- Consumes: `wireOnboardingRun` (Task 2), `readPipelineForResume` + `readStoreMeta` (`src/core/artifacts.mjs`), `createOrchestrator` (already imported).
- Produces: `export async function resumeOnboarding({ pipelineId, interactive = false, mock = false, answers = {} }) -> { runId, events, done, orch, pipelineId }`. Validation failures throw `Error` with `.code = 'NOT_FOUND'` for an unknown id, plain `Error` otherwise. Task 4's server route consumes this exact contract.

- [ ] **Step 1: Write the failing tests**

Create `test/onboarding-resume.test.mjs`:

```js
// resumeOnboarding: validation guards + full mock pause->resume e2e over wf_enable.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { useTempHome } from './helpers/temp-home.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';
import { runOnboarding, resumeOnboarding, ENABLE_TITLE } from '../src/core/onboarding.mjs';
import { readPipelineForResume } from '../src/core/artifacts.mjs';

useTempHome(after);

const RP = (dir) => ({ version: 1, kind: 'boundary', stepIndex: 0, stepCycle: [], loopState: {},
  bus: null, stepModels: null, workflowId: 'wf_enable', plan: null, nodes: [], gate: null,
  pipelineDir: dir, pausedAt: '2026-07-10T00:00:00Z' });

test('resumeOnboarding: unknown pipeline id -> NOT_FOUND', async () => {
  await assert.rejects(resumeOnboarding({ pipelineId: 'nope1234' }),
    (e) => e.code === 'NOT_FOUND' && /not found/i.test(e.message));
});

test('resumeOnboarding: refuses non-Enable pipelines', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'maestro-or-'));
  const { id } = await seedPipeline(proj, { title: 'some other run', status: 'paused', resumePoint: RP(proj) });
  await assert.rejects(resumeOnboarding({ pipelineId: id }), /not an Enable run/i);
});

test('resumeOnboarding: refuses non-resumable status', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'maestro-or-'));
  const { id } = await seedPipeline(proj, { title: ENABLE_TITLE, status: 'done' });
  await assert.rejects(resumeOnboarding({ pipelineId: id }), /not resumable/i);
});

test('resumeOnboarding: refuses when the resume point is missing', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'maestro-or-'));
  const { id } = await seedPipeline(proj, { title: ENABLE_TITLE, status: 'paused' });
  await assert.rejects(resumeOnboarding({ pipelineId: id }), /no resume point/i);
});

test('resumeOnboarding: refuses when the worktree is gone', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'maestro-or-'));
  const goneWt = await mkdtemp(join(tmpdir(), 'maestro-or-wt-'));
  await rm(goneWt, { recursive: true, force: true });
  const { id } = await seedPipeline(proj, { title: ENABLE_TITLE, status: 'paused',
    branch: { source: 'main', feature: 'f', worktreeDir: goneWt, reusedExisting: false },
    resumePoint: RP(proj) });
  await assert.rejects(resumeOnboarding({ pipelineId: id }), /worktree missing/i);
});

test('mock Enable run pauses and resumeOnboarding drives it to done', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-or-e2e-'));
  execSync('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: dir });

  const fresh = await runOnboarding({ projectDir: dir, answers: { canary: 'no' }, mock: true });
  // pause right after the FIRST node completes (same idiom as pause-resume-e2e).
  let pausedOnce = false;
  fresh.orch.on('phase', ({ status, nodeId }) => {
    if (!pausedOnce && status === 'done' && nodeId && fresh.orch.state.status === 'running') {
      pausedOnce = true;
      fresh.orch.pause();
    }
  });
  const r1 = await fresh.done;
  assert.equal(r1.status, 'paused');
  const pipelineId = fresh.orch.getState().id;
  assert.ok(readPipelineForResume(pipelineId).resumePoint, 'resume point persisted');

  const resumed = await resumeOnboarding({ pipelineId, mock: true });
  assert.equal(resumed.pipelineId, pipelineId);
  const readiness = [];
  resumed.events.on('readiness', (r) => readiness.push(r));
  const r2 = await resumed.done;
  assert.equal(r2.status, 'done');
  assert.equal(readPipelineForResume(pipelineId).row.status, 'done');
  assert.ok(readiness.some((r) => r.kind === 'final'), 'final readiness emitted on the resumed lifetime');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/onboarding-resume.test.mjs`
Expected: FAIL — `resumeOnboarding` is not exported.

- [ ] **Step 3: Implement `resumeOnboarding`**

In `src/core/onboarding.mjs`:

3a. Extend imports:

```js
import { existsSync, readFileSync } from 'node:fs';
import { readPipelineForResume, readStoreMeta } from './artifacts.mjs';
```

(`readFileSync` is already imported — merge, don't duplicate.)

3b. Add after `runOnboarding`:

```js
// Resume a paused/interrupted Enable pipeline (manual pause or session-limit
// auto-pause) with the SAME event wiring as a fresh run. Project dir resolves
// via store_meta — Enable projects are not in the projects registry table.
export async function resumeOnboarding({ pipelineId, interactive = false, mock = false, answers = {} } = {}) {
  if (!pipelineId) throw new Error('resumeOnboarding: pipelineId is required');
  const saved = readPipelineForResume(pipelineId);
  if (!saved) {
    const e = new Error('pipeline not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  const { row, resumePoint } = saved;
  if (row.title !== ENABLE_TITLE) throw new Error(`not an Enable run: "${row.title ?? row.id}"`);
  if (row.status !== 'paused' && row.status !== 'interrupted') {
    throw new Error(`pipeline is "${row.status}", not resumable`);
  }
  if (!resumePoint) throw new Error('pipeline has no resume point');

  let branch = null;
  try { branch = row.branch ? JSON.parse(row.branch) : null; } catch {}
  if (branch?.worktreeDir && !existsSync(branch.worktreeDir)) {
    throw new Error(`worktree missing: ${branch.worktreeDir}`);
  }

  const projectDir = readStoreMeta(row.project_key)?.path ?? null;
  if (!projectDir || !existsSync(projectDir)) {
    throw new Error('project directory for this run no longer exists on this machine');
  }

  const orch = createOrchestrator({
    projectDir,
    resume: saved,
    claude: { permissionMode: 'acceptEdits', mock },
  });
  return {
    ...wireOnboardingRun(orch, {
      answers, interactive,
      kick: () => orch.resume(),
      replayDir: resumePoint.pipelineDir || null,
    }),
    pipelineId,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/onboarding-resume.test.mjs`
Expected: PASS. If the guard tests fail on `projectDir` resolution instead of the expected message, check `seedPipeline` wrote store_meta for the project key (it routes through `createPipeline`, which does) — guard ORDER in the implementation must match the tests: title → status → resume point → worktree → projectDir.

- [ ] **Step 5: Commit**

```bash
git add src/core/onboarding.mjs test/onboarding-resume.test.mjs
git commit -m "feat(onboarding): resumeOnboarding — continue paused Enable pipelines"
```

---

### Task 4: Enable server pause/resume routes + resumable history

**Files:**
- Modify: `apps/enable/server.mjs`
- Test: `test/enable-pause-resume.test.mjs` (create)

**Interfaces:**
- Consumes: `resumeOnboarding` (Task 3), `hasResumePoint` (Task 1), `reconcileStaleRunning` (`src/core/artifacts.mjs`).
- Produces:
  - `POST /api/enable/pause {runId}` → `{ok:true}` | 400 `{error}`; buffers + broadcasts `{type:'paused', runId}`.
  - `POST /api/enable/resume {pipelineId, interactive?, mock?}` → `{runId, pipelineId}` | 404/400/409 `{error}`.
  - `GET /api/enable/history` entries gain `resumable: boolean`.
  - Task 5's renderer consumes all three.

- [ ] **Step 1: Write the failing tests**

Create `test/enable-pause-resume.test.mjs` (harness copied from `test/enable-server.mjs` — cookie auth, dynamic import):

```js
// Enable server pause/resume: endpoint guards, paused-frame broadcast, history
// resumable flag, and a full mock pause->resume rejoin through the HTTP surface.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { useTempHome } from './helpers/temp-home.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';

useTempHome(after);

let app, server, base, runs, cookie;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts = {}) =>
  realFetch(url, { ...opts, headers: { ...(opts.headers || {}), cookie } });

before(async () => {
  ({ app, server, runs } = await import('../apps/enable/server.mjs'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${server.address().port}`;
  const res = await realFetch(`http://${base}/`);
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
});
after(async () => { if (server) await new Promise((r) => server.close(r)); });

async function post(path, body) {
  const res = await fetch(`http://${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'enable-pr-'));
  execSync('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: dir });
  return dir;
}

test('POST /api/enable/pause: unknown runId -> 400', async () => {
  const r = await post('/api/enable/pause', { runId: 'nope' });
  assert.equal(r.status, 400);
});

test('POST /api/enable/pause: orch that cannot pause -> 400', async () => {
  runs.set('r-stuck', { orch: { pause: () => false }, status: 'running', buffer: [] });
  const r = await post('/api/enable/pause', { runId: 'r-stuck' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /cannot pause/i);
  runs.delete('r-stuck');
});

test('POST /api/enable/pause: pausable orch -> ok + paused frame buffered', async () => {
  const entry = { orch: { pause: () => true }, status: 'running', buffer: [] };
  runs.set('r-live', entry);
  const r = await post('/api/enable/pause', { runId: 'r-live' });
  assert.equal(r.status, 200);
  assert.equal(entry.status, 'pausing');
  assert.ok(entry.buffer.some((f) => f.type === 'paused' && f.runId === 'r-live'));
  runs.delete('r-live');
});

test('POST /api/enable/resume: unknown pipelineId -> 404', async () => {
  const r = await post('/api/enable/resume', { pipelineId: 'missing0' });
  assert.equal(r.status, 404);
});

test('POST /api/enable/resume: non-Enable / non-paused -> 400', async () => {
  const proj = freshRepo();
  const { id: doneId } = await seedPipeline(proj, { title: 'Enable project for AI', status: 'done' });
  const r = await post('/api/enable/resume', { pipelineId: doneId });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /not resumable/i);
});

test('POST /api/enable/resume: already-live pipeline -> 409', async () => {
  const proj = freshRepo();
  const { id } = await seedPipeline(proj, { title: 'Enable project for AI', status: 'paused',
    resumePoint: { version: 1, kind: 'boundary', stepIndex: 0, stepCycle: [], loopState: {},
      bus: null, stepModels: null, workflowId: 'wf_enable', plan: null, nodes: [], gate: null,
      pipelineDir: proj, pausedAt: '2026-07-10T00:00:00Z' } });
  runs.set('r-busy', { orch: { getState: () => ({ id }) }, status: 'running', buffer: [] });
  const r = await post('/api/enable/resume', { pipelineId: id });
  assert.equal(r.status, 409);
  runs.delete('r-busy');
});

test('mock run pauses over HTTP and resumes to done; history flags resumable', async () => {
  const proj = freshRepo();
  const started = await post('/api/enable/run', { projectDir: proj, answers: { canary: 'no' }, mock: true });
  assert.equal(started.status, 200);
  const runId = started.json.runId;
  const entry = runs.get(runId);

  // pause as soon as the engine reports running; poll — mock nodes are fast.
  for (let i = 0; i < 200; i++) {
    const r = await post('/api/enable/pause', { runId });
    if (r.status === 200) break;
    if (entry.status !== 'running' && i > 5) break;   // run may have finished already
    await new Promise((s) => setTimeout(s, 10));
  }
  const r1 = await entry.done;

  if (r1.status === 'paused') {                       // the interesting arm
    const pipelineId = entry.orch.getState().id;
    const hist = await (await fetch(`http://${base}/api/enable/history`)).json();
    const h = hist.runs.find((x) => x.id === pipelineId);
    assert.equal(h.resumable, true, 'paused run is resumable in history');

    const resumed = await post('/api/enable/resume', { pipelineId, mock: true });
    assert.equal(resumed.status, 200);
    assert.notEqual(resumed.json.runId, runId, 'resume mints a new runId');
    const entry2 = runs.get(resumed.json.runId);
    assert.ok(entry2.buffer !== undefined);
    assert.ok(!runs.has(runId), 'superseded paused entry evicted');
    const r2 = await entry2.done;
    assert.equal(r2.status, 'done');
    const hist2 = await (await fetch(`http://${base}/api/enable/history`)).json();
    assert.equal(hist2.runs.find((x) => x.id === pipelineId).resumable, false);
  } else {
    assert.equal(r1.status, 'done');                  // raced to completion: still a valid run
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/enable-pause-resume.test.mjs`
Expected: FAIL — pause/resume routes 404 (express falls through to static), `resumable` undefined.

- [ ] **Step 3: Implement the server changes**

In `apps/enable/server.mjs`:

3a. Imports — extend the two core import lines:

```js
import { runOnboarding, resumeOnboarding, readFinalReadiness, ENABLE_TITLE } from '../../src/core/onboarding.mjs';
import { listAllPipelines, reconcileStaleRunning } from '../../src/core/artifacts.mjs';
```

3b. Factor run registration out of `/api/enable/run` (replace lines 169-180) — place the helper above the route:

```js
// register a live run handle (fresh or resumed): buffer + broadcast its events,
// mirror the final status onto the entry. Shared by /run and /resume.
function registerRun(runId, { orch, events, done }) {
  const entry = { orch, events, done, status: 'running', buffer: [] };
  runs.set(runId, entry);
  for (const name of EVENTS) {
    events.on(name, (payload) => {
      const tagged = { type: name, ...(payload && typeof payload === 'object' ? payload : { value: payload }), runId };
      entry.buffer.push(tagged);
      if (entry.buffer.length > 5000) entry.buffer.shift();
      broadcast(tagged);
    });
  }
  done.then((r) => { entry.status = r.status; })
      .catch((err) => broadcast({ type: 'error', runId, message: String(err && err.message || err) }));
  return entry;
}
```

`/api/enable/run` body becomes:

```js
    const branch = sourceBranch ? { source: sourceBranch, feature: null } : undefined;
    const handle = await runOnboarding({
      projectDir, answers: answers || {}, mock: !!mock, interactive: !!interactive, branch });
    registerRun(handle.runId, handle);
    res.json({ runId: handle.runId });
```

3c. Pause + resume routes (add after `/api/enable/run`):

```js
// gracefully pause a live run: engine kills in-flight children, persists a
// resume point, lands on status 'paused'. The paused frame is buffered so a
// replaying client renders the banner after refresh.
app.post('/api/enable/pause', (req, res) => {
  const { runId } = req.body || {};
  const entry = runId && runs.get(runId);
  if (!entry) return res.status(400).json({ error: 'unknown runId' });
  try {
    const ok = typeof entry.orch?.pause === 'function' && entry.orch.pause();
    if (!ok) return res.status(400).json({ error: 'cannot pause in the current state' });
    entry.status = 'pausing';
    const frame = { type: 'paused', runId };
    entry.buffer.push(frame);
    broadcast(frame);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: String(err && err.message || err) }); }
});

// continue a paused/interrupted Enable pipeline as a NEW live run entry (new
// runId, same pipeline id / history row). Works across server restarts — the
// resume point lives in the DB, not in this process.
app.post('/api/enable/resume', async (req, res) => {
  const { pipelineId, interactive, mock } = req.body || {};
  if (!pipelineId || typeof pipelineId !== 'string') return res.status(400).json({ error: 'pipelineId required' });
  for (const e of runs.values()) {
    if (e.orch?.getState?.()?.id === pipelineId &&
        !['done', 'stopped', 'error', 'paused', 'interrupted'].includes(String(e.status || ''))) {
      return res.status(409).json({ error: 'pipeline is already live' });
    }
  }
  try {
    const handle = await resumeOnboarding({ pipelineId, interactive: !!interactive, mock: !!mock });
    // evict the superseded paused/interrupted lineage so it can't resurface as
    // a phantom paused card next to the resumed run.
    for (const [id, e] of runs) {
      if (e.orch?.getState?.()?.id === pipelineId &&
          ['paused', 'interrupted'].includes(String(e.status || ''))) runs.delete(id);
    }
    registerRun(handle.runId, handle);
    res.json({ runId: handle.runId, pipelineId });
  } catch (err) {
    const status = err && err.code === 'NOT_FOUND' ? 404 : 400;
    res.status(status).json({ error: String(err && err.message || err) });
  }
});
```

3d. `enableHistory()` — reconcile orphans, then tag `resumable`:

```js
async function enableHistory() {
  // flip orphaned 'running' rows (crashed server) to 'interrupted' so they
  // become resumable; live local runs are shielded via liveIds.
  try {
    reconcileStaleRunning({
      liveIds: [...runs.values()].map((r) => r.orch?.getState?.()?.id).filter(Boolean),
    });
  } catch {}
  const all = await listAllPipelines();
  return all.filter((p) => p.title === ENABLE_TITLE)
    .map((p) => {
      const readiness = p.dir ? readFinalReadiness(p.dir) : null;
      let estimatedCost = null;
      if (!(p.totalCostUsd > 0) && p.projectDir && existsSync(p.projectDir)) {
        try { estimatedCost = estimateCost(probeRepoSize(p.projectDir)); } catch {}
      }
      const resumable = (p.status === 'paused' || p.status === 'interrupted') && !!p.hasResumePoint;
      return { ...p, readiness, estimatedCost, resumable };
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/enable-pause-resume.test.mjs`
Expected: PASS

- [ ] **Step 5: Regression on the other enable server suites**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/enable-server.mjs test/enable-auth.test.mjs test/enable-history-manage.test.mjs test/enable-interactive.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/enable/server.mjs test/enable-pause-resume.test.mjs
git commit -m "feat(enable): pause/resume API routes + resumable history flag"
```

---

### Task 5: Renderer — pause button, paused banner, history resume

**Files:**
- Modify: `apps/enable/public/index.html` (progress section, ~line 117)
- Modify: `apps/enable/public/app.js`
- Modify: `apps/enable/public/styles.css`
- Test: `test/enable-pause-ui.test.mjs` (create)

**Interfaces:**
- Consumes: `POST /api/enable/pause`, `POST /api/enable/resume`, history `resumable` (Task 4); `{type:'paused'}` and `done{status:'paused'}` frames; `state` frames carry the engine state incl. `id` (the pipeline id).
- Produces: UI only.

- [ ] **Step 1: Write the failing tests**

Create `test/enable-pause-ui.test.mjs` (JSDOM boot copied from `test/onboarding-parity.test.mjs`'s last test):

```js
// Renderer pause/resume affordances: pause button lifecycle, paused banner with
// Resume, and Resume buttons on resumable history entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '../apps/enable/public/index.html'), 'utf8');
const appUrl = () => join(here, '../apps/enable/public/app.js') + `?b=${Date.now()}_${Math.random()}`;

class FakeWS { constructor(url) { FakeWS.last = this; this.url = url; } close() {} send() {} }

async function boot({ history = [], onFetch = () => null } = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost:4319/' });
  const { window } = dom;
  window.WebSocket = FakeWS;
  const calls = [];
  window.fetch = (url, opts) => {
    calls.push({ url: String(url), opts });
    const custom = onFetch(String(url), opts);
    if (custom) return Promise.resolve(custom);
    if (String(url).includes('/api/enable/history')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ runs: history }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ root: '/x', projects: [], runs: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(appUrl());
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  return { window, calls };
}

test('paused frame shows the banner and hides the pause button', async () => {
  const { window } = await boot();
  const w = window;
  // simulate an active run: elements exist statically in index.html
  w.document.querySelector('#pause-btn').hidden = false;
  // drive the frame handler through a fake WS message via the exposed handler path:
  // renderers attach ws.onmessage in connectRun; instead dispatch through handleFrame
  // exported on window for tests.
  w.__enableTest.setRun('run-1', 'pl-1');
  w.__enableTest.handle({ type: 'paused', runId: 'run-1' });
  assert.equal(w.document.querySelector('#paused-banner').hidden, false);
  assert.equal(w.document.querySelector('#pause-btn').hidden, true);
});

test('done{paused} also lands on the banner, not the error screen', async () => {
  const { window: w } = await boot();
  w.__enableTest.setRun('run-1', 'pl-1');
  w.__enableTest.handle({ type: 'done', status: 'paused', runId: 'run-1' });
  assert.equal(w.document.querySelector('#paused-banner').hidden, false);
  assert.equal(w.document.querySelector('#errored').classList.contains('active'), false);
});

test('resume button POSTs /api/enable/resume with the pipeline id', async () => {
  let resumeBody = null;
  const { window: w } = await boot({
    onFetch: (url, opts) => {
      if (url.includes('/api/enable/resume')) {
        resumeBody = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ runId: 'run-2', pipelineId: 'pl-1' }) };
      }
      return null;
    },
  });
  w.__enableTest.setRun('run-1', 'pl-1');
  w.__enableTest.handle({ type: 'paused', runId: 'run-1' });
  w.document.querySelector('#resume-btn').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(resumeBody, { pipelineId: 'pl-1' });
  assert.ok(FakeWS.last.url.includes('runId=run-2'), 'reconnected on the new runId');
});

test('history renders a Resume button only on resumable entries', async () => {
  const mk = (id, status, resumable) => ({ id, dir: `/s/${id}`, title: 'Enable project for AI',
    status, resumable, startedAt: '2026-07-10T10:00:00Z', projectName: `p-${id}`, readiness: null });
  const { window: w } = await boot({ history: [mk('aa', 'paused', true), mk('bb', 'done', false)] });
  const items = [...w.document.querySelectorAll('#history-list li')];
  assert.equal(items.length, 2);
  assert.ok(items[0].querySelector('.hist-resume'), 'paused entry has Resume');
  assert.ok(!items[1].querySelector('.hist-resume'), 'done entry has none');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/enable-pause-ui.test.mjs`
Expected: FAIL — `#pause-btn` / `#paused-banner` missing, `w.__enableTest` undefined.

- [ ] **Step 3: Implement HTML**

In `apps/enable/public/index.html`, directly after `<div id="run-meter" class="run-meter" hidden></div>` (line 117):

```html
        <div class="progress-actions">
          <button id="pause-btn" class="ghost-btn small" type="button" hidden>Pause run</button>
        </div>
        <div id="paused-banner" class="paused-banner" role="status" hidden>
          <p id="paused-reason">Run paused — resume when you're ready.</p>
          <button id="resume-btn" class="primary-btn" type="button">Resume run</button>
        </div>
```

- [ ] **Step 4: Implement app.js**

4a. State + pause UI helper (near the `let currentRunId = null;` block, line 34):

```js
let currentPipelineId = null;        // engine pipeline id, from state frames
let lastWarnLine = null;             // pause reason candidate (session limit etc.)
```

```js
// 'running' | 'pausing' | 'paused' | 'idle'
function setPauseUi(mode) {
  const btn = document.querySelector('#pause-btn');
  const banner = document.querySelector('#paused-banner');
  btn.hidden = mode !== 'running' && mode !== 'pausing';
  btn.disabled = mode === 'pausing';
  btn.textContent = mode === 'pausing' ? 'Pausing…' : 'Pause run';
  banner.hidden = mode !== 'paused';
  if (mode === 'paused') {
    document.querySelector('#paused-reason').textContent =
      lastWarnLine && /limit/i.test(lastWarnLine)
        ? `${lastWarnLine} The run will pick up where it left off.`
        : 'Run paused — resume when you\'re ready.';
    announce('The run is paused.');
    document.querySelector('#resume-btn').focus();
  }
}

function showPaused() {
  stopLiveMeter();
  hideGate(null);
  setPauseUi('paused');
}
```

4b. Extract the socket hookup from `start()` (replace lines 172-176) and share it with resume:

```js
function connectRun(runId) {
  if (ws) { try { ws.close(); } catch {} }   // drop the previous run's socket
  currentRunId = runId;
  ws = new WebSocket(`ws://${location.host}/ws?runId=${runId}`);
  ws.onmessage = (m) => { try { handle(JSON.parse(m.data)); } catch {} };
  ws.onerror = () => showError('Lost connection to the Enable server.');
}
```

`start()` ends with:

```js
  setPauseUi('running');
  connectRun(runId);
```

4c. Resume flow:

```js
async function resumeRun(pipelineId) {
  resetProgress();
  show('progress');
  startLiveMeter();
  try {
    const res = await fetch('/api/enable/resume', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pipelineId }) });
    if (!res.ok) { showError((await res.json().catch(() => ({}))).error || `resume failed (${res.status})`); return; }
    const { runId } = await res.json();
    currentPipelineId = pipelineId;
    setPauseUi('running');
    connectRun(runId);
  } catch (err) { showError(String(err.message || err)); }
}

async function pauseRun() {
  if (!currentRunId) return;
  setPauseUi('pausing');
  try {
    const res = await fetch('/api/enable/pause', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: currentRunId }) });
    if (!res.ok) setPauseUi('running');   // engine refused (already finishing)
  } catch { setPauseUi('running'); }
}
```

4d. `handle()` — capture the pipeline id, route paused frames (replace the `state`/`done` cases and add `paused`):

```js
    case 'state':    if (ev.id) currentPipelineId = ev.id; updateLiveTotals(ev); break;
    case 'paused':   showPaused(); break;
    case 'done':
      stopLiveMeter();
      if (ev.status === 'paused') showPaused();
      else if (ev.status === 'error') showError('The run ended with an error.');
      else setPauseUi('idle');
      break;
```

4e. `appendFeed()` — remember the last warn line (pause reason), first line of the function body:

```js
  if (ev.level === 'warn' && typeof (ev.text || ev.message) === 'string') lastWarnLine = ev.text || ev.message;
```

4f. `resetProgress()` — add resets:

```js
  currentPipelineId = null;
  lastWarnLine = null;
  setPauseUi('idle');
```

4g. `loadHistory()` — Resume button on resumable entries (replace the `li.innerHTML` block):

```js
    li.innerHTML = `<button type="button" class="hist-btn">
      <span class="hist-project">${name}</span>
      <span class="hist-when">${when}</span><span class="hist-score">${score}</span></button>` +
      (h.resumable ? `<button type="button" class="hist-resume"
        aria-label="Resume the ${name} run from ${when}" title="Resume run">Resume</button>` : '') +
      `<button type="button" class="hist-delete" aria-label="Delete the ${name} run from ${when}" title="Delete run">✕</button>`;
    li.querySelector('.hist-btn').addEventListener('click', () => showHistoryDetail(h.id));
    li.querySelector('.hist-resume')?.addEventListener('click', () => resumeRun(h.id));
    li.querySelector('.hist-delete').addEventListener('click', () => deleteHistory(h));
```

4h. `init()` — wire the buttons + expose the test hook (append at the end of `init()`):

```js
  document.querySelector('#pause-btn').addEventListener('click', pauseRun);
  document.querySelector('#resume-btn').addEventListener('click', () => {
    if (currentPipelineId) resumeRun(currentPipelineId);
  });

  // test-only hook (JSDOM suites drive frames without a real socket)
  window.__enableTest = {
    handle,
    setRun(runId, pipelineId) { currentRunId = runId; currentPipelineId = pipelineId; },
  };
```

- [ ] **Step 5: Implement styles.css**

Append:

```css
/* ---------- pause / resume ---------- */
.progress-actions { display: flex; justify-content: center; margin-top: 10px; }
.paused-banner {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  margin-top: 16px; padding: 14px 18px; border-radius: 10px;
  border: 1px solid var(--amber, #f2a25c); background: color-mix(in srgb, var(--amber, #f2a25c) 12%, transparent);
}
.paused-banner p { margin: 0; }
.hist-resume {
  border: 1px solid var(--accent, #46d39a); background: transparent; color: var(--accent, #46d39a);
  border-radius: 8px; padding: 4px 10px; cursor: pointer; font: inherit; font-size: 0.85em;
}
.hist-resume:hover { background: color-mix(in srgb, var(--accent, #46d39a) 15%, transparent); }
```

(Adjust variable names to whatever `styles.css` actually defines — check `:root` at the top of the file; `--accent`, `--amber`, `--red` are already used by `app.js:469`.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/enable-pause-ui.test.mjs`
Expected: PASS

- [ ] **Step 7: Renderer + a11y regression**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/enable-renderer.mjs test/enable-a11y.test.mjs test/onboarding-parity.test.mjs`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/enable/public/index.html apps/enable/public/app.js apps/enable/public/styles.css test/enable-pause-ui.test.mjs
git commit -m "feat(enable): pause button, paused banner and history resume in the renderer"
```

---

### Task 6: Full-suite verification + live smoke

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 2: Live mock smoke through the real server**

```bash
export MAESTRO_HOME=$(mktemp -d) SMOKE_REPO=$(mktemp -d)
git -C "$SMOKE_REPO" init -q -b main && git -C "$SMOKE_REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
PORT=43199 node --disable-warning=ExperimentalWarning apps/enable/server.mjs & SRV=$!
sleep 1
COOKIE=$(curl -si http://127.0.0.1:43199/ | grep -i '^set-cookie' | cut -d' ' -f2 | cut -d';' -f1)
RUN=$(curl -s -H "cookie: $COOKIE" -H 'content-type: application/json' \
  -d "{\"projectDir\":\"$SMOKE_REPO\",\"mock\":true,\"answers\":{\"canary\":\"no\"}}" \
  http://127.0.0.1:43199/api/enable/run | python3 -c 'import sys,json;print(json.load(sys.stdin)["runId"])')
# pause immediately (retry a few times — mock nodes are fast)
for i in 1 2 3 4 5; do curl -s -H "cookie: $COOKIE" -H 'content-type: application/json' \
  -d "{\"runId\":\"$RUN\"}" http://127.0.0.1:43199/api/enable/pause && break; sleep 0.2; done
sleep 2
curl -s -H "cookie: $COOKIE" http://127.0.0.1:43199/api/enable/history | python3 -m json.tool | grep -E 'resumable|"status"' | head
# take the paused pipeline id from the history output above:
curl -s -H "cookie: $COOKIE" -H 'content-type: application/json' \
  -d '{"pipelineId":"<ID-FROM-HISTORY>","mock":true}' http://127.0.0.1:43199/api/enable/resume
sleep 5
curl -s -H "cookie: $COOKIE" http://127.0.0.1:43199/api/enable/history | python3 -m json.tool | grep -E 'resumable|"status"' | head
kill $SRV
```

Expected: after pause, history shows `"status": "paused"` + `"resumable": true`; after resume completes, `"status": "done"` + `"resumable": false`. (If the mock run finishes before the pause lands, that's a race, not a failure — re-run the smoke.)

- [ ] **Step 3: Commit any fixups, then finish**

Use superpowers:finishing-a-development-branch.
