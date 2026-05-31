# Named project registry + dropdown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the web UI's free-text project-path field with a saved-projects dropdown backed by a persistent `name → path` registry, supporting add / select / delete.

**Architecture:** A pure core module (`src/core/projects.mjs`) owns a JSON registry at `~/.maestro/projects.json` and does all validation. The Express server exposes three thin endpoints (`GET/POST/DELETE /api/projects`) that delegate to it. The client swaps the path text input for a `<select>` plus an inline add-form and a delete button, feeding the selected path into the unchanged run/install/history flows.

**Tech Stack:** Node ESM (`.mjs`), `node:test`, Express 4, vanilla browser ESM (no build step).

**Spec:** `docs/superpowers/specs/2026-05-31-project-registry-dropdown-design.md`

**Branch:** `feature/project-registry-dropdown` (already created; the spec is already committed there).

---

## File Structure

- **Create** `src/core/projects.mjs` — registry: path normalization, list/add/remove, validation, atomic write.
- **Create** `test/projects.test.mjs` — unit tests for the core module.
- **Create** `test/projects-api.test.mjs` — HTTP round-trip tests for the endpoints.
- **Create** `test/projects-ui.test.mjs` — static assertions that the client markup/JS is wired.
- **Modify** `ui/server.mjs` — import core, refactor `resolveProjectDir` to delegate, add 3 routes, guard the auto-listen so the module is importable in tests.
- **Modify** `ui/public/index.html` — replace the project-path field with the selector + add-form; tweak history empty text.
- **Modify** `ui/public/app.js` — project state, load/render/select/add/delete, wire run/install/history, localStorage restore, boot.
- **Modify** `ui/public/style.css` — minimal styles for the selector row and add-form.

---

## Task 1: Core registry module

**Files:**
- Create: `src/core/projects.mjs`
- Test: `test/projects.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `test/projects.test.mjs`:

```js
// test/projects.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  addProject,
  removeProject,
  listProjects,
  normalizeProjectPath,
  projectsFile,
} from '../src/core/projects.mjs';

const created = [];
async function freshHome() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-home-'));
  created.push(dir);
  process.env.MAESTRO_HOME = dir;
  return dir;
}
after(async () => {
  delete process.env.MAESTRO_HOME;
  await Promise.all(created.map((d) => rm(d, { recursive: true, force: true })));
});

test('add then list returns the entry, flagged existing', async () => {
  const home = await freshHome();
  const list = await addProject({ name: 'demo', path: home });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'demo');
  assert.equal(list[0].path, home);
  assert.equal(list[0].exists, true);
  assert.deepEqual(await listProjects(), list);
});

test('duplicate name is rejected (case-insensitive)', async () => {
  const home = await freshHome();
  await addProject({ name: 'Demo', path: home });
  await assert.rejects(() => addProject({ name: 'demo', path: home }), /already exists/);
});

test('remove drops the entry; removing an absent name is a no-op', async () => {
  const home = await freshHome();
  await addProject({ name: 'demo', path: home });
  let list = await removeProject('demo');
  assert.deepEqual(list, []);
  list = await removeProject('nope'); // no-op
  assert.deepEqual(list, []);
});

test('a path that is a file is rejected', async () => {
  const home = await freshHome();
  const file = join(home, 'afile.txt');
  await writeFile(file, 'x', 'utf8');
  await assert.rejects(() => addProject({ name: 'f', path: file }), /not a directory/);
});

test('a non-existent path is accepted and flagged missing', async () => {
  await freshHome();
  const list = await addProject({ name: 'ghost', path: '/no/such/dir/here' });
  assert.equal(list[0].exists, false);
});

test('missing registry file yields an empty list', async () => {
  await freshHome();
  assert.deepEqual(await listProjects(), []);
});

test('corrupt registry JSON yields an empty list', async () => {
  const home = await freshHome();
  await mkdir(join(home, '.maestro'), { recursive: true });
  await writeFile(projectsFile(), 'not json at all', 'utf8');
  assert.deepEqual(await listProjects(), []);
});

