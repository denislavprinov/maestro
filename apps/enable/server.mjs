import express from 'express';
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { readdirSync, existsSync, readFileSync, statSync, writeFileSync, cpSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOnboarding, resumeOnboarding, readFinalReadiness, readToolsReport, readTasksReport, ENABLE_TITLE } from '../../src/core/onboarding.mjs';
import { listAllPipelines, reconcileStaleRunning } from '../../src/core/artifacts.mjs';
import { estimateCost } from '../../src/core/costEstimate.mjs';
import { deletePipeline } from '../../src/core/pipeline-delete.mjs';
import { listWorkspaces, readWorkspace, isGitRepo, WORKSPACE_KEY_RE } from '../../src/core/workspaces.mjs';
import { projectKey } from '../../src/core/store.mjs';
import { buildWorkspaceMembers } from '../../ui/server.mjs';
import { CURATED_ALLOWLIST, vendorDestinations } from '../../src/core/skill-vendor.mjs';
import { resolveSkill } from '../../src/core/skills.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROJECTS_ROOT = process.env.MAESTRO_ENABLE_PROJECTS_ROOT || process.cwd();
const PORT = Number(process.env.PORT) || 4319;
const HOST = process.env.HOST || '127.0.0.1';
const REPO_ROOT = path.join(__dirname, '../..');
// tests point this at a throwaway home so skill resolution is deterministic
const SKILLS_HOME = process.env.ENABLE_SKILLS_HOME || os.homedir();

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

