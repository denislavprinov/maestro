import express from 'express';
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOnboarding, readFinalReadiness, ENABLE_TITLE } from '../../src/core/onboarding.mjs';
import { listAllPipelines } from '../../src/core/artifacts.mjs';

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

app.post('/api/enable/run', async (req, res) => {
  const { projectDir, answers, mock, interactive } = req.body || {};
  if (!projectDir) return res.status(400).json({ error: 'projectDir required' });
  try {
    const { runId, events, done, orch } = await runOnboarding({
      projectDir, answers: answers || {}, mock: !!mock, interactive: !!interactive });
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

// past Enable runs, newest first (filtered on the pinned run title). Each entry
// carries its final readiness (null while unwritten) so the list can show scores.
async function enableHistory() {
  const all = await listAllPipelines();
  return all.filter((p) => p.title === ENABLE_TITLE)
    .map((p) => ({ ...p, readiness: p.dir ? readFinalReadiness(p.dir) : null }));
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