test('leading ~ in a path is expanded', () => {
  const out = normalizeProjectPath('~/somewhere');
  assert.equal(out, join(process.env.HOME || homedir(), 'somewhere'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/projects.test.mjs`
Expected: FAIL — `Cannot find module '../src/core/projects.mjs'`.

- [ ] **Step 3: Write the module**

Create `src/core/projects.mjs`:

```js
// src/core/projects.mjs
// Named project registry: a small persistent list of { name, path } entries the
// web UI uses to populate its project dropdown. Stored as a JSON array at
// <MAESTRO_HOME or os.homedir()>/.maestro/projects.json.
//
// Reads never throw: a missing or corrupt file yields an empty list. Writes are
// atomic-ish (temp file + rename) and create ~/.maestro on demand.

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

/** Absolute path to the ~/.maestro directory (honors MAESTRO_HOME for tests). */
export function maestroHome() {
  const base =
    process.env.MAESTRO_HOME && process.env.MAESTRO_HOME.trim() ? process.env.MAESTRO_HOME : homedir();
  return join(resolve(base), '.maestro');
}

/** Absolute path to the registry file. */
export function projectsFile() {
  return join(maestroHome(), 'projects.json');
}

/**
 * Expand a leading ~ and resolve to an absolute path. Mirrors the web server's
 * historical resolveProjectDir so the registry and runs agree on a path.
 * @param {string} input
 * @returns {string|null} absolute path, or null for empty/non-string input
 */
export function normalizeProjectPath(input) {
  if (!input || typeof input !== 'string' || !input.trim()) return null;
  let p = input.trim();
  if (p.startsWith('~')) p = join(process.env.HOME || process.env.USERPROFILE || '', p.slice(1));
  return resolve(p);
}

/** True when the path exists and is a directory. */
function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read the raw registry array. Missing file or invalid JSON -> []. Never throws.
 * @returns {Promise<Array<{name:string, path:string}>>}
 */
async function readRaw() {
  try {
    const text = await readFile(projectsFile(), 'utf8');
    const data = JSON.parse(text);
    if (!Array.isArray(data)) return [];
    return data.filter((e) => e && typeof e.name === 'string' && typeof e.path === 'string');
  } catch {
    return [];
  }
}

/** Atomically write the registry array. Creates ~/.maestro if needed. */
async function writeRaw(list) {
  await mkdir(maestroHome(), { recursive: true });
  const file = projectsFile();
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

/**
 * List saved projects, each annotated with a runtime `exists` flag (true when
 * the path is an existing directory). The flag is computed, never persisted.
 * @returns {Promise<Array<{name:string, path:string, exists:boolean}>>}
 */
export async function listProjects() {
  const list = await readRaw();
  return list.map((e) => ({ name: e.name, path: e.path, exists: isDir(e.path) }));
}

/**
 * Add a project. Validates and persists. Returns the updated annotated list.
 * @param {{name:string, path:string}} input
 * @throws {Error} on empty name/path, duplicate name, or a path that exists but
 *   is not a directory.
 */
export async function addProject(input) {
  const name = (input && typeof input.name === 'string' ? input.name : '').trim();
  if (!name) throw new Error('project name is required');
  const path = normalizeProjectPath(input && input.path);
  if (!path) throw new Error('project path is required');
  // A path that exists must be a directory; a non-existent path is allowed (the
  // run creates it), matching the orchestrator's mkdir-on-run behavior.
  if (existsSync(path) && !isDir(path)) throw new Error('path is not a directory');

  const list = await readRaw();
  if (list.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`a project named "${name}" already exists`);
  }
  list.push({ name, path });
  await writeRaw(list);
  return listProjects();
}

/**
 * Remove a project by name (case-insensitive). Absent name is a no-op.
 * @param {string} name
 * @returns {Promise<Array<{name:string, path:string, exists:boolean}>>}
 */
export async function removeProject(name) {
  const key = (typeof name === 'string' ? name : '').trim().toLowerCase();
  const list = await readRaw();
  const next = list.filter((e) => e.name.toLowerCase() !== key);
  if (next.length !== list.length) await writeRaw(next);
  return listProjects();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/projects.test.mjs`
Expected: PASS — 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/projects.mjs test/projects.test.mjs
git commit -m "feat: project registry core module (~/.maestro/projects.json)"
```

---

## Task 2: Server endpoints + importable server

**Files:**
- Modify: `ui/server.mjs` (imports at top; `resolveProjectDir` ~line 184; add routes before the SPA fallback ~line 471; guard the listen ~line 487)
- Test: `test/projects-api.test.mjs`

- [ ] **Step 1: Write the failing API test**

Create `test/projects-api.test.mjs`:

```js
// test/projects-api.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let homeDir, srv, base;

before(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'maestro-apihome-'));
  process.env.MAESTRO_HOME = homeDir;
  // Imported (not run as main) -> the module must NOT bind its own port.
  const { app } = await import('../ui/server.mjs');
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => {
  if (srv) await new Promise((r) => srv.close(r));
  delete process.env.MAESTRO_HOME;
  await rm(homeDir, { recursive: true, force: true });
});

test('projects API: list empty, add, reject duplicate, delete', async () => {
  let r = await fetch(`${base}/api/projects`);
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).projects, []);

  r = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'demo', path: homeDir }),
  });
  assert.equal(r.status, 200);
  let j = await r.json();
  assert.equal(j.projects.length, 1);
  assert.equal(j.projects[0].name, 'demo');
  assert.equal(j.projects[0].exists, true);

  r = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'demo', path: homeDir }),
  });
  assert.equal(r.status, 400);

  r = await fetch(`${base}/api/projects?name=${encodeURIComponent('demo')}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).projects, []);
});

test('POST /api/projects with no name is a 400', async () => {
  const r = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: homeDir }),
  });
  assert.equal(r.status, 400);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/projects-api.test.mjs`
Expected: FAIL — the import hangs/binds port 4317 (no main-guard yet) and/or `/api/projects` returns the SPA HTML (404-ish JSON parse error). Either way the assertions fail.

- [ ] **Step 3: Add the core import**

In `ui/server.mjs`, find:

```js
import { listPipelines, readPipeline } from '../src/core/artifacts.mjs';
```

Add immediately below it:

```js
import { listProjects, addProject, removeProject, normalizeProjectPath } from '../src/core/projects.mjs';
```

- [ ] **Step 4: Refactor `resolveProjectDir` to delegate**

Replace the existing function (currently ~lines 184-189):

```js
function resolveProjectDir(input) {
  if (!input || typeof input !== 'string' || !input.trim()) return null;
  let p = input.trim();
  if (p.startsWith('~')) p = path.join(process.env.HOME || process.env.USERPROFILE || '', p.slice(1));
  return path.resolve(p);
}
```

with:

```js
// Single source of truth for path normalization lives in the core registry.
function resolveProjectDir(input) {
  return normalizeProjectPath(input);
}
```

- [ ] **Step 5: Add the three routes**

In `ui/server.mjs`, immediately AFTER the `POST /api/install` handler block (ends ~line 350, the `});` of `app.post('/api/install', ...)`) and BEFORE the `installAgents` function, insert:

```js
// ---------------------------------------------------------------------------
// Project registry: GET list / POST add / DELETE remove. Thin delegation to
// src/core/projects.mjs (which owns validation + persistence).
// ---------------------------------------------------------------------------
app.get('/api/projects', async (_req, res) => {
  try {
    res.json({ projects: await listProjects() });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

app.post('/api/projects', async (req, res) => {
  const body = req.body || {};
  try {
    const projects = await addProject({ name: body.name, path: body.path });
    res.json({ projects });
  } catch (err) {
    // Validation failures (empty/duplicate/not-a-directory) are client errors.
    return badRequest(res, err && err.message ? err.message : String(err));
  }
});

app.delete('/api/projects', async (req, res) => {
  const name = typeof req.query.name === 'string' ? req.query.name : '';
  if (!name.trim()) return badRequest(res, 'name is required');
  try {
    res.json({ projects: await removeProject(name) });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});
```

- [ ] **Step 6: Guard the auto-listen so the module is importable**

In `ui/server.mjs`, change the `node:url` import:

```js
import { fileURLToPath } from 'node:url';
```

to:

```js
import { fileURLToPath, pathToFileURL } from 'node:url';
```

Then replace the bottom listen block (currently ~lines 483-491):

```js
server.on('error', (err) => {
  console.error(`[maestro-ui] server error: ${err && err.message ? err.message : err}`);
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`[maestro-ui] listening on ${url}`);
  console.log(`[maestro-ui] WebSocket on ws://localhost:${PORT}/ws`);
});
```

with:

```js
// Only bind a port when run directly (`node ui/server.mjs`). When imported by a
// test, skip listening so the test can mount `app` on its own ephemeral port.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  server.on('error', (err) => {
    console.error(`[maestro-ui] server error: ${err && err.message ? err.message : err}`);
  });

  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`[maestro-ui] listening on ${url}`);
    console.log(`[maestro-ui] WebSocket on ws://localhost:${PORT}/ws`);
  });
}
```

- [ ] **Step 7: Run the API test to verify it passes**

Run: `node --test test/projects-api.test.mjs`
Expected: PASS — both tests pass.

- [ ] **Step 8: Run the full test suite (no regressions)**

Run: `npm test`
Expected: PASS — clarify, ui-theme, projects, and projects-api tests all pass.

- [ ] **Step 9: Commit**

```bash
git add ui/server.mjs test/projects-api.test.mjs
git commit -m "feat: /api/projects endpoints; make ui/server.mjs importable in tests"
```

---

## Task 3: Client dropdown, add-form, delete

**Files:**
- Modify: `ui/public/index.html` (project field ~lines 33-44; history empty `<li>` ~line 127)
- Modify: `ui/public/app.js` (el map ~line 26; remove old change handler ~lines 624-630; submit ~line 639; install ~line 765; refreshHistory ~line 800; boot ~line 909)
- Modify: `ui/public/style.css` (append)
- Test: `test/projects-ui.test.mjs`

- [ ] **Step 1: Write the failing static-wiring test**

Create `test/projects-ui.test.mjs`:

```js
// test/projects-ui.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../ui/public/index.html', import.meta.url)), 'utf8');
const appjs = readFileSync(fileURLToPath(new URL('../ui/public/app.js', import.meta.url)), 'utf8');

