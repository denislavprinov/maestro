import express from 'express';
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOnboarding, resumeOnboarding, readFinalReadiness, ENABLE_TITLE } from '../../src/core/onboarding.mjs';
import { listAllPipelines, reconcileStaleRunning } from '../../src/core/artifacts.mjs';
import { estimateCost } from '../../src/core/costEstimate.mjs';
import { deletePipeline } from '../../src/core/pipeline-delete.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROJECTS_ROOT = process.env.MAESTRO_ENABLE_PROJECTS_ROOT || process.cwd();
const PORT = Number(process.env.PORT) || 4319;
const HOST = process.env.HOST || '127.0.0.1';

// Per-boot session token, issued as a SameSite=Strict HttpOnly cookie with the
// UI and required on /api/* and the WS handshake. This shields the localhost
// server from cross-origin browser pages (they can neither read nor send the
// cookie); it is NOT a defense against other processes of the same OS user.
const AUTH_TOKEN = process.env.ENABLE_AUTH_TOKEN || randomBytes(32).toString('hex');

function hasAuthCookie(req) {
  const m = /(?:^|;\s*)enable_auth=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const got = Buffer.from(m[1]);
  const want = Buffer.from(AUTH_TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api', (req, res, next) => {
  if (hasAuthCookie(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
});
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws' || !hasAuthCookie(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

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

// Cheap repo-size probe for the pre-run cost estimate. LOC is approximated from
// tracked-file byte totals (statSync only — no content reads, so it stays fast on
// big repos); ~40 bytes/line. A graphify-out/graph.json node count, when present,
// overrides LOC as the size signal (better proxy for how much the agents read).
const SIZE_SKIP = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|woff2?|ttf|eot|mp4|mov|lock|min\.js)$/i;
function probeRepoSize(dir) {
  let fileCount = 0, bytes = 0, graphNodes = null;
  try {
    const out = execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    for (const rel of out.split('\n')) {
      if (!rel || SIZE_SKIP.test(rel)) continue;
      try { bytes += statSync(path.join(dir, rel)).size; fileCount += 1; } catch {}
    }
  } catch {}
  try {
    const g = readJsonSafe(path.join(dir, 'graphify-out', 'graph.json'));
    if (g && Array.isArray(g.nodes) && g.nodes.length) graphNodes = g.nodes.length;
  } catch {}
  return { fileCount, loc: Math.round(bytes / 40), graphNodes };
}

app.get('/api/enable/estimate', (req, res) => {
  const dir = typeof req.query.dir === 'string' && req.query.dir ? path.resolve(req.query.dir) : '';
  if (!dir) return res.status(400).json({ error: 'dir required' });
  try {
    const multi = typeof req.query.multiTool === 'string' && req.query.multiTool
      ? req.query.multiTool.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const answers = {
      testTier: req.query.testTier, vendoringDepth: req.query.vendoringDepth,
      canary: req.query.canary, multiToolTargets: multi,
    };
    const basis = probeRepoSize(dir);
    res.json({ ...estimateCost({ ...basis, answers }), basisRaw: basis });
  } catch (err) {
    res.status(400).json({ error: String(err && err.message || err) });
  }
});

// register a live run handle (fresh or resumed): buffer + broadcast its events,
// mirror the final status onto the entry. Shared by /run and /resume. The
// explicit pipelineId (resume handles carry it) makes the entry identifiable
// BEFORE the engine starts — orch.getState().id is unset until dispatch begins.
function registerRun(runId, { orch, events, done, pipelineId = null }) {
  const entry = { orch, events, done, pipelineId, status: 'running', buffer: [] };
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
      .catch((err) => {
        entry.status = 'error';
        const frame = { type: 'error', runId, message: String(err && err.message || err) };
        entry.buffer.push(frame);
        broadcast(frame);
      });
  return entry;
}

app.post('/api/enable/run', async (req, res) => {
  const { projectDir, answers, mock, sourceBranch, interactive } = req.body || {};
  if (!projectDir) return res.status(400).json({ error: 'projectDir required' });
  try {
    const branch = sourceBranch ? { source: sourceBranch, feature: null } : undefined;
    const handle = await runOnboarding({
      projectDir, answers: answers || {}, mock: !!mock, interactive: !!interactive, branch });
    registerRun(handle.runId, handle);
    res.json({ runId: handle.runId });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

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
  for (const [id, e] of runs) {
    if ((e.pipelineId ?? e.orch?.getState?.()?.id) === pipelineId &&
        !['done', 'stopped', 'error', 'paused', 'interrupted'].includes(String(e.status || ''))) {
      // liveRunId lets the client rejoin the stream that is already driving
      // this pipeline (double-click, second tab, refresh) instead of erroring
      // over a perfectly healthy run. Claim placeholders are not joinable.
      const joinable = e.buffer && e.events ? id : null;
      return res.status(409).json({ error: 'pipeline is already live', ...(joinable ? { liveRunId: joinable } : {}) });
    }
  }
  // Synchronous claim BEFORE the first await: a concurrent /resume for the same
  // pipeline hits the live-guard above via this placeholder and 409s instead of
  // double-resuming. Released in finally — by then registerRun has the real entry
  // (tagged with pipelineId, so the guard keeps matching after the claim drops).
  const claimId = `resuming:${pipelineId}`;
  runs.set(claimId, { status: 'running', pipelineId, buffer: [] });
  try {
    // mock passes through only as an explicit boolean — otherwise the core
    // infers the run's own mode from its step sessions (a stale UI toggle must
    // never flip a real run to mock or a mock run to real spend).
    const handle = await resumeOnboarding({
      pipelineId, interactive: !!interactive,
      mock: typeof mock === 'boolean' ? mock : undefined,
    });
    // evict the superseded paused/interrupted lineage so it can't resurface as
    // a phantom paused card next to the resumed run.
    for (const [id, e] of runs) {
      if (id !== claimId && (e.pipelineId ?? e.orch?.getState?.()?.id) === pipelineId &&
          ['paused', 'interrupted'].includes(String(e.status || ''))) runs.delete(id);
    }
    registerRun(handle.runId, handle);
    res.json({ runId: handle.runId, pipelineId });
  } catch (err) {
    const status = err && err.code === 'NOT_FOUND' ? 404 : 400;
    res.status(status).json({ error: String(err && err.message || err) });
  } finally {
    runs.delete(claimId);
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

// past Enable runs, newest first (filtered on the pinned run title). Each entry
// carries its final readiness (null while unwritten) so the list can show scores.
// Runs with no recorded spend (mock / test runs report $0) get an estimatedCost so
// the list never reads as "free" — real spend, when present, always wins in the UI.
async function enableHistory() {
  // flip orphaned 'running' rows (crashed server) to 'interrupted' so they
  // become resumable; live local runs are shielded via liveIds.
  try {
    reconcileStaleRunning({
      liveIds: [...runs.values()].map((r) => r.pipelineId ?? r.orch?.getState?.()?.id).filter(Boolean),
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

app.get('/api/enable/history', async (_req, res) => {
  try { res.json({ runs: await enableHistory() }); }
  catch (err) { res.status(500).json({ error: String(err && err.message || err) }); }
});

app.get('/api/enable/history/:id', async (req, res) => {
  try {
    const entry = (await enableHistory()).find((p) => p.id === req.params.id);
    if (!entry || !entry.dir) return res.status(404).json({ error: 'unknown run' });
    res.json({ entry, readiness: entry.readiness, changes: readChanges(entry.dir) });
  } catch (err) { res.status(500).json({ error: String(err && err.message || err) }); }
});

// remove a past run everywhere: store dir, shared plan/review markdown, local
// branch + worktree (engine deletePipeline; refuses runs still marked running).
app.delete('/api/enable/history/:id', async (req, res) => {
  try {
    const entry = (await enableHistory()).find((p) => p.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'unknown run' });
    const liveHere = [...runs.values()].some((r) =>
      r.status === 'running' && r.orch?.getState()?.pipelineDir === entry.dir);
    if (liveHere) return res.status(409).json({ error: 'cannot delete a running run' });
    const report = await deletePipeline({ key: entry.projectKey, id: entry.id });
    if (!report) return res.status(404).json({ error: 'unknown run' });
    res.json({ ok: true, ...report });
  } catch (err) {
    if (err && err.code === 'RUNNING') return res.status(409).json({ error: err.message });
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

// answers an interactive gate/recovery question (and stays usable for any
// future ask). On success a question-answered frame is buffered + broadcast so
// replaying clients (page refresh, second tab) drop the stale question card.
app.post('/api/enable/answer', (req, res) => {
  const { runId, id, payload } = req.body || {};
  const entry = runId && runs.get(runId);
  if (!entry) return res.status(400).json({ error: 'unknown runId' });
  try {
    entry.orch?.answer(id, payload);
    const frame = { type: 'question-answered', id, runId };
    entry.buffer.push(frame);
    broadcast(frame);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: String(err && err.message || err) }); }
});

app.use((req, res, next) => {   // static UI responses carry the session cookie
  res.setHeader('Set-Cookie', `enable_auth=${AUTH_TOKEN}; Path=/; SameSite=Strict; HttpOnly`);
  next();
}, express.static(PUBLIC_DIR, { extensions: ['html'] }));

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) server.listen(PORT, HOST, () => console.log(`[enable] http://${HOST}:${PORT}`));
export { app, server, runs };
