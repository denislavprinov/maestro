import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, runs, _testing } from '../ui/server.mjs';

let srv, base;
const tmpDirs = [];

before(async () => {
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => {
  if (srv) await new Promise((r) => srv.close(r));
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function makeProjectDir() {
  const d = await mkdtemp(join(tmpdir(), 'maestro-runs-id-'));
  tmpDirs.push(d);
  return d;
}

function makeEntry(overrides = {}) {
  return {
    id: 'uuid-AAAA',
    orch: new EventEmitter(),
    projectDir: '/tmp/x',
    title: 't',
    status: 'starting',
    startedAt: new Date().toISOString(),
    events: [],
    pendingQuestion: null,
    ...overrides,
  };
}

// ── unit: wireRun captures the short id from the orchestrator's state event ──
test('wireRun: state.id is captured onto entry.pipelineId; null does not clobber', () => {
  const entry = makeEntry({ id: 'uuid-AAAA' });
  runs.set(entry.id, entry);
  try {
    _testing.wireRun(entry);

    // Pre-createPipeline snapshots in the orchestrator have id=null. Must NOT
    // clobber a missing pipelineId with null/undefined.
    entry.orch.emit('state', { id: null, status: 'running', phase: 'preflight' });
    assert.equal(entry.pipelineId, undefined, 'null id is ignored');
    assert.equal(entry.status, 'running', 'status still mirrored');

    // Post-createPipeline snapshot carries the short id.
    entry.orch.emit('state', { id: 'ab12cd34', status: 'running', phase: 'preflight' });
    assert.equal(entry.pipelineId, 'ab12cd34', 'short id captured');

    // A later snapshot without an id must not erase the captured value.
    entry.orch.emit('state', { status: 'done' });
    assert.equal(entry.pipelineId, 'ab12cd34', 'missing id leaves capture intact');
    assert.equal(entry.status, 'done');
  } finally {
    runs.delete(entry.id);
  }
});

// ── integration: /api/runs exposes id=pipelineId, runId=uuid so dedup works ──
test('/api/runs: live entries expose the pipeline short id when known', async () => {
  const projectDir = await makeProjectDir();
  const entry = makeEntry({
    id: 'uuid-BBBB',
    projectDir,
    pipelineId: 'ab12cd34',
    title: 'My run',
    status: 'done',
  });
  runs.set(entry.id, entry);
  try {
    const res = await fetch(
      `${base}/api/runs?projectDir=${encodeURIComponent(projectDir)}`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.live.length, 1, 'one live entry for this projectDir');
    assert.equal(body.live[0].id, 'ab12cd34', 'id is the short pipeline id');
    assert.equal(body.live[0].runId, 'uuid-BBBB', 'runId remains the UUID for WS routing');
    assert.equal(body.live[0].live, true);
  } finally {
    runs.delete(entry.id);
  }
});

// ── integration: before createPipeline fires a state-with-id, id falls back to UUID ──
test('/api/runs: live entries fall back to UUID before any state event with an id', async () => {
  const projectDir = await makeProjectDir();
  const entry = makeEntry({
    id: 'uuid-CCCC',
    projectDir,
    title: 'preflight',
    status: 'starting',
  });
  runs.set(entry.id, entry);
  try {
    const res = await fetch(
      `${base}/api/runs?projectDir=${encodeURIComponent(projectDir)}`,
    );
    const body = await res.json();
    assert.equal(body.live.length, 1);
    assert.equal(body.live[0].id, 'uuid-CCCC', 'no pipelineId yet → id is the UUID');
    assert.equal(body.live[0].runId, 'uuid-CCCC');
  } finally {
    runs.delete(entry.id);
  }
});