// list saved workspaces so the UI can offer them as a run target alongside
// single projects. Thin passthrough — no PROJECTS_ROOT scoping (a workspace's
// members can live anywhere; the registry itself is the source of truth).
app.get('/api/enable/workspaces', async (_req, res) => {
  try { res.json({ workspaces: await listWorkspaces() }); }
  catch (err) { res.status(500).json({ error: String(err && err.message || err) }); }
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
  const { projectDir, workspaceId, answers, mock, sourceBranch, interactive } = req.body || {};
  const hasWorkspace = typeof workspaceId === 'string' && workspaceId.trim();
  const hasProjectDir = typeof projectDir === 'string' && projectDir.trim();
  if (hasWorkspace && hasProjectDir) {
    return res.status(400).json({ error: 'provide workspaceId or projectDir, not both' });
  }
  if (!hasWorkspace && !hasProjectDir) {
    return res.status(400).json({ error: 'projectDir or workspaceId required' });
  }
  try {
    const sharedBranch = sourceBranch ? { source: sourceBranch, feature: null } : { source: null, feature: null };
    let handle;
    if (hasWorkspace) {
      const id = workspaceId.trim();
      if (!WORKSPACE_KEY_RE.test(id)) return res.status(404).json({ error: 'workspace not found' });
      const wsEntry = await readWorkspace(id);
      if (!wsEntry) return res.status(404).json({ error: 'workspace not found' });

      // Every member must be an existing git repo (D3: per-project worktrees) —
      // a workspace run is defined over its full set, no skip-missing (mirrors
      // ui/server.mjs's /api/run workspace arm).
      const projects = [];
      for (const dir of wsEntry.projectPaths) {
        if (!existsSync(dir)) return res.status(400).json({ error: 'workspace member path is missing' });
        if (!isGitRepo(dir)) return res.status(400).json({ error: `workspace member is not a git repository: ${dir}` });
        projects.push({ projectDir: dir, projectKey: projectKey(dir), projectName: path.basename(dir) });
      }
      projects.sort((a, b) => (a.projectKey < b.projectKey ? -1 : a.projectKey > b.projectKey ? 1 : 0));

      if (sharedBranch.source && sharedBranch.source.startsWith('-')) {
        return res.status(400).json({ error: `unknown or invalid sourceBranch: ${sharedBranch.source}` });
      }

      handle = await runOnboarding({
        workspace: {
          id: wsEntry.id, key: wsEntry.id, name: wsEntry.name, description: wsEntry.description,
          // No per-member override UI in Enable (out of scope, see plan header) — every
          // member gets the one shared sourceBranch, same as buildWorkspaceMembers(..., {}).
          projects: buildWorkspaceMembers(projects, sharedBranch, {}),
        },
        answers: answers || {}, mock: !!mock, interactive: !!interactive, branch: sharedBranch,
      });
    } else {
      const branch = sourceBranch ? sharedBranch : undefined;
      handle = await runOnboarding({
        projectDir, answers: answers || {}, mock: !!mock, interactive: !!interactive, branch });
    }
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
  // pipelineId -> joinable live runId, so a second client can rejoin the
  // stream that is already driving a pipeline instead of a mid-run disk view.
  // Same joinability rule as /resume's live-guard: buffer + events present,
  // status not terminal (claim placeholders and finished entries don't count).
  const liveByPipeline = new Map();
  for (const [id, e] of runs) {
    const pid = e.pipelineId ?? e.orch?.getState?.()?.id;
    if (pid && e.buffer && e.events &&
        !['done', 'stopped', 'error', 'paused', 'interrupted'].includes(String(e.status || ''))) {
      liveByPipeline.set(pid, id);
    }
  }
  const all = await listAllPipelines();
  return all.filter((p) => p.title === ENABLE_TITLE)
    .map((p) => {
      const readiness = p.dir ? readFinalReadiness(p.dir) : null;
      let estimatedCost = null;
      if (!(p.totalCostUsd > 0) && p.projectDir && existsSync(p.projectDir)) {
        try { estimatedCost = estimateCost(probeRepoSize(p.projectDir)); } catch {}
      }
      const resumable = (p.status === 'paused' || p.status === 'interrupted') && !!p.hasResumePoint;
      return { ...p, readiness, estimatedCost, resumable, liveRunId: liveByPipeline.get(p.id) ?? null };
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
    res.json({
      entry, readiness: entry.readiness, changes: readChanges(entry.dir),
      tools: readToolsReport(entry.dir), tasks: readTasksReport(entry.dir),
    });
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

// answers an interactive gate/recovery question (and stays usable for any
// future ask). On success a question-answered frame is buffered + broadcast so
// replaying clients (page refresh, second tab) drop the stale question card.
// kept for completeness/future interactive gates; happy path answers up front (D8)
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

// turn "Still worth doing" gaps into checkbox tasks in the project's TODO.md.
// Items already present (checked or not) are skipped so re-clicking is a no-op.
app.post('/api/enable/todo', (req, res) => {
  const { dir: rawDir, gaps } = req.body || {};
  if (typeof rawDir !== 'string' || !rawDir) return res.status(400).json({ error: 'dir required' });
  if (!Array.isArray(gaps) || gaps.length === 0 || gaps.some((g) => typeof g !== 'string' || !g.trim()))
    return res.status(400).json({ error: 'gaps must be a non-empty array of strings' });
  // accept either an absolute project path or a bare project name under PROJECTS_ROOT
  // (history entries sometimes only carry the name)
  const dir = path.isAbsolute(rawDir) ? rawDir : resolveProjectDir(rawDir);
  if (!dir) return res.status(400).json({ error: `unknown project: ${rawDir}` });
  try { if (!statSync(dir).isDirectory()) throw new Error('not a directory'); }
  catch { return res.status(400).json({ error: `not a directory: ${dir}` }); }

  const file = path.join(dir, 'TODO.md');
  let existing = '';
  try { existing = readFileSync(file, 'utf8'); } catch {}
  const have = new Set(existing.split('\n')
    .map((l) => { const m = l.match(/^- \[[ xX]\] (.*)$/); return m && m[1].trim(); })
    .filter(Boolean));
  const fresh = [...new Set(gaps.map((g) => g.trim()))].filter((g) => !have.has(g));
  if (fresh.length === 0) return res.json({ written: 0, skipped: gaps.length, path: file });

  const date = new Date().toISOString().slice(0, 10);
  const section = `## Enable — still worth doing (${date})\n\n${fresh.map((g) => `- [ ] ${g}`).join('\n')}\n`;
  const text = existing ? `${existing.replace(/\n*$/, '\n\n')}${section}` : section;
  try { writeFileSync(file, text); }
  catch (err) { return res.status(500).json({ error: String(err && err.message || err) }); }
  res.json({ written: fresh.length, skipped: gaps.length - fresh.length, path: file });
});

// Resolve `p` through the filesystem, not just lexically: walk up to the
// deepest EXISTING ancestor, realpath *that* (so a symlinked ancestor —
// e.g. a project's .claude pointed at the user-global ~/.claude — resolves
// to its real target), then re-append the non-existing suffix untouched.
// Falls back to the lexical path for any ancestor that can't be realpath'd
// (e.g. doesn't exist at all, permission error).
function resolveRealish(p) {
  let cur = path.resolve(p);
  const suffix = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break; // reached filesystem root without finding anything real
    suffix.unshift(path.basename(cur));
    cur = parent;
  }
  try {
    const real = realpathSync(cur);
    return suffix.length ? path.join(real, ...suffix) : real;
  } catch {
    return suffix.length ? path.join(cur, ...suffix) : cur;
  }
}

// vendor one suggested skill into the project's .claude/skills/ (results-screen
// "Add" button). SECURITY: curated-allowlist MEMBERSHIP is the gate — an arbitrary
// name is rejected before any disk probe, so this can never copy a personal skill.
// Writes to the project's CURRENT working tree (a user-initiated post-run action),
// not the enable branch.
app.post('/api/enable/vendor', (req, res) => {
  const { dir: rawDir, name } = req.body || {};
  if (typeof name !== 'string' || !CURATED_ALLOWLIST.includes(name)) {
    return res.status(400).json({ error: 'skill is not on the curated allowlist' });
  }
  if (typeof rawDir !== 'string' || !rawDir) return res.status(400).json({ error: 'dir required' });
  const dir = path.isAbsolute(rawDir) ? rawDir : resolveProjectDir(rawDir);
  if (!dir) return res.status(400).json({ error: `unknown project: ${rawDir}` });
  try { if (!statSync(dir).isDirectory()) throw new Error('not a directory'); }
  catch { return res.status(400).json({ error: `not a directory: ${dir}` }); }

  const destinations = vendorDestinations(dir);
  const globalClaude = path.join(os.homedir(), '.claude');
  const resolvedGlobal = existsSync(globalClaude) ? resolveRealish(globalClaude) : globalClaude;
  const targets = [];
  for (const rel of destinations) {
    const target = path.join(dir, ...rel.split('/'), name);
    // Resolve through the filesystem so a symlinked ancestor (.claude, .cursor,
    // .agents, or their skills/ subdir pointed at ~/.claude) can't lexically
    // dodge the prefix check while landing writes inside the real global dir.
    const resolvedTarget = resolveRealish(target);
    if (resolvedTarget === resolvedGlobal || resolvedTarget.startsWith(resolvedGlobal + path.sep)) {
      return res.status(400).json({ error: 'refusing to vendor into the user-global ~/.claude' });
    }
    targets.push({ rel, target });
  }
  const missing = targets.filter((t) => !existsSync(path.join(t.target, 'SKILL.md')));
  if (missing.length === 0) return res.json({ ok: true, name, already: true, destinations });
  const r = resolveSkill(name, { repoRoot: REPO_ROOT, projectDir: dir, homeDir: SKILLS_HOME });
  if (!r.source) return res.status(404).json({ error: `skill "${name}" was not found on this machine` });
  try {
    for (const t of missing) cpSync(r.path, t.target, { recursive: true });
    const manifest = path.join(dir, '.claude', 'skills', 'VENDORED.md');
    let head = '# Vendored skills\n';
    try { head = readFileSync(manifest, 'utf8'); } catch {}
    const line = `- ${name} — vendored from ${r.source} via the Enable results screen ` +
      `(${new Date().toISOString().slice(0, 10)}) → ${destinations.join(', ')}\n`;
    writeFileSync(manifest, `${head.replace(/\n*$/, '\n')}${line}`);
  } catch (err) { return res.status(500).json({ error: String(err && err.message || err) }); }
  res.json({ ok: true, name, source: r.source, already: false, destinations });
});

// --- knowledge graph view -------------------------------------------------
// Surface graphify's own artifacts (graph.html, GRAPH_REPORT.md, graph.json)
// for a project. Enable generates nothing here — it only reads and serves.

// Resolve a client-supplied project *name* to an absolute dir strictly under
// PROJECTS_ROOT. Rejects traversal, absolute paths, separators, and unknown
// projects, so the graph routes can only ever read inside a known git project.
function resolveProjectDir(name) {
  if (typeof name !== 'string' || !name) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  const base = path.resolve(PROJECTS_ROOT);
  const dir = path.join(base, name);
  if (path.dirname(dir) !== base) return null;
  if (!existsSync(dir) || !existsSync(path.join(dir, '.git'))) return null;
  return dir;
}

// graphify's graph.html loads vis-network from unpkg; rewrite it to the copy we
// vendor under public/vendor so the graph renders offline. Tolerant of version.
const VIS_CDN_RE = /https?:\/\/unpkg\.com\/vis-network@[^"']+\/standalone\/umd\/vis-network\.min\.js/g;

app.get('/api/enable/graph/exists', (req, res) => {
  const dir = resolveProjectDir(req.query.project);
  if (!dir) return res.json({ exists: false, nodes: 0, hasHtml: false, hasReport: false });
  const g = readJsonSafe(path.join(dir, 'graphify-out', 'graph.json'));
  const exists = !!(g && Array.isArray(g.nodes));
  res.json({
    exists,
    nodes: exists ? g.nodes.length : 0,
    hasHtml: existsSync(path.join(dir, 'graphify-out', 'graph.html')),
    hasReport: existsSync(path.join(dir, 'graphify-out', 'GRAPH_REPORT.md')),
  });
});

app.get('/api/enable/graph/view', (req, res) => {
  const dir = resolveProjectDir(req.query.project);
  if (!dir) return res.status(404).json({ error: 'unknown project' });
  let html;
  try { html = readFileSync(path.join(dir, 'graphify-out', 'graph.html'), 'utf8'); }
  catch { return res.status(404).json({ error: 'no graph.html — run /graphify first' }); }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html.replace(VIS_CDN_RE, '/vendor/vis-network.min.js'));
});

app.get('/api/enable/graph/report', (req, res) => {
  const dir = resolveProjectDir(req.query.project);
  if (!dir) return res.status(404).json({ error: 'unknown project' });
  let md;
  try { md = readFileSync(path.join(dir, 'graphify-out', 'GRAPH_REPORT.md'), 'utf8'); }
  catch { return res.status(404).json({ error: 'no GRAPH_REPORT.md' }); }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.send(md);
});

app.use((req, res, next) => {   // static UI responses carry the session cookie
  res.setHeader('Set-Cookie', `enable_auth=${AUTH_TOKEN}; Path=/; SameSite=Strict; HttpOnly`);
  next();
}, express.static(PUBLIC_DIR, { extensions: ['html'] }));

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) server.listen(PORT, HOST, () => console.log(`[enable] http://${HOST}:${PORT}`));
export { app, server, runs };
