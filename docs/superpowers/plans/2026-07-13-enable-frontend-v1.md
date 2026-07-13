# Enable Readiness App v1 Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the missing `apps/enable/public/` frontend — Setup → Running → Report SPA consuming the WS event stream from `apps/enable/server.mjs` — per spec `docs/superpowers/specs/2026-07-13-enable-frontend-design.md`.

**Architecture:** Vanilla 3-file SPA (no build step): `index.html` holds all three screens, `app.js` is a screen state machine + WS message router, `styles.css` dark theme. Server, electron shell, and `src/core/*` are **unchanged**. Tests are jsdom + `node:test`: boot the real `index.html`, eval the real `app.js` with `window.eval`, inject FakeWS + fake fetch.

**Tech Stack:** Vanilla JS (ES2022), jsdom (already in root devDependencies, `package.json:32`), `node:test`.

## Global Constraints

- No new server endpoints; `apps/enable/server.mjs`, `apps/enable/electron/main.mjs`, `src/core/*` untouched.
- No build step, no framework, no new dependencies.
- Clarify question ids are exactly: `testTier`, `vendoringDepth`, `multiToolTargets`, `canary`, `scopeConstraints`.
- `multiToolTargets` is sent as an **array of keys** from `{cursor, copilot, agents}`; CLAUDE.md is locked-on server-side by `joinMultiToolTargets` (`src/core/onboarding.mjs:48-54`).
- UI dimension labels must deep-equal `DIMENSION_LABELS` exported from `src/core/onboarding.mjs:35-40` (parity test).
- Phase matching mirrors `matchNode` (`src/core/onboarding.mjs:86-88`): `ev.nodeId === nodeId || ev.phase === key || ev.phase === nodeId`.
- All tests run with: `node --test test/enable-renderer.test.mjs` from the repo root.
- Commit after every task.

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/enable/public/index.html` | All three screens' markup (`section[data-screen]`), a11y roles/labels, form defaults. Written once in Task 1; later tasks never edit it. |
| `apps/enable/public/styles.css` | Dark theme. Written once in Task 1. |
| `apps/enable/public/app.js` | State machine, fetch calls, WS router, renderers. Grows across Tasks 1–5; each task shows complete functions (later tasks say "Replace function X" with full bodies). |
| `test/enable-renderer.test.mjs` | Boot harness + all test cases. Grows across Tasks 1–5. |

---

### Task 1: Static shell + Setup screen (projects list, manual path)

**Files:**
- Create: `apps/enable/public/index.html`
- Create: `apps/enable/public/styles.css`
- Create: `apps/enable/public/app.js`
- Test: `test/enable-renderer.test.mjs`

**Interfaces:**
- Consumes: `GET /api/enable/projects` → `{root, projects:[{name,path}]}` (`apps/enable/server.mjs:42-50`).
- Produces (later tasks rely on): `window.__ENABLE_UI__ = { DIMENSION_LABELS, PHASE_NODES, state, handleMessage }`; `show(screen)` toggles `section[hidden]` by `data-screen`; `state.selectedPath`; `projectDir()` returns manual-path-or-selected; test harness `boot({fetchImpl, hash})` and `FakeWS` class with `emit(obj)` / `close()`; `tick()` settle helper.

- [ ] **Step 1: Write the failing test (harness + setup rendering + manual-path precedence)**

Create `test/enable-renderer.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '../apps/enable/public/index.html'), 'utf8');
const appJs = readFileSync(join(here, '../apps/enable/public/app.js'), 'utf8');

export class FakeWS {
  static instances = [];
  constructor(url) { FakeWS.instances.push(this); this.url = url; this.readyState = 1; this.OPEN = 1; }
  send() {}
  close() { if (this.onclose) this.onclose(); }
  emit(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
}

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

export function defaultFetch(captured = {}) {
  return (url, opts) => {
    const u = String(url);
    if (u.includes('/api/enable/projects')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({
        root: '/root', projects: [{ name: 'proj', path: '/root/proj' }, { name: 'other', path: '/root/other' }] }) });
    }
    if (u.includes('/api/enable/run')) {
      try { captured.runBody = JSON.parse(opts.body); } catch {}
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ runId: 'run-A' }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  };
}

export function boot({ fetchImpl, hash = '' } = {}) {
  FakeWS.instances = [];
  const dom = new JSDOM(html, { url: `http://localhost:4319/${hash}`, runScripts: 'outside-only' });
  const { window } = dom;
  window.WebSocket = FakeWS;
  window.fetch = fetchImpl || defaultFetch();
  window.__ENABLE_RECONNECT_MS = 1;
  window.eval(appJs);
  return { window, document: window.document, ui: window.__ENABLE_UI__ };
}

test('setup renders projects list and only the setup screen is visible', async () => {
  const { document } = boot();
  await tick();
  const buttons = [...document.querySelectorAll('#project-list button')];
  assert.deepEqual(buttons.map((b) => b.textContent), ['proj', 'other']);
  assert.equal(document.querySelector('[data-screen="setup"]').hidden, false);
  assert.equal(document.querySelector('[data-screen="running"]').hidden, true);
  assert.equal(document.querySelector('[data-screen="report"]').hidden, true);
});

