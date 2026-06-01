// test/api-workflows.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let homeDir, srv, base;
const JSONH = { 'Content-Type': 'application/json' };

before(async () => {
  // Redirect the global ~/.maestro (workflow store) into a sandbox.
  homeDir = await mkdtemp(join(tmpdir(), 'maestro-wfapi-'));
  process.env.MAESTRO_HOME = homeDir;
  process.env.MAESTRO_MOCK = '1'; // keep /api/run offline
  const { app } = await import('../ui/server.mjs'); // imported => no port bind
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => {
  if (srv) await new Promise((r) => srv.close(r));
  delete process.env.MAESTRO_HOME;
  delete process.env.MAESTRO_MOCK;
  await rm(homeDir, { recursive: true, force: true });
});

test('GET /api/workflows lists the built-in default first', async () => {
  const r = await fetch(`${base}/api/workflows`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.workflows));
  assert.equal(j.workflows[0].id, 'wf_default');
  assert.equal(j.workflows[0].name, 'Default');
  // The default template carries a real 4-step topology.
  assert.ok(Array.isArray(j.workflows[0].steps) && j.workflows[0].steps.length === 4);
});

test('GET /api/workflows/:id returns the default template', async () => {
  const r = await fetch(`${base}/api/workflows/wf_default`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.id, 'wf_default');
  assert.ok(Array.isArray(j.feedbacks));
});

test('GET /api/workflows/:id is 404 for an unknown id', async () => {
  const r = await fetch(`${base}/api/workflows/wf_does_not_exist`);
  assert.equal(r.status, 404);
  assert.ok((await r.json()).error);
});

test('POST /api/workflows validates and rejects an empty-steps template -> 400', async () => {
  const r = await fetch(`${base}/api/workflows`, {
    method: 'POST', headers: JSONH,
    body: JSON.stringify({ name: 'Bad', steps: [], feedbacks: [] }),
  });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.ok(Array.isArray(j.errors) && j.errors.length >= 1, 'returns validator errors');
});

test('POST /api/workflows rejects a node with an unknown agent key -> 400', async () => {
  const r = await fetch(`${base}/api/workflows`, {
    method: 'POST', headers: JSONH,
    body: JSON.stringify({
      name: 'Bogus',
      steps: [[{ id: 's0_0', key: 'notAnAgent' }]],
      feedbacks: [],
    }),
  });
  assert.equal(r.status, 400);
  assert.ok((await r.json()).errors.length >= 1);
});

test('POST /api/workflows creates a valid template -> 201, then it lists', async () => {
  const r = await fetch(`${base}/api/workflows`, {
    method: 'POST', headers: JSONH,
    body: JSON.stringify({
      name: 'Quick Fix',
      steps: [
        [{ id: 's0_0', key: 'planner' }],
        [{ id: 's1_0', key: 'implementer' }],
        [{ id: 's2_0', key: 'reviewer' }],
      ],
      feedbacks: [{ id: 'fb_0', from: 's2_0', to: 's1_0' }],
    }),
  });
  assert.equal(r.status, 201);
  const { workflow } = await r.json();
  assert.equal(workflow.name, 'Quick Fix');
  assert.match(workflow.id, /^wf_/);
  assert.ok(workflow.createdAt && workflow.updatedAt, 'stamped on write');

  // It now appears in the list (after the always-present default).
  const list = await (await fetch(`${base}/api/workflows`)).json();
  assert.ok(list.workflows.some((w) => w.id === workflow.id && w.name === 'Quick Fix'));
});

test('DELETE /api/workflows/wf_default is refused -> 400', async () => {
  const r = await fetch(`${base}/api/workflows/wf_default`, { method: 'DELETE' });
  assert.equal(r.status, 400);
  assert.ok((await r.json()).error);
});

test('DELETE /api/workflows/:id is 404 for an unknown id', async () => {
  const r = await fetch(`${base}/api/workflows/wf_missing_xyz`, { method: 'DELETE' });
  assert.equal(r.status, 404);
});

test('DELETE /api/workflows/:id removes a created template', async () => {
  // Create one to delete.
  const created = await (await fetch(`${base}/api/workflows`, {
    method: 'POST', headers: JSONH,
    body: JSON.stringify({
      name: 'Disposable',
      steps: [[{ id: 's0_0', key: 'planner' }], [{ id: 's1_0', key: 'reviewer' }]],
      feedbacks: [],
    }),
  })).json();
  const id = created.workflow.id;

  const del = await fetch(`${base}/api/workflows/${id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true });

  // Gone from the list (default still present).
  const list = await (await fetch(`${base}/api/workflows`)).json();
  assert.ok(!list.workflows.some((w) => w.id === id));
  assert.ok(list.workflows.some((w) => w.id === 'wf_default'));
});