test('the free-text project path field is gone', () => {
  assert.ok(!html.includes('id="projectDir"'), 'old #projectDir input still in markup');
  assert.ok(!appjs.includes("$('#projectDir')"), 'app.js still wires #projectDir');
});

test('the project selector and add-form exist in markup', () => {
  assert.ok(html.includes('id="projectSelect"'), 'missing #projectSelect');
  assert.ok(html.includes('id="add-project"'), 'missing #add-project form');
  assert.ok(html.includes('id="project-delete"'), 'missing #project-delete button');
});

test('app.js loads and uses the project registry', () => {
  assert.ok(appjs.includes("fetch('/api/projects')"), 'app.js does not GET /api/projects');
  assert.ok(appjs.includes('selectedProjectPath'), 'missing selectedProjectPath helper');
  assert.ok(appjs.includes('loadProjects'), 'missing loadProjects');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/projects-ui.test.mjs`
Expected: FAIL — `old #projectDir input still in markup` (and the new-element assertions fail).

- [ ] **Step 3: Replace the project field in `index.html`**

Replace this block (currently ~lines 33-44):

```html
            <label class="field">
              <span class="label">Project folder</span>
              <input
                id="projectDir"
                name="projectDir"
                type="text"
                placeholder="/absolute/path/to/your/project"
                spellcheck="false"
                required
              />
              <small class="hint">The orchestrator operates inside this folder.</small>
            </label>
```

with:

```html
            <label class="field">
              <span class="label">Project</span>
              <div class="project-row">
                <select id="projectSelect" name="projectSelect">
                  <option value="" disabled selected>No projects yet</option>
                  <option value="__add__">+ Add project&hellip;</option>
                </select>
                <button
                  type="button"
                  id="project-delete"
                  class="btn btn-mini"
                  title="Remove the selected project from the list"
                  disabled
                >
                  &#10005;
                </button>
              </div>
              <small class="hint" id="projectHint">Pick a saved project, or add one. The orchestrator operates inside its folder.</small>

              <div id="add-project" class="add-project hidden">
                <input id="newProjectName" type="text" placeholder="Project name" spellcheck="false" />
                <input id="newProjectPath" type="text" placeholder="/absolute/path/to/project" spellcheck="false" />
                <div class="add-project-actions">
                  <button type="button" id="addProjectCancel" class="btn btn-ghost btn-mini">Cancel</button>
                  <button type="button" id="addProjectSave" class="btn btn-primary btn-mini">Save</button>
                </div>
                <small class="hint" id="addProjectMsg"></small>
              </div>
            </label>
```

- [ ] **Step 4: Update the history empty text in `index.html`**

Replace (currently ~line 127):

```html
            <li class="empty">Enter a project folder to load history.</li>
```

with:

```html
            <li class="empty">Select a project to load history.</li>
```

- [ ] **Step 5: Update the `el` map in `app.js`**

In the `el = { ... }` object, replace this line (~line 26):

```js
  projectDir: $('#projectDir'),
```

with:

```js
  projectSelect: $('#projectSelect'),
  projectDelete: $('#project-delete'),
  projectHint: $('#projectHint'),
  addProject: $('#add-project'),
  newProjectName: $('#newProjectName'),
  newProjectPath: $('#newProjectPath'),
  addProjectSave: $('#addProjectSave'),
  addProjectCancel: $('#addProjectCancel'),
  addProjectMsg: $('#addProjectMsg'),
```

- [ ] **Step 6: Add `projects` to app state**

In the `state = { ... }` object (~line 9), add a `projects: []` field. Replace:

```js
const state = {
  ws: null,
  wsReady: false,
  runId: null, // currently-tracked run
  projectDir: '',
  pendingQuestion: null, // last unanswered question {id, kind, ...}
  status: 'idle',
};
```

with:

```js
const state = {
  ws: null,
  wsReady: false,
  runId: null, // currently-tracked run
  projectDir: '',
  projects: [], // saved {name, path, exists} registry, loaded from /api/projects
  pendingQuestion: null, // last unanswered question {id, kind, ...}
  status: 'idle',
};
```

- [ ] **Step 7: Replace the old projectDir change handler with the project module**

Replace this block (currently ~lines 624-630):

```js
el.projectDir.addEventListener('change', () => {
  const dir = el.projectDir.value.trim();
  if (dir) {
    state.projectDir = dir;
    loadHistory(dir);
  }
});
```

with:

```js
// ---------------------------------------------------------------------------
// Project registry: dropdown + inline add-form + delete.
// ---------------------------------------------------------------------------
const LAST_PROJECT_KEY = 'maestro.lastProject';

function selectedProjectPath() {
  const v = el.projectSelect.value;
  return !v || v === '__add__' ? '' : v;
}

function selectedProjectName() {
  const opt = el.projectSelect.selectedOptions && el.projectSelect.selectedOptions[0];
  return opt && opt.dataset ? opt.dataset.name || '' : '';
}

async function loadProjects(selectName) {
  try {
    const res = await fetch('/api/projects');
    const data = await safeJson(res);
    state.projects = data && Array.isArray(data.projects) ? data.projects : [];
  } catch {
    state.projects = [];
  }
  renderProjectOptions(selectName);
}

function renderProjectOptions(selectName) {
  const want = selectName || localStorage.getItem(LAST_PROJECT_KEY) || '';
  el.projectSelect.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.disabled = true;
  placeholder.textContent = state.projects.length ? 'Select a project…' : 'No projects yet';
  el.projectSelect.appendChild(placeholder);

  state.projects.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.path;
    opt.dataset.name = p.name;
    opt.textContent = p.exists ? p.name : `${p.name} (missing)`;
    el.projectSelect.appendChild(opt);
  });

  const add = document.createElement('option');
  add.value = '__add__';
  add.textContent = '+ Add project…';
  el.projectSelect.appendChild(add);

  // Restore by index (not value) so duplicate paths can't pick the wrong name.
  const idx = state.projects.findIndex((p) => p.name === want);
  if (idx >= 0) el.projectSelect.selectedIndex = idx + 1; // +1 past the placeholder
  else placeholder.selected = true;

  onProjectChanged();
}

function onProjectChanged() {
  const path = selectedProjectPath();
  el.projectDelete.disabled = !path;
  if (path) {
    state.projectDir = path;
    localStorage.setItem(LAST_PROJECT_KEY, selectedProjectName());
    loadHistory(path);
  } else {
    state.projectDir = '';
  }
}

el.projectSelect.addEventListener('change', () => {
  if (el.projectSelect.value === '__add__') {
    openAddProject();
    return;
  }
  hideAddProject();
  onProjectChanged();
});

function openAddProject() {
  el.addProject.classList.remove('hidden');
  el.newProjectName.value = '';
  el.newProjectPath.value = '';
  setAddMsg('');
  el.newProjectName.focus();
}

function hideAddProject() {
  el.addProject.classList.add('hidden');
}

function setAddMsg(text, kind) {
  el.addProjectMsg.textContent = text || '';
  el.addProjectMsg.className = 'hint' + (kind ? ' ' + kind : '');
}

el.addProjectCancel.addEventListener('click', () => {
  hideAddProject();
  renderProjectOptions(localStorage.getItem(LAST_PROJECT_KEY) || '');
});

el.addProjectSave.addEventListener('click', async () => {
  const name = el.newProjectName.value.trim();
  const projPath = el.newProjectPath.value.trim();
  if (!name) return setAddMsg('Name is required.', 'err');
  if (!projPath) return setAddMsg('Path is required.', 'err');
  el.addProjectSave.disabled = true;
  try {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, path: projPath }),
    });
    const data = await safeJson(res);
    if (!res.ok) {
      setAddMsg(data.error || `HTTP ${res.status}`, 'err');
      return;
    }
    state.projects = Array.isArray(data.projects) ? data.projects : state.projects;
    hideAddProject();
    renderProjectOptions(name); // auto-select the newly added project
  } catch (e) {
    setAddMsg(e.message, 'err');
  } finally {
    el.addProjectSave.disabled = false;
  }
});

el.projectDelete.addEventListener('click', async () => {
  const name = selectedProjectName();
  if (!name) return;
  if (!confirm(`Remove "${name}" from the project list? Files on disk are not touched.`)) return;
  el.projectDelete.disabled = true;
  try {
    const res = await fetch(`/api/projects?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    const data = await safeJson(res);
    if (!res.ok) {
      setFormMsg(`Delete failed: ${data.error || res.status}`, 'err');
      el.projectDelete.disabled = false;
      return;
    }
    state.projects = Array.isArray(data.projects) ? data.projects : [];
    if (localStorage.getItem(LAST_PROJECT_KEY) === name) localStorage.removeItem(LAST_PROJECT_KEY);
    state.projectDir = '';
    el.history.innerHTML = '<li class="empty">Select a project to load history.</li>';
    renderProjectOptions('');
  } catch (e) {
    setFormMsg(`Delete error: ${e.message}`, 'err');
    el.projectDelete.disabled = false;
  }
});
```

- [ ] **Step 8: Feed the selected path into submit**

In the form submit handler, replace (currently ~lines 639-640):

```js
  const projectDir = el.projectDir.value.trim();
  if (!projectDir) return setFormMsg('Project folder is required.', 'err');
