import express from 'express';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOnboarding, readFinalReadiness, ENABLE_TITLE } from '../../src/core/onboarding.mjs';
import { listAllPipelines, reconcileStaleRunning } from '../../src/core/artifacts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROJECTS_ROOT = process.env.MAESTRO_ENABLE_PROJECTS_ROOT || process.cwd();
const PORT = Number(process.env.PORT) || 4319;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.use(express.json({ limit: '2mb' }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const runs = new Map();           // runId -> { orch, events, done, status, buffer[] }
const sockets = new Set();
const EVENTS = ['state', 'phase', 'question', 'artifact', 'log', 'done', 'error', 'readiness'];

// sockets that subscribed with ?runId= only receive that run's frames;
// sockets without a runId keep receiving everything (debug firehose).
function broadcast(obj) {
  const text = JSON.stringify(obj);
  for (const ws of sockets) {
    if (ws.readyState !== ws.OPEN) continue;
    if (ws.enableRunId && obj.runId && ws.enableRunId !== obj.runId) continue;
    try { ws.send(text); } catch {}
  }
}

wss.on('connection', (ws, req) => {
  sockets.add(ws);
  ws.on('close', () => sockets.delete(ws));
  const runId = new URL(req.url, 'http://x').searchParams.get('runId');
  ws.enableRunId = runId || null;
  const entry = runId && runs.get(runId);
  ws.send(JSON.stringify({ type: 'hello', runId: runId || null }));
  if (entry) for (const e of entry.buffer) { try { ws.send(JSON.stringify(e)); } catch {} } // replay
});

// list candidate projects = immediate subdirs of PROJECTS_ROOT that are git repos
app.get('/api/enable/projects', (_req, res) => {
  let dirs = [];
  try {
    dirs = readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(path.join(PROJECTS_ROOT, d.name, '.git')))
      .map((d) => ({ name: d.name, path: path.join(PROJECTS_ROOT, d.name) }));
  } catch {}
  res.json({ root: PROJECTS_ROOT, projects: dirs });
});

// directory picker: list immediate sub-folders of `dir` (defaults to home) so the
// UI can browse to an absolute project path. Dirs only; git repos are flagged.
app.get('/api/enable/browse', (req, res) => {
  const raw = typeof req.query.dir === 'string' && req.query.dir ? req.query.dir : os.homedir();
  const dir = path.resolve(raw);
  let ents;
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory');
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return res.status(400).json({ error: `cannot read ${dir}` });
  }
  const entries = ents
    .filter((d) => { try { return d.isDirectory(); } catch { return false; } })
    .map((d) => ({ name: d.name, path: path.join(dir, d.name),
      isGit: existsSync(path.join(dir, d.name, '.git')) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(dir);
  res.json({ dir, parent: parent === dir ? null : parent, entries });
});

// list local git branches of `dir` so the UI can pick a source branch to base off.
app.get('/api/enable/branches', (req, res) => {
  const dir = typeof req.query.dir === 'string' && req.query.dir ? path.resolve(req.query.dir) : '';
  if (!dir) return res.status(400).json({ error: 'dir required' });
  try {
    const out = execFileSync('git', ['-C', dir, 'branch', '--format=%(refname:short)'], { encoding: 'utf8' });
    const branches = out.split('\n').map((s) => s.trim()).filter(Boolean);
    let current = '';
    try { current = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
    res.json({ branches, current });
  } catch {
    return res.status(400).json({ error: `not a git repo: ${dir}` });
  }
});

app.post('/api/enable/run', async (req, res) => {
  const { projectDir, answers, mock, sourceBranch } = req.body || {};
  if (!projectDir) return res.status(400).json({ error: 'projectDir required' });
  try {
    const branch = sourceBranch ? { source: sourceBranch, feature: null } : undefined;
    const { runId, events, done, orch } = await runOnboarding({ projectDir, answers: answers || {}, mock: !!mock, branch });
    const entry = { orch, events, done, status: 'running', buffer: [] };  // store orch (D8)
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
    res.json({ runId });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// what the run changed: evaluator's results.json + the raw diff, both written
// into the pipeline dir. Either may be absent (mid-run, mock) -> null fields.
function readChanges(dir) {
  const r = readJsonSafe(path.join(dir, 'results.json'));
  let patch = null;
  try { patch = readFileSync(path.join(dir, 'diff-patch.patch'), 'utf8'); } catch {}
  return {
    summary: r?.summary ?? null,
    newFiles: r?.newFiles ?? [],
    changedFiles: r?.changedFiles ?? [],
    nitpicks: r?.nitpicks ?? [],
    patch,
  };
}

app.get('/api/enable/runs/:runId/changes', (req, res) => {
  const entry = runs.get(req.params.runId);
  const dir = entry?.orch?.getState()?.pipelineDir;
  if (!entry || !dir) return res.status(404).json({ error: 'unknown runId' });
  res.json(readChanges(dir));
});

// Full post-run content of a file the run touched. The worktree is torn down when
// a run ends (branch is kept), so we resolve the content from the feature branch
// via `git show <ref>:<path>` rather than reading disk. Returns null on any failure.
function gitShowFile(repoDir, ref, relPath) {
  if (!repoDir || !ref || !relPath) return null;
  try {
    return execFileSync('git', ['-C', repoDir, 'show', `${ref}:${relPath}`],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch { return null; }
}

// The paths a run actually changed — the allowlist for the file route so a crafted
// ?path= (traversal, absolute, or an untouched file) can only ever read run output.
function changedPathSet(changes) {
  return new Set([...(changes.newFiles || []), ...(changes.changedFiles || [])].map((f) => f.path));
}

// Preview a single changed file's full content (used by the results-screen .md
// preview). Path must be one this run changed; content comes off the feature branch.
app.get('/api/enable/runs/:runId/file', (req, res) => {
  const entry = runs.get(req.params.runId);
  const state = entry?.orch?.getState();
  const dir = state?.pipelineDir;
  if (!entry || !dir) return res.status(404).json({ error: 'unknown runId' });
  const rel = typeof req.query.path === 'string' ? req.query.path : '';
  if (!changedPathSet(readChanges(dir)).has(rel)) return res.status(404).json({ error: 'not a changed file' });
  const content = gitShowFile(state.projectDir, state.branch?.feature, rel);
  if (content == null) return res.status(404).json({ error: 'content unavailable' });
  res.json({ path: rel, content });
});

// An onboarding-specific artifact only the wf_onboarding evaluator writes. Its
// presence marks a run as an Enable run regardless of title, so real runs from
// before the title was pinned (model-generated titles like "Enable AI Integration")
// still surface in history instead of being dropped by an exact-title filter.
const ENABLE_SIGNATURE = 'onboardingEvaluator-review-cycle1.json';

function isEnableRun(p) {
  if (p.title === ENABLE_TITLE) return true;
  if (!p.dir) return false;
  return existsSync(path.join(p.dir, ENABLE_SIGNATURE)) || existsSync(path.join(p.dir, 'readiness.json'));
}

// Heuristic mock/dry-run flag: no stored flag exists on old rows, but a real
// onboarding run always costs money and takes minutes, so $0 + sub-5s active time
// is unambiguously a mock. Guards a "dry run" label so blank-score rows read clearly.
function looksMock(p) {
  return (!p.totalCostUsd) && p.totalActiveMs != null && p.totalActiveMs < 5000;
}

// past Enable runs, newest first. Includes pinned-title runs AND any run carrying
// the onboarding artifact signature. Each entry carries its final readiness (null
// while unwritten) and a mock flag so the list can label dry runs vs real scores.
async function enableHistory() {
  const all = await listAllPipelines();
  return all.filter(isEnableRun)
    .map((p) => ({ ...p, readiness: p.dir ? readFinalReadiness(p.dir) : null, mock: looksMock(p) }));
}

// Flip crashed/killed runs (dead owner pid or a stale heartbeat) from a stuck
// "running" to "interrupted" so the history list stops implying they're live. Runs
// this server still owns are protected by liveIds; the reaper also skips any row
// whose pid is genuinely alive. Best-effort — never let housekeeping fail the list.
function reapOrphans() {
  const liveIds = [...runs.values()]
    .map((e) => { try { return e.orch?.getState()?.id; } catch { return null; } })
    .filter(Boolean);
  try { return reconcileStaleRunning({ liveIds }); } catch { return { reconciled: 0, ids: [] }; }
}

app.get('/api/enable/history', async (_req, res) => {
  try { reapOrphans(); res.json({ runs: await enableHistory() }); }
  catch (err) { res.status(500).json({ error: String(err && err.message || err) }); }
});

app.get('/api/enable/history/:id', async (req, res) => {
  try {
    const entry = (await enableHistory()).find((p) => p.id === req.params.id);
    if (!entry || !entry.dir) return res.status(404).json({ error: 'unknown run' });
    res.json({ entry, readiness: entry.readiness, changes: readChanges(entry.dir) });
  } catch (err) { res.status(500).json({ error: String(err && err.message || err) }); }
});

// Disk-backed twin of the live file route: preview a changed file from a past run,
// again off its kept feature branch. Same changed-file allowlist guard.
app.get('/api/enable/history/:id/file', async (req, res) => {
  try {
    const entry = (await enableHistory()).find((p) => p.id === req.params.id);
    if (!entry || !entry.dir) return res.status(404).json({ error: 'unknown run' });
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    if (!changedPathSet(readChanges(entry.dir)).has(rel)) return res.status(404).json({ error: 'not a changed file' });
    const content = gitShowFile(entry.projectDir, entry.branch, rel);
    if (content == null) return res.status(404).json({ error: 'content unavailable' });
    res.json({ path: rel, content });
  } catch (err) { res.status(500).json({ error: String(err && err.message || err) }); }
});

// kept for completeness/future interactive gates; happy path answers up front (D8)
app.post('/api/enable/answer', (req, res) => {
  const { runId, id, payload } = req.body || {};
  const entry = runId && runs.get(runId);
  if (!entry) return res.status(400).json({ error: 'unknown runId' });
  try { entry.orch?.answer(id, payload); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: String(err && err.message || err) }); }
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) server.listen(PORT, HOST, () => console.log(`[enable] http://${HOST}:${PORT}`));
export { app, server, runs };
