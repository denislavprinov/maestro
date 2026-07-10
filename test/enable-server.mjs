import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { getDb } from '../src/core/db.mjs';
import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after);

let app, server, base, runs;

before(async () => {
  ({ app, server, runs } = await import('../apps/enable/server.mjs'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${server.address().port}`;
});

after(async () => { if (server) await new Promise((r) => server.close(r)); });

function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'enable-srv-'));
  execSync('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: dir });
  return dir;
}

async function post(path, body) {
  const res = await fetch(`http://${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('GET /api/enable/projects returns a JSON project list', async () => {
  const res = await fetch(`http://${base}/api/enable/projects`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok('root' in body && Array.isArray(body.projects));
});

test('GET /api/enable/browse lists sub-folders with parent + git flag', async () => {
  const root = mkdtempSync(join(tmpdir(), 'enable-browse-'));
  mkdirSync(join(root, 'alpha'));
  mkdirSync(join(root, 'beta'));
  execSync('git init -q', { cwd: join(root, 'beta') });
  writeFileSync(join(root, 'afile.txt'), 'x');

  const res = await fetch(`http://${base}/api/enable/browse?dir=${encodeURIComponent(root)}`);
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.dir, root);
  assert.ok(b.parent && b.parent !== root, 'reports a parent to climb to');
  assert.deepEqual(b.entries.map((e) => e.name), ['alpha', 'beta'], 'dirs only, sorted; files excluded');
  const beta = b.entries.find((e) => e.name === 'beta');
  assert.equal(beta.path, join(root, 'beta'));
  assert.equal(beta.isGit, true, 'git repos are flagged');
});

test('GET /api/enable/browse defaults to a dir and 400s on a bad path', async () => {
  const ok = await fetch(`http://${base}/api/enable/browse`);
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).dir, 'defaults to a real directory when dir is omitted');

  const bad = await fetch(`http://${base}/api/enable/browse?dir=${encodeURIComponent('/no/such/path-xyz-123')}`);
  assert.equal(bad.status, 400);
});

test('GET /api/enable/branches lists branches with the current one flagged', async () => {
  const dir = freshRepo();                       // one commit on main
  execSync('git branch feature-x', { cwd: dir });
  const res = await fetch(`http://${base}/api/enable/branches?dir=${encodeURIComponent(dir)}`);
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.deepEqual(b.branches.slice().sort(), ['feature-x', 'main']);
  assert.equal(b.current, 'main');
});

test('GET /api/enable/branches 400s on a non-repo path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'enable-nonrepo-'));
  const res = await fetch(`http://${base}/api/enable/branches?dir=${encodeURIComponent(dir)}`);
  assert.equal(res.status, 400);
});