```

with:

```js
  const projectDir = selectedProjectPath();
  if (!projectDir) return setFormMsg('Select a project first (or add one).', 'err');
```

- [ ] **Step 9: Feed the selected path into install**

In the install button handler, replace (currently ~lines 765-766):

```js
  const projectDir = el.projectDir.value.trim();
  if (!projectDir) return setFormMsg('Enter the project folder first.', 'err');
```

with:

```js
  const projectDir = selectedProjectPath();
  if (!projectDir) return setFormMsg('Select a project first.', 'err');
```

- [ ] **Step 10: Feed the selected path into Refresh-history**

In the refresh-history click handler, replace (currently ~lines 800-802):

```js
  const dir = el.projectDir.value.trim();
  if (dir) loadHistory(dir);
  else setFormMsg('Enter the project folder to load history.', 'err');
```

with:

```js
  const dir = selectedProjectPath();
  if (dir) loadHistory(dir);
  else setFormMsg('Select a project to load history.', 'err');
```

- [ ] **Step 11: Load projects on boot**

In the boot section at the bottom, replace (currently ~lines 909-912):

```js
syncSourceToggle();
setWsStatus(false);
setRunStatus('idle');
connectWS();
```

with:

```js
syncSourceToggle();
setWsStatus(false);
setRunStatus('idle');
loadProjects();
connectWS();
```

- [ ] **Step 12: Append styles to `style.css`**

Append to the end of `ui/public/style.css`:

```css
/* Project selector + inline add-form */
.project-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.project-row select {
  flex: 1 1 auto;
  min-width: 0;
}
.add-project {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--border, #d0d7de);
  border-radius: 8px;
  background: var(--bg-code, #f6f8fa);
}
.add-project.hidden {
  display: none;
}
.add-project-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.hint.err {
  color: var(--bad, #f85149);
}
```

- [ ] **Step 13: Run the UI wiring test to verify it passes**

Run: `node --test test/projects-ui.test.mjs`
Expected: PASS — all three tests pass.

- [ ] **Step 14: Run the full suite**

Run: `npm test`
Expected: PASS — every test file green.

- [ ] **Step 15: Manual smoke of the real UI**

```bash
MAESTRO_HOME="$(mktemp -d)" node ui/server.mjs
```

Then in a browser at `http://localhost:4317`:
1. Dropdown shows "No projects yet" + "+ Add project…".
2. Pick "+ Add project…" → form appears → enter a name + an absolute path to a real folder → Save → it is auto-selected, history loads, delete (✕) enables.
3. Reload the page → the same project is auto-selected (localStorage).
4. Add a second project with a non-existent path → it shows "(missing)".
5. Add a duplicate name → inline error "a project named … already exists".
6. Delete a project (✕) → confirm → it leaves the dropdown.
7. Start a run on a selected project → pipeline begins as before.

Stop the server with Ctrl-C.

- [ ] **Step 16: Commit**

```bash
git add ui/public/index.html ui/public/app.js ui/public/style.css test/projects-ui.test.mjs
git commit -m "feat: project dropdown with add/select/delete in the web UI"
```

---

## Done criteria

- `npm test` is green (clarify, ui-theme, projects, projects-api, projects-ui).
- `npm run smoke` still passes (CLI path untouched).
- The web UI has no free-text project-path field; projects are chosen from a dropdown, added with name+path, persisted to `~/.maestro/projects.json`, and deletable.
- The last-selected project is restored on reload.
```
