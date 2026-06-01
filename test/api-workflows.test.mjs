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