test('POST /api/enable/run -> {runId}; WS streams phase/readiness/done', async () => {
  const ANSWERS = { testTier: 'scaffold', vendoringDepth: 'full',
    multiToolTargets: ['cursor', 'copilot'], canary: 'yes', scopeConstraints: '' };
  const { status, json } = await post('/api/enable/run', { projectDir: freshRepo(), answers: ANSWERS, mock: true });
  assert.equal(status, 200);
  assert.ok(json.runId, JSON.stringify(json));

  const seen = new Set();
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/ws?runId=${json.runId}`);
    const timer = setTimeout(() => { ws.close(); reject(new Error(`timeout; saw ${[...seen]}`)); }, 30000);
    ws.on('message', (data) => {
      const ev = JSON.parse(data);
      if (ev.type) seen.add(ev.type);
      if (ev.type === 'done') { clearTimeout(timer); ws.close(); resolve(); }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  assert.ok(seen.has('phase'), `phase frame; saw ${[...seen]}`);
  assert.ok(seen.has('readiness'), `readiness frame; saw ${[...seen]}`);
  assert.ok(seen.has('done'), `done frame; saw ${[...seen]}`);
});

test('WS subscribed to one runId never receives another run frames', async () => {
  const ANSWERS = { testTier: 'scaffold', vendoringDepth: 'full',
    multiToolTargets: ['cursor', 'copilot'], canary: 'yes', scopeConstraints: '' };
  const a = (await post('/api/enable/run', { projectDir: freshRepo(), answers: ANSWERS, mock: true })).json;
  const b = (await post('/api/enable/run', { projectDir: freshRepo(), answers: ANSWERS, mock: true })).json;
  assert.ok(a.runId && b.runId && a.runId !== b.runId);

  const framesA = [];
  const wsA = new WebSocket(`ws://${base}/ws?runId=${a.runId}`);
  wsA.on('message', (data) => framesA.push(JSON.parse(data)));
  await new Promise((r) => wsA.on('open', r));

  // wait until run B is done on its own socket; broadcast is synchronous per
  // frame, so any leak into wsA has arrived by then.
  await new Promise((resolve, reject) => {
    const wsB = new WebSocket(`ws://${base}/ws?runId=${b.runId}`);
    const timer = setTimeout(() => { wsB.close(); reject(new Error('timeout waiting for run B')); }, 30000);
    wsB.on('message', (data) => {
      const ev = JSON.parse(data);
      if (ev.type === 'done' && ev.runId === b.runId) { clearTimeout(timer); wsB.close(); resolve(); }
    });
    wsB.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  await new Promise((r) => setTimeout(r, 50));
  wsA.close();

  const foreign = framesA.filter((ev) => ev.type !== 'hello' && ev.runId !== a.runId);
  assert.equal(foreign.length, 0, `foreign frames leaked: ${JSON.stringify(foreign.slice(0, 3))}`);
  assert.ok(framesA.some((ev) => ev.runId === a.runId), 'own-run frames must still arrive');
});

test('POST /api/enable/run without projectDir -> 400', async () => {
  const { status, json } = await post('/api/enable/run', { answers: {} });
  assert.equal(status, 400);
  assert.match(json.error, /projectDir/);
});

test('GET /api/enable/runs/:runId/changes serves results.json + patch from the run dir', async () => {
  const ANSWERS = { testTier: 'scaffold', vendoringDepth: 'full',
    multiToolTargets: ['cursor', 'copilot'], canary: 'yes', scopeConstraints: '' };
  const { json } = await post('/api/enable/run', { projectDir: freshRepo(), answers: ANSWERS, mock: true });
  const entry = runs.get(json.runId);
  await entry.done;

  const dir = entry.orch.getState().pipelineDir;
  assert.ok(dir, 'mock run must have a pipelineDir');
  const summary = { filesNew: 2, filesChanged: 1, filesDeleted: 0, linesAdded: 10, linesRemoved: 1 };
  writeFileSync(join(dir, 'results.json'), JSON.stringify({
    summary, newFiles: [{ path: 'CLAUDE.md', status: 'A', added: 9, removed: 0 }],
    changedFiles: [{ path: 'package.json', status: 'M', added: 1, removed: 1 }],
    nitpicks: [],
  }));
  writeFileSync(join(dir, 'diff-patch.patch'), 'diff --git a/CLAUDE.md b/CLAUDE.md\n+hello\n');

  const res = await fetch(`http://${base}/api/enable/runs/${json.runId}/changes`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.summary, summary);
  assert.equal(body.newFiles.length, 1);
  assert.equal(body.changedFiles.length, 1);
  assert.match(body.patch, /diff --git a\/CLAUDE\.md/);
});

test('GET /api/enable/runs/:runId/changes -> 404 for unknown runId', async () => {
  const res = await fetch(`http://${base}/api/enable/runs/nope/changes`);
  assert.equal(res.status, 404);
});

test('GET /api/enable/history lists finished Enable runs with readiness', async () => {
  const ANSWERS = { testTier: 'scaffold', vendoringDepth: 'full',
    multiToolTargets: ['cursor', 'copilot'], canary: 'yes', scopeConstraints: '' };
  const { json } = await post('/api/enable/run', { projectDir: freshRepo(), answers: ANSWERS, mock: true });
  const entry = runs.get(json.runId);
  await entry.done;
  const dir = entry.orch.getState().pipelineDir;
  writeFileSync(join(dir, 'readiness.json'),
    JSON.stringify({ score: 91, baselineScore: 30, delta: 61, dimensions: {}, gaps: [] }));

  const res = await fetch(`http://${base}/api/enable/history`);
  assert.equal(res.status, 200);
  const { runs: hist } = await res.json();
  assert.ok(Array.isArray(hist) && hist.length >= 1, 'at least the run just finished');
  const mine = hist.find((h) => h.dir === dir);
  assert.ok(mine, 'the finished run must be listed');
  assert.equal(mine.title, 'Enable project for AI');
  assert.equal(mine.readiness?.score, 91);
  assert.ok(mine.id && mine.startedAt, 'id + startedAt present');
});

test('GET /api/enable/history/:id returns entry + readiness + changes; 404 unknown', async () => {
  const list = await (await fetch(`http://${base}/api/enable/history`)).json();
  const first = list.runs[0];
  assert.ok(first, 'history must have an entry from the previous test');
  writeFileSync(join(first.dir, 'results.json'), JSON.stringify({
    summary: { filesNew: 1, filesChanged: 0, filesDeleted: 0, linesAdded: 5, linesRemoved: 0 },
    newFiles: [{ path: 'CLAUDE.md', status: 'A', added: 5, removed: 0 }], changedFiles: [], nitpicks: [],
  }));

  const res = await fetch(`http://${base}/api/enable/history/${first.id}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.entry.id, first.id);
  assert.ok(body.readiness, 'readiness present');
  assert.equal(body.changes.summary.filesNew, 1);

  const missing = await fetch(`http://${base}/api/enable/history/ffffffff`);
  assert.equal(missing.status, 404);
});

const FILE_ANSWERS = { testTier: 'scaffold', vendoringDepth: 'full',
  multiToolTargets: ['cursor', 'copilot'], canary: 'yes', scopeConstraints: '' };

// commit `content` at `rel` onto the run's kept feature branch, then list `rel`
// as a changed file in results.json so the file route's allowlist admits it.
function seedFeatureFile(repo, feature, dir, rel, content) {
  execSync(`git -C ${repo} checkout -q ${feature}`);
  writeFileSync(join(repo, rel), content);
  execSync(`git -C ${repo} add ${rel} && git -C ${repo} -c user.email=t@t -c user.name=t commit -q -m ${rel}`);
  execSync(`git -C ${repo} checkout -q main`);
  writeFileSync(join(dir, 'results.json'), JSON.stringify({
    summary: { filesNew: 1, filesChanged: 0, filesDeleted: 0, linesAdded: 1, linesRemoved: 0 },
    newFiles: [{ path: rel, status: 'A', added: 1, removed: 0 }], changedFiles: [], nitpicks: [] }));
}

test('GET /api/enable/runs/:runId/file returns full content from the feature branch', async () => {
  const repo = freshRepo();
  const { json } = await post('/api/enable/run', { projectDir: repo, answers: FILE_ANSWERS, mock: true });
  const entry = runs.get(json.runId);
  await entry.done;
  const st = entry.orch.getState();
  assert.ok(st.branch?.feature, 'run kept a feature branch');
  seedFeatureFile(repo, st.branch.feature, st.pipelineDir, 'GUIDE.md', '# Title\n\nHello **world**.\n');

  const res = await fetch(`http://${base}/api/enable/runs/${json.runId}/file?path=GUIDE.md`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.path, 'GUIDE.md');
  assert.match(body.content, /# Title/);
  assert.match(body.content, /\*\*world\*\*/);
});

test('file route allowlists to changed files (traversal / untouched paths 404)', async () => {
  assert.equal((await fetch(`http://${base}/api/enable/runs/nope/file?path=x.md`)).status, 404);

  const repo = freshRepo();
  const { json } = await post('/api/enable/run', { projectDir: repo, answers: FILE_ANSWERS, mock: true });
  const entry = runs.get(json.runId);
  await entry.done;
  const st = entry.orch.getState();
  seedFeatureFile(repo, st.branch.feature, st.pipelineDir, 'GUIDE.md', '# ok\n');

  const trav = await fetch(`http://${base}/api/enable/runs/${json.runId}/file?path=${encodeURIComponent('../../../etc/passwd')}`);
  assert.equal(trav.status, 404, 'traversal path is refused');
  const untouched = await fetch(`http://${base}/api/enable/runs/${json.runId}/file?path=package.json`);
  assert.equal(untouched.status, 404, 'a file the run did not change is refused');
});

test('GET /api/enable/history/:id/file previews a past run file off its branch', async () => {
  const repo = freshRepo();
  const { json } = await post('/api/enable/run', { projectDir: repo, answers: FILE_ANSWERS, mock: true });
  const entry = runs.get(json.runId);
  await entry.done;
  const st = entry.orch.getState();
  seedFeatureFile(repo, st.branch.feature, st.pipelineDir, 'NOTES.md', '# Doc\n\n- a\n- b\n');

  const hist = await (await fetch(`http://${base}/api/enable/history`)).json();
  const mine = hist.runs.find((h) => h.dir === st.pipelineDir);
  assert.ok(mine, 'run is present in history');
  const res = await fetch(`http://${base}/api/enable/history/${mine.id}/file?path=NOTES.md`);
  assert.equal(res.status, 200);
  assert.match((await res.json()).content, /# Doc/);
});

test('history marks a $0 sub-5s run as mock; a costed run is not', async () => {
  const { json } = await post('/api/enable/run', { projectDir: freshRepo(), answers: FILE_ANSWERS, mock: true });
  const entry = runs.get(json.runId);
  await entry.done;
  const dir = entry.orch.getState().pipelineDir;

  let hist = (await (await fetch(`http://${base}/api/enable/history`)).json()).runs;
  const mine = hist.find((h) => h.dir === dir);
  assert.ok(mine, 'the mock run is listed');
  assert.equal(mine.mock, true, 'a $0, sub-5s run is flagged as a dry run');

  // give the same row a real cost -> no longer a mock
  getDb().prepare('UPDATE pipelines SET total_cost_usd = 5.5, total_active_ms = 700000 WHERE id = ?').run(mine.id);
  hist = (await (await fetch(`http://${base}/api/enable/history`)).json()).runs;
  assert.equal(hist.find((h) => h.dir === dir).mock, false, 'a costed, minutes-long run is not a mock');
});

test('history surfaces a run by onboarding artifact even when the title differs', async () => {
  const { json } = await post('/api/enable/run', { projectDir: freshRepo(), answers: FILE_ANSWERS, mock: true });
  const entry = runs.get(json.runId);
  await entry.done;
  const dir = entry.orch.getState().pipelineDir;
  const id = (await (await fetch(`http://${base}/api/enable/history`)).json()).runs.find((h) => h.dir === dir).id;

  // simulate a pre-pin real run: model-generated title + the evaluator signature file
  getDb().prepare('UPDATE pipelines SET title = ? WHERE id = ?').run('Enable AI Integration', id);
  writeFileSync(join(dir, 'onboardingEvaluator-review-cycle1.json'), '{}');

  const hist = (await (await fetch(`http://${base}/api/enable/history`)).json()).runs;
  assert.ok(hist.some((h) => h.dir === dir),
    'a run with a non-pinned title still appears via its onboarding artifact');
});

test('GET /api/enable/history reaps a crashed "running" orphan to interrupted', async () => {
  const { json } = await post('/api/enable/run', { projectDir: freshRepo(), answers: FILE_ANSWERS, mock: true });
  const entry = runs.get(json.runId);
  await entry.done;
  const dir = entry.orch.getState().pipelineDir;
  const id = (await (await fetch(`http://${base}/api/enable/history`)).json()).runs.find((h) => h.dir === dir).id;

  // simulate the owning process having died: drop it from this server's live map,
  // then leave the row stuck "running" with a dead pid + a long-stale heartbeat.
  runs.delete(json.runId);
  getDb().prepare("UPDATE pipelines SET status='running', owner_pid=?, owner_host=?, heartbeat_at='2000-01-01T00:00:00Z' WHERE id=?")
    .run(2147483646, hostname(), id);

  const mine = (await (await fetch(`http://${base}/api/enable/history`)).json()).runs.find((h) => h.id === id);
  assert.ok(mine, 'the orphan is still listed');
  assert.equal(mine.status, 'interrupted', 'a crashed running run is reconciled, not left "running"');
});

test('POST /api/enable/answer with unknown runId -> 400', async () => {
  const { status, json } = await post('/api/enable/answer', { runId: 'nope', id: 'x', payload: {} });
  assert.equal(status, 400);
  assert.match(json.error, /unknown runId/);
});