test('manual path wins over list selection', async () => {
  const captured = {};
  const { document } = boot({ fetchImpl: defaultFetch(captured) });
  await tick();
  document.querySelector('#project-list button').click();          // selects /root/proj
  document.querySelector('#project-path').value = '/elsewhere/repo';
  document.querySelector('#run-btn').click();
  await tick();
  assert.equal(captured.runBody.projectDir, '/elsewhere/repo');
});
```

Note: the second test exercises `startRun` (Task 2). It is EXPECTED to fail until Task 2 — see Step 4. Task 1's gate is the first test passing plus the second failing for the right reason (no POST yet, `captured.runBody` undefined).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/enable-renderer.test.mjs`
Expected: both FAIL — first with `ENOENT` reading `index.html` (files don't exist yet).

- [ ] **Step 3: Write the three static files**

Create `apps/enable/public/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Enable — AI readiness</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
<main>
  <h1>Enable <span class="subtitle">project for AI</span></h1>

  <section data-screen="setup" aria-labelledby="setup-h">
    <h2 id="setup-h">Set up a run</h2>
    <div class="setup-grid">
      <div>
        <h3>Project</h3>
        <ul id="project-list" class="project-list" aria-label="Detected git projects"></ul>
        <label for="project-path">Or absolute path</label>
        <input id="project-path" type="text" placeholder="/path/to/repo" autocomplete="off">
      </div>
      <form id="setup-form">
        <fieldset>
          <legend>How much testing should we set up?</legend>
          <label><input type="radio" name="testTier" value="scaffold" checked> scaffold</label>
          <label><input type="radio" name="testTier" value="docs-only"> docs-only</label>
          <label><input type="radio" name="testTier" value="smoke"> smoke</label>
          <label><input type="radio" name="testTier" value="characterization"> characterization</label>
        </fieldset>
        <fieldset>
          <legend>Bundle reusable AI skills?</legend>
          <label><input type="radio" name="vendoringDepth" value="full" checked> full</label>
          <label><input type="radio" name="vendoringDepth" value="baseline-only"> baseline-only</label>
          <label><input type="radio" name="vendoringDepth" value="none"> none</label>
        </fieldset>
        <fieldset>
          <legend>Which other AI tools should we set up?</legend>
          <label><input type="checkbox" disabled checked> CLAUDE.md <small>(always)</small></label>
          <label><input type="checkbox" name="multiToolTargets" value="cursor" checked> Cursor (.cursor/rules)</label>
          <label><input type="checkbox" name="multiToolTargets" value="copilot" checked> Copilot instructions</label>
          <label><input type="checkbox" name="multiToolTargets" value="agents"> AGENTS.md</label>
        </fieldset>
        <fieldset>
          <legend>Options</legend>
          <label><input type="checkbox" id="canary" checked> Quick test-drive at the end (canary)</label>
          <label><input type="checkbox" id="mock"> Mock mode (dev)</label>
          <label for="scope">Folders to focus on or avoid</label>
          <textarea id="scope" rows="2" placeholder="e.g. only src/, skip legacy/"></textarea>
        </fieldset>
        <button type="button" id="run-btn" class="primary">Run</button>
        <p id="setup-error" class="error" role="alert" aria-live="polite"></p>
      </form>
    </div>
  </section>

  <section data-screen="running" hidden aria-labelledby="running-h">
    <h2 id="running-h">Running</h2>
    <p id="run-banner" class="banner error" hidden role="alert"></p>
    <ol id="stepper" class="stepper" aria-label="Pipeline phases"></ol>
    <div id="score-chips" class="chips" role="status" aria-live="polite" aria-label="Scores so far"></div>
    <pre id="log-tail" class="log" aria-label="Run log" aria-live="polite"></pre>
  </section>

  <section data-screen="report" hidden aria-labelledby="report-h">
    <h2 id="report-h">Readiness report</h2>
    <div class="score-block">
      <div id="final-score" class="final-score" aria-label="Final readiness score"></div>
      <div id="score-headline" class="score-headline"></div>
    </div>
    <div id="dims" class="dims" aria-label="Readiness dimensions"></div>
    <h3>Remaining gaps</h3>
    <ul id="gaps"></ul>
    <p id="gaps-empty">None — clean run.</p>
    <p>Branch: <code id="branch-name"></code></p>
    <button type="button" id="run-another" class="primary">Run another</button>
  </section>
</main>
<script src="app.js" defer></script>
</body>
</html>
```

Create `apps/enable/public/styles.css`:

```css
:root {
  --bg: #14161a; --panel: #1d2026; --text: #e6e8eb; --muted: #9aa2ad;
  --accent: #4f8ef7; --ok: #3fb26f; --err: #e05656; --warn: #d9a13b;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 900px; margin: 0 auto; padding: 24px; }
h1 { font-size: 22px; } h1 .subtitle { color: var(--muted); font-weight: 400; }
section { background: var(--panel); border-radius: 10px; padding: 20px; margin-bottom: 16px; }
fieldset { border: 1px solid #2c3038; border-radius: 8px; margin: 0 0 12px; }
legend { color: var(--muted); padding: 0 6px; }
label { display: block; margin: 4px 0; }
input[type="text"], textarea { width: 100%; background: var(--bg); color: var(--text);
  border: 1px solid #2c3038; border-radius: 6px; padding: 8px; }
.setup-grid { display: grid; grid-template-columns: 1fr 1.4fr; gap: 20px; }
.project-list { list-style: none; margin: 0 0 12px; padding: 0; }
.project-list button { display: block; width: 100%; text-align: left; padding: 8px 10px;
  margin-bottom: 4px; background: var(--bg); color: var(--text);
  border: 1px solid #2c3038; border-radius: 6px; cursor: pointer; }
.project-list button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
button.primary { background: var(--accent); color: #fff; border: 0; border-radius: 6px;
  padding: 10px 18px; font-size: 14px; cursor: pointer; }
.error { color: var(--err); min-height: 1em; }
.banner { padding: 10px; border-radius: 6px; background: rgba(224, 86, 86, .12); }
.stepper { display: flex; gap: 8px; list-style: none; padding: 0; flex-wrap: wrap; }
.stepper li { padding: 6px 12px; border-radius: 999px; border: 1px solid #2c3038; color: var(--muted); }
.stepper li[data-status="running"] { border-color: var(--accent); color: var(--accent); }
.stepper li[data-status="done"] { border-color: var(--ok); color: var(--ok); }
.stepper li[data-status="error"] { border-color: var(--err); color: var(--err); }
.chips { margin: 12px 0; min-height: 28px; }
.chip { display: inline-block; padding: 4px 10px; border-radius: 999px; margin-right: 6px;
  border: 1px solid #2c3038; }
.chip-baseline { border-color: var(--warn); color: var(--warn); }
.chip-cycle { border-color: var(--accent); color: var(--accent); }
.log { background: var(--bg); border-radius: 6px; padding: 10px; height: 240px;
  overflow: auto; white-space: pre-wrap; font-size: 12px; }
.score-block { display: flex; align-items: baseline; gap: 16px; }
.final-score { font-size: 48px; font-weight: 700; color: var(--ok); }
.score-headline { color: var(--muted); font-size: 18px; }
.dims { margin: 16px 0; }
.dim-row { display: grid; grid-template-columns: 180px 1fr 48px; gap: 10px;
  align-items: center; margin-bottom: 6px; }
.dim-label { color: var(--muted); }
.dim-bar { background: var(--bg); border-radius: 4px; height: 10px; overflow: hidden; }
.dim-fill { background: var(--accent); height: 100%; }
.dim-value { text-align: right; }
```

Create `apps/enable/public/app.js`:

```js
'use strict';
// Enable v1 frontend — vanilla SPA. Screens: setup -> running -> report.
// Spec: docs/superpowers/specs/2026-07-13-enable-frontend-design.md

const PHASE_NODES = [
  { nodeId: 's_clarify', key: 'enableClarifier',    label: 'Clarify' },
  { nodeId: 's_analyze', key: 'onboardingAnalyzer', label: 'Analyze' },
  { nodeId: 's_infra',   key: 'projectOnboarding',  label: 'Infra' },
  { nodeId: 's_tests',   key: 'onboardingTests',    label: 'Tests' },
  { nodeId: 's_eval',    key: 'onboardingEvaluator',label: 'Evaluate' },
  { nodeId: 's_canary',  key: 'onboardingCanary',   label: 'Canary' },
];

// UI copy of src/core/onboarding.mjs DIMENSION_LABELS — parity-tested, keep in sync.
const DIMENSION_LABELS = {
  docs: 'Documentation', skillsAgents: 'Custom skills', rules: 'Guardrails',
  tests: 'Test setup', featureSkillCoverage: 'Key-workflow coverage',
  realTests: 'Working tests', vendoring: 'Bundled skills',
  multiTool: 'Cross-tool support', codeHealth: 'Code health',
};

const state = {
  screen: 'setup', projects: [], selectedPath: null,
  runId: null, branch: null, cyclesSeen: new Set(),
  terminal: false, ws: null, reconnectMs: 0,
};

const $ = (sel) => document.querySelector(sel);

function show(screen) {
  state.screen = screen;
  for (const s of document.querySelectorAll('[data-screen]')) {
    s.hidden = s.dataset.screen !== screen;
  }
}

async function loadProjects() {
  try {
    const res = await fetch('/api/enable/projects');
    const data = await res.json();
    state.projects = data.projects || [];
  } catch { state.projects = []; }
  const ul = $('#project-list');
  ul.textContent = '';
  for (const p of state.projects) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = p.name;
    btn.dataset.path = p.path;
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      state.selectedPath = p.path;
      for (const b of ul.querySelectorAll('button')) {
        b.setAttribute('aria-pressed', String(b === btn));
      }
    });
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

function projectDir() {
  const manual = $('#project-path').value.trim();
  return manual || state.selectedPath || '';
}

function handleMessage() {} // WS router — real body in Task 3

function init() {
  loadProjects();
}

window.__ENABLE_UI__ = { DIMENSION_LABELS, PHASE_NODES, state, handleMessage };
init();
```

- [ ] **Step 4: Run tests**

Run: `node --test test/enable-renderer.test.mjs`
Expected: test 1 PASS; test 2 FAIL with `captured.runBody` undefined (`Cannot read properties of undefined (reading 'projectDir')`) — the run flow lands in Task 2.

- [ ] **Step 5: Commit**

```bash
git add apps/enable/public test/enable-renderer.test.mjs
git commit -m "feat(enable): frontend shell — setup screen renders projects"
```

---

### Task 2: Run submission (answers POST + WS attach + hash)

**Files:**
- Modify: `apps/enable/public/app.js` (add functions; replace `init`)
- Test: `test/enable-renderer.test.mjs` (append)

**Interfaces:**
- Consumes: Task 1's `projectDir()`, `show()`, `state`; server `POST /api/enable/run {projectDir, answers, mock}` → `{runId}` (`apps/enable/server.mjs:52-73`); WS endpoint `/ws?runId=` with per-run replay (`server.mjs:32-39`).
- Produces: `collectAnswers()` → `{testTier, vendoringDepth, multiToolTargets: string[], canary: 'yes'|'no', scopeConstraints: string}`; `startRun()`; `beginRun(runId)` (sets `location.hash`, resets running view, connects WS); `connect()`; `resetRunningView()` (stub here, full body Task 3). Task 5 relies on `connect`'s `onclose` reconnect hook and `beginRun` being callable from a hash match in `init`.

- [ ] **Step 1: Write the failing tests (POST body shape + WS attach)**

Append to `test/enable-renderer.test.mjs`:

```js
test('run POST carries all 5 answer ids; multiToolTargets is an array of keys', async () => {
  const captured = {};
  const { document } = boot({ fetchImpl: defaultFetch(captured) });
  await tick();
  document.querySelector('#project-list button').click();
  document.querySelector('input[name="multiToolTargets"][value="agents"]').click(); // add agents
  document.querySelector('#run-btn').click();
  await tick();
  const body = captured.runBody;
  assert.equal(body.projectDir, '/root/proj');
  assert.equal(body.mock, false);
  assert.deepEqual(Object.keys(body.answers).sort(),
    ['canary', 'multiToolTargets', 'scopeConstraints', 'testTier', 'vendoringDepth']);
  assert.equal(body.answers.testTier, 'scaffold');
  assert.equal(body.answers.vendoringDepth, 'full');
  assert.deepEqual(body.answers.multiToolTargets, ['cursor', 'copilot', 'agents']);
  assert.equal(body.answers.canary, 'yes');
});

test('successful run switches to running screen, opens WS with runId, sets hash', async () => {
  const { document, window } = boot();
  await tick();
  document.querySelector('#project-list button').click();
  document.querySelector('#run-btn').click();
  await tick();
  assert.equal(document.querySelector('[data-screen="running"]').hidden, false);
  assert.equal(FakeWS.instances.length, 1);
  assert.match(FakeWS.instances[0].url, /\/ws\?runId=run-A$/);
  assert.equal(window.location.hash, '#run=run-A');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/enable-renderer.test.mjs`
Expected: the two new tests (and Task 1's manual-path test) FAIL — no POST is made.

- [ ] **Step 3: Implement run submission**

Add to `apps/enable/public/app.js` (below `projectDir`, above `handleMessage`); also replace `init`:

```js
function collectAnswers() {
  const radio = (name) => {
    const el = document.querySelector(`input[name="${name}"]:checked`);
    return el ? el.value : undefined;
  };
  const multi = [...document.querySelectorAll('input[name="multiToolTargets"]:checked')]
    .map((el) => el.value);
  return {
    testTier: radio('testTier'),
    vendoringDepth: radio('vendoringDepth'),
    multiToolTargets: multi,
    canary: $('#canary').checked ? 'yes' : 'no',
    scopeConstraints: $('#scope').value.trim(),
  };
}

async function startRun() {
  const dir = projectDir();
  const errEl = $('#setup-error');
  errEl.textContent = '';
  if (!dir) { errEl.textContent = 'Pick a project or enter a path.'; return; }
  let res;
  try {
    res = await fetch('/api/enable/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: dir, answers: collectAnswers(), mock: $('#mock').checked }),
    });
  } catch (err) {
    errEl.textContent = String((err && err.message) || err);
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.runId) {
    errEl.textContent = data.error || `Run failed (${res.status}).`;
    return;
  }
  beginRun(data.runId);
}

function beginRun(runId) {
  state.runId = runId;
  state.terminal = false;
  state.cyclesSeen = new Set();
  location.hash = `run=${runId}`;
  resetRunningView();
  show('running');
  connect();
}

function resetRunningView() {} // full body in Task 3

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?runId=${encodeURIComponent(state.runId)}`);
  state.ws = ws;
  ws.onopen = () => { state.reconnectMs = 0; };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { console.warn('enable: bad ws message'); return; }
    handleMessage(msg);
  };
  ws.onclose = () => {
    if (state.terminal || state.screen === 'setup') return;
    const base = window.__ENABLE_RECONNECT_MS || 1000;
    state.reconnectMs = Math.min(state.reconnectMs ? state.reconnectMs * 2 : base, base * 5);
    setTimeout(connect, state.reconnectMs);
  };
}
```

Replace `init` with:

```js
function init() {
  $('#run-btn').addEventListener('click', startRun);
  loadProjects();
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/enable-renderer.test.mjs`
Expected: all 4 tests PASS (including Task 1's manual-path test).

- [ ] **Step 5: Commit**

```bash
git add apps/enable/public/app.js test/enable-renderer.test.mjs
git commit -m "feat(enable): run submission — answers POST, WS attach, run hash"
```

---

### Task 3: Running view — phase stepper, log tail, score chips

**Files:**
- Modify: `apps/enable/public/app.js` (replace `handleMessage` + `resetRunningView`; add renderers)
- Test: `test/enable-renderer.test.mjs` (append)

**Interfaces:**
- Consumes: WS events tagged by the server (`server.mjs:59-65`): `phase {nodeId, phase, status, cycle}`, `log {text}`, `state {branch:{feature}}`, `readiness {kind:'baseline'|'cycle', score, cycle}` (emitted by `src/core/onboarding.mjs:146-162`). `PHASE_NODES`, `state.cyclesSeen` from earlier tasks.
- Produces: `handleMessage(msg)` full router (Task 4 adds only `renderReport`, called from the existing `readiness` branch); `onPhase(ev)`; `onReadiness(ev)` (its `kind==='final'` branch calls `renderReport(ev)` — stubbed here, real in Task 4); `appendLog(ev)`; `addChip(text, cls)`; `showBanner(text)`; `onDone(ev)`.

- [ ] **Step 1: Write the failing tests**

Append to `test/enable-renderer.test.mjs`:

```js
async function bootRunning() {
  const ctx = boot();
  await tick();
  ctx.document.querySelector('#project-list button').click();
  ctx.document.querySelector('#run-btn').click();
  await tick();
  return { ...ctx, ws: FakeWS.instances[0] };
}

test('phase events drive the stepper, including the eval->infra rewind', async () => {
  const { document, ws } = await bootRunning();
  const status = (node) => document.querySelector(`#stepper li[data-node="${node}"]`).dataset.status;
  assert.equal(document.querySelectorAll('#stepper li').length, 6);
  ws.emit({ type: 'phase', nodeId: 's_analyze', status: 'start' });
  assert.equal(status('s_analyze'), 'running');
  ws.emit({ type: 'phase', nodeId: 's_analyze', status: 'done' });
  assert.equal(status('s_analyze'), 'done');
  ws.emit({ type: 'phase', phase: 'projectOnboarding', status: 'done' }); // legacy phase-string match
  assert.equal(status('s_infra'), 'done');
  ws.emit({ type: 'phase', nodeId: 's_eval', status: 'done', cycle: 1 });
  ws.emit({ type: 'phase', nodeId: 's_infra', status: 'start', cycle: 2 }); // rewind re-lights infra
  assert.equal(status('s_infra'), 'running');
});

test('log events append to the tail; baseline and cycle chips render, cycles deduped', async () => {
  const { document, ws } = await bootRunning();
  ws.emit({ type: 'log', text: 'hello' });
  ws.emit({ type: 'log', text: 'world' });
  assert.equal(document.querySelector('#log-tail').textContent, 'hello\nworld\n');
  ws.emit({ type: 'readiness', kind: 'baseline', score: 28 });
  ws.emit({ type: 'readiness', kind: 'cycle', cycle: 1, score: 74 });
  ws.emit({ type: 'readiness', kind: 'cycle', cycle: 1, score: 74 }); // replay duplicate
  const chips = [...document.querySelectorAll('#score-chips .chip')];
  assert.deepEqual(chips.map((c) => c.textContent), ['Baseline 28', 'Cycle 1: 74']);
});

test('error event shows the banner and keeps the log visible', async () => {
  const { document, ws } = await bootRunning();
  ws.emit({ type: 'log', text: 'partial' });
  ws.emit({ type: 'error', message: 'boom' });
  const banner = document.querySelector('#run-banner');
  assert.equal(banner.hidden, false);
  assert.equal(banner.textContent, 'boom');
  assert.equal(document.querySelector('#log-tail').textContent, 'partial\n');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/enable-renderer.test.mjs`
Expected: the three new tests FAIL (stepper empty — `resetRunningView` is a stub; `handleMessage` no-op).

- [ ] **Step 3: Implement the running view**

In `apps/enable/public/app.js`, replace the `resetRunningView` and `handleMessage` stubs and add the renderers:

```js
function resetRunningView() {
  const ol = $('#stepper');
  ol.textContent = '';
  for (const n of PHASE_NODES) {
    const li = document.createElement('li');
    li.dataset.node = n.nodeId;
    li.dataset.status = 'pending';
    li.textContent = n.label;
    ol.appendChild(li);
  }
  $('#score-chips').textContent = '';
  $('#log-tail').textContent = '';
  const banner = $('#run-banner');
  banner.hidden = true;
  banner.textContent = '';
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'phase': onPhase(msg); break;
    case 'readiness': onReadiness(msg); break;
    case 'log': appendLog(msg); break;
    case 'state':
      if (msg.branch && msg.branch.feature) state.branch = msg.branch.feature;
      break;
    case 'error':
      state.terminal = true;
      showBanner(msg.message || 'Run failed.');
      break;
    case 'done': onDone(msg); break;
    default: break; // unknown types ignored — forward compatible
  }
}

// mirrors matchNode in src/core/onboarding.mjs:86-88
function onPhase(ev) {
  const node = PHASE_NODES.find(
    (n) => ev.nodeId === n.nodeId || ev.phase === n.key || ev.phase === n.nodeId,
  );
  if (!node) return;
  const li = document.querySelector(`#stepper li[data-node="${node.nodeId}"]`);
  if (!li) return;
  li.dataset.status = ev.status === 'done' ? 'done' : ev.status === 'error' ? 'error' : 'running';
}

function addChip(text, cls) {
  const chip = document.createElement('span');
  chip.className = `chip ${cls}`;
  chip.textContent = text;
  $('#score-chips').appendChild(chip);
}

function onReadiness(ev) {
  if (ev.kind === 'baseline') {
    addChip(`Baseline ${ev.score ?? '—'}`, 'chip-baseline');
  } else if (ev.kind === 'cycle') {
    if (state.cyclesSeen.has(ev.cycle)) return; // replay-safe
    state.cyclesSeen.add(ev.cycle);
    addChip(`Cycle ${ev.cycle}: ${ev.score ?? '—'}`, 'chip-cycle');
  } else if (ev.kind === 'final') {
    renderReport(ev);
  }
}

function renderReport() {} // full body in Task 4

function appendLog(ev) {
  const el = $('#log-tail');
  el.textContent += `${ev.text || ''}\n`;
  el.scrollTop = el.scrollHeight;
}

function showBanner(text) {
  const banner = $('#run-banner');
  banner.hidden = false;
  banner.textContent = text;
}

function onDone(ev) {
  state.terminal = true;
  if (ev.status && ev.status !== 'done' && state.screen === 'running') {
    showBanner(`Run finished with status: ${ev.status}`);
  }
}
```

Note: `handleMessage` is captured in `window.__ENABLE_UI__` at the bottom of the file; since that line runs after all function declarations are hoisted, the reference stays correct — no change needed there. Baseline chips need no dedupe: `onboarding.mjs:144-153` guards baseline emission with `baselineEmitted`, and the replay buffer re-delivers it only on a fresh `connect()` after `resetRunningView()` cleared the chips.

- [ ] **Step 4: Run tests**

Run: `node --test test/enable-renderer.test.mjs`
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/enable/public/app.js test/enable-renderer.test.mjs
git commit -m "feat(enable): running view — stepper, log tail, score chips"
```

---

### Task 4: Report screen — final readiness card + label parity

**Files:**
- Modify: `apps/enable/public/app.js` (replace `renderReport` stub; replace `init` to wire `#run-another`)
- Test: `test/enable-renderer.test.mjs` (append)

**Interfaces:**
- Consumes: `readiness {kind:'final', score, baselineScore, delta, dimensions, gaps}` (emitted by `src/core/onboarding.mjs:169-176`); `DIMENSION_LABELS` (UI copy) and `state.branch` from earlier tasks; core export `DIMENSION_LABELS` from `src/core/onboarding.mjs`.
- Produces: `renderReport(r)` — renders score/headline/9 dims/gaps/branch, sets `state.terminal = true`, switches to the report screen.

- [ ] **Step 1: Write the failing tests**

Append to `test/enable-renderer.test.mjs` (add the import at the top of the file with the other imports):

```js
import { DIMENSION_LABELS as CORE_LABELS } from '../src/core/onboarding.mjs';
```

```js
test('UI dimension labels match src/core/onboarding.mjs DIMENSION_LABELS', () => {
  const { ui } = boot();
  assert.deepEqual(ui.DIMENSION_LABELS, { ...CORE_LABELS });
});

test('final readiness renders the report card', async () => {
  const { document, ws } = await bootRunning();
  ws.emit({ type: 'state', branch: { feature: 'maestro/enable-project-for-ai-ab12' } });
  ws.emit({ type: 'readiness', kind: 'final', score: 93, baselineScore: 28, delta: 65,
    dimensions: { docs: 90, skillsAgents: 100, rules: 80, tests: 95, featureSkillCoverage: 85,
      realTests: 100, vendoring: 100, multiTool: 100, codeHealth: 70 },
    gaps: ['no CI workflow'] });
  assert.equal(document.querySelector('[data-screen="report"]').hidden, false);
  assert.equal(document.querySelector('#final-score').textContent, '93');
  assert.equal(document.querySelector('#score-headline').textContent, '28 → 93 (+65)');
  const rows = [...document.querySelectorAll('#dims .dim-row')];
  assert.equal(rows.length, 9);
  const docsRow = rows.find((r) => r.dataset.dim === 'docs');
  assert.equal(docsRow.querySelector('.dim-label').textContent, 'Documentation');
  assert.equal(docsRow.querySelector('.dim-value').textContent, '90');
  assert.deepEqual([...document.querySelectorAll('#gaps li')].map((li) => li.textContent),
    ['no CI workflow']);
  assert.equal(document.querySelector('#gaps-empty').hidden, true);
  assert.equal(document.querySelector('#branch-name').textContent,
    'maestro/enable-project-for-ai-ab12');
});

test('null dimensions render as N/A; run-another returns to setup', async () => {
  const { document, ws } = await bootRunning();
  ws.emit({ type: 'readiness', kind: 'final', score: 85, baselineScore: null, delta: null,
    dimensions: { docs: 90, featureSkillCoverage: null }, gaps: [] });
  const fscRow = document.querySelector('#dims .dim-row[data-dim="featureSkillCoverage"]');
  assert.equal(fscRow.querySelector('.dim-value').textContent, 'N/A');
  assert.equal(document.querySelector('#score-headline').textContent, '');
  assert.equal(document.querySelector('#gaps-empty').hidden, false);
  document.querySelector('#run-another').click();
  assert.equal(document.querySelector('[data-screen="setup"]').hidden, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/enable-renderer.test.mjs`
Expected: parity test PASSES already (both label maps exist); the two render tests FAIL (`renderReport` stub does nothing).

- [ ] **Step 3: Implement the report renderer**

Replace the `renderReport` stub in `apps/enable/public/app.js`:

```js
function renderReport(r) {
  state.terminal = true;
  $('#final-score').textContent = r.score == null ? '—' : String(r.score);
  const delta = r.delta != null ? r.delta
    : (r.score != null && r.baselineScore != null ? r.score - r.baselineScore : null);
  $('#score-headline').textContent =
    (r.baselineScore != null && r.score != null)
      ? `${r.baselineScore} → ${r.score} (${delta >= 0 ? '+' : ''}${delta})`
      : '';
  const dims = $('#dims');
  dims.textContent = '';
  for (const [key, label] of Object.entries(DIMENSION_LABELS)) {
    const v = r.dimensions ? r.dimensions[key] : null;
    const row = document.createElement('div');
    row.className = 'dim-row';
    row.dataset.dim = key;
    const name = document.createElement('span');
    name.className = 'dim-label';
    name.textContent = label;
    const bar = document.createElement('div');
    bar.className = 'dim-bar';
    const fill = document.createElement('div');
    fill.className = 'dim-fill';
    fill.style.width = `${Math.max(0, Math.min(100, v ?? 0))}%`;
    bar.appendChild(fill);
    const val = document.createElement('span');
    val.className = 'dim-value';
    val.textContent = v == null ? 'N/A' : String(v);
    row.append(name, bar, val);
    dims.appendChild(row);
  }
  const gaps = $('#gaps');
  gaps.textContent = '';
  for (const g of r.gaps || []) {
    const li = document.createElement('li');
    li.textContent = g;
    gaps.appendChild(li);
  }
  $('#gaps-empty').hidden = (r.gaps || []).length > 0;
  $('#branch-name').textContent = state.branch || '';
  show('report');
}
```

Replace `init` with:

```js
function init() {
  $('#run-btn').addEventListener('click', startRun);
  $('#run-another').addEventListener('click', () => {
    location.hash = '';
    show('setup');
  });
  loadProjects();
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/enable-renderer.test.mjs`
Expected: all 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/enable/public/app.js test/enable-renderer.test.mjs
git commit -m "feat(enable): report screen — readiness card with label parity test"
```

---

### Task 5: Resilience — POST failure, WS reconnect, hash reattach

**Files:**
- Modify: `apps/enable/public/app.js` (replace `init` only — reconnect logic already landed in Task 2's `connect`)
- Test: `test/enable-renderer.test.mjs` (append)

**Interfaces:**
- Consumes: Task 2's `connect()` `onclose` backoff (`window.__ENABLE_RECONNECT_MS` override), `beginRun(runId)`; server replay buffer semantics (`server.mjs:38`).
- Produces: `init()` that reattaches to `#run=<id>` on load. Final `init` — no later task touches it.

- [ ] **Step 1: Write the failing tests**

Append to `test/enable-renderer.test.mjs`:

```js
test('failed run POST shows inline error and stays on setup', async () => {
  const failFetch = (url) => {
    const u = String(url);
    if (u.includes('/api/enable/projects')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({
        root: '/root', projects: [{ name: 'proj', path: '/root/proj' }] }) });
    }
    if (u.includes('/api/enable/run')) {
      return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  };
  const { document } = boot({ fetchImpl: failFetch });
  await tick();
  document.querySelector('#project-list button').click();
  document.querySelector('#run-btn').click();
  await tick();
  assert.equal(document.querySelector('#setup-error').textContent, 'boom');
  assert.equal(document.querySelector('[data-screen="setup"]').hidden, false);
  assert.equal(FakeWS.instances.length, 0);
});

test('WS drop mid-run reconnects with the same runId; terminal close does not', async () => {
  const { ws } = await bootRunning();
  assert.equal(FakeWS.instances.length, 1);
  ws.close();                     // mid-run drop
  await tick(20);                 // backoff is 1ms via __ENABLE_RECONNECT_MS
  assert.equal(FakeWS.instances.length, 2);
  assert.match(FakeWS.instances[1].url, /runId=run-A$/);
  FakeWS.instances[1].emit({ type: 'readiness', kind: 'final', score: 90, baselineScore: null,
    delta: null, dimensions: {}, gaps: [] });   // terminal
  FakeWS.instances[1].close();
  await tick(20);
  assert.equal(FakeWS.instances.length, 2);     // no reconnect after terminal
});

test('booting with #run=<id> reattaches to the run', async () => {
  const { document } = boot({ hash: '#run=run-Z' });
  await tick();
  assert.equal(document.querySelector('[data-screen="running"]').hidden, false);
  assert.equal(FakeWS.instances.length, 1);
  assert.match(FakeWS.instances[0].url, /runId=run-Z$/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/enable-renderer.test.mjs`
Expected: POST-failure and reconnect tests PASS already (logic landed in Tasks 2–4 — that's fine, they now pin it); hash-reattach test FAILS (running screen hidden, no WS).

- [ ] **Step 3: Implement hash reattach**

Replace `init` in `apps/enable/public/app.js`:

```js
function init() {
  $('#run-btn').addEventListener('click', startRun);
  $('#run-another').addEventListener('click', () => {
    location.hash = '';
    show('setup');
  });
  loadProjects();
  const m = location.hash.match(/run=([\w-]+)/);
  if (m) beginRun(m[1]); // replay buffer restores state (server.mjs:38)
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/enable-renderer.test.mjs`
Expected: all 13 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/enable/public/app.js test/enable-renderer.test.mjs
git commit -m "feat(enable): resilience — POST errors, WS reconnect, hash reattach"
```

---

### Task 6: Full-suite verification + live smoke

**Files:**
- Modify: none expected (fixes only if verification fails)

**Interfaces:**
- Consumes: everything above; `test/onboarding-api.mjs` (must stay green); `apps/enable/server.mjs` mock mode.

- [ ] **Step 1: Run the enable-related test files**

Run: `node --test test/enable-renderer.test.mjs test/onboarding-api.mjs`
Expected: all PASS. `onboarding-api.mjs` was not modified; a failure there means an import side effect — investigate, do not skip.

- [ ] **Step 2: Run the full repo suite**

Run: `npm test`
Expected: same pass/fail set as on the base commit (`git stash` is NOT needed — compare against a fresh `node --test` run if unsure). No new failures.

- [ ] **Step 3: Live smoke in mock mode**

```bash
cd apps/enable && npm install && PORT=4319 npm start
```

Then in a browser (or the harness browser) open `http://127.0.0.1:4319/`:
1. Setup screen renders; projects list shows git subdirs of the cwd.
2. Enter an absolute path to any small git repo, tick **Mock mode**, click **Run**.
3. Stepper advances through the 6 phases; log tail scrolls; report card appears.
4. Refresh mid-run → running screen reattaches (replay).

Expected: no console errors; the three screens behave as specced. (Mock mode exercises the orchestrator's mock path via `runOnboarding({mock:true})` — no real Claude calls.)

- [ ] **Step 4: Commit any fixes; final commit if working tree dirty**

```bash
git status --short   # if clean, done; otherwise:
git add -A && git commit -m "fix(enable): smoke-test fixes for v1 frontend"
```

---

## Self-Review (performed)

- **Spec coverage:** screens/states (T1–T4), 5-question form + array multiToolTargets (T2), stepper w/ rewind + chips + log (T3), report card + parity + N/A dims (T4), reconnect/backoff + hash reattach + POST failure + malformed-JSON guard (T2/T5), server untouched (all), jsdom tests incl. the spec's 6 enumerated cases (T1–T5), `onboarding-api.mjs` green (T6). No gaps.
- **Placeholder scan:** the only stubs (`resetRunningView`, `renderReport`, `handleMessage`) are real committed code replaced by full bodies shown in later tasks — no TBDs.
- **Type consistency:** `handleMessage(msg)`, `onPhase(ev)`, `onReadiness(ev)`, `renderReport(r)`, `beginRun(runId)`, `collectAnswers()` names/signatures consistent across tasks; test helpers `boot`, `bootRunning`, `tick`, `FakeWS`, `defaultFetch(captured)` used as defined in T1/T3.
