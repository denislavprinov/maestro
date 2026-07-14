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

test('POST /api/enable/resume: concurrent duplicate resume -> one wins, other 409', async () => {
  const proj = freshRepo();
  const { id } = await seedPipeline(proj, { title: 'Enable project for AI', status: 'paused',
    resumePoint: { version: 1, kind: 'boundary', stepIndex: 0, stepCycle: [], loopState: {},
      bus: null, stepModels: null, workflowId: 'wf_enable', plan: null, nodes: [], gate: null,
      pipelineDir: proj, pausedAt: '2026-07-10T00:00:00Z' } });
  // Start both requests at nearly the same time; the guard + synchronous claim ensures
  // the second one sees the first's claim (matched on its pipelineId tag) and 409s.
  const reqA = post('/api/enable/resume', { pipelineId: id, mock: true });
  const reqB = post('/api/enable/resume', { pipelineId: id, mock: true });
  const [a, b] = await Promise.all([reqA, reqB]);
  const codes = [a.status, b.status].sort();
  assert.equal(codes[0], 200, 'exactly one resume succeeds');
  assert.equal(codes[1], 409, 'the duplicate is rejected');
  // let the winner finish so it doesn't leak into later tests
  const winner = a.status === 200 ? a : b;
  await runs.get(winner.json.runId).done;
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

test('POST /api/enable/resume: 409 on a joinable live entry carries liveRunId', async () => {
  const proj = freshRepo();
  const { id } = await seedPipeline(proj, { title: 'Enable project for AI', status: 'paused',
    resumePoint: { version: 1, kind: 'boundary', stepIndex: 0, stepCycle: [], loopState: {},
      bus: null, stepModels: null, workflowId: 'wf_enable', plan: null, nodes: [], gate: null,
      pipelineDir: proj, pausedAt: '2026-07-11T00:00:00Z' } });
  runs.set('r-join', { pipelineId: id, status: 'running', buffer: [], events: {}, orch: {} });
  const r = await post('/api/enable/resume', { pipelineId: id });
  assert.equal(r.status, 409);
  assert.equal(r.json.liveRunId, 'r-join');
  runs.delete('r-join');
});

test('GET /api/enable/history: live pipeline entries carry liveRunId; others do not', async () => {
  const proj = freshRepo();
  const { id } = await seedPipeline(proj, { title: 'Enable project for AI', status: 'running' });
  const { id: idDone } = await seedPipeline(proj, { title: 'Enable project for AI', status: 'done' });
  // joinable live handle for `id` (buffer + events, non-terminal status)
  runs.set('r-hist-live', { status: 'running', pipelineId: id, buffer: [], events: { on() {} } });
  try {
    const hist = await (await fetch(`http://${base}/api/enable/history`)).json();
    const live = hist.runs.find((x) => x.id === id);
    const done = hist.runs.find((x) => x.id === idDone);
    assert.equal(live.liveRunId, 'r-hist-live', 'running pipeline exposes its joinable runId');
    assert.equal(live.status, 'running', 'live handle shields the row from stale-running reconcile');
    assert.ok(!done.liveRunId, 'finished pipeline has no liveRunId');
  } finally { runs.delete('r-hist-live'); }
});
