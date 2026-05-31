// test/config-api.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let proj, srv, base;
const q = (o) => new URLSearchParams(o).toString();

before(async () => {
  proj = await mkdtemp(join(tmpdir(), 'maestro-cfgapi-'));
  const { app } = await import('../ui/server.mjs'); // imported => does not bind a port
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => {
  if (srv) await new Promise((r) => srv.close(r));
  await rm(proj, { recursive: true, force: true });
});

test('GET /api/config returns predefined models + empty config + step defs', async () => {
  const r = await fetch(`${base}/api/config?${q({ projectDir: proj })}`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.config, { steps: {}, customModels: [] });
  assert.ok(j.models.some((m) => m.id === 'claude-opus-4-8'));
  assert.ok(j.steps.some((s) => s.key === 'planner'));
  assert.ok(j.efforts.includes('xhigh'));
});

test('GET /api/config without projectDir -> 400', async () => {
  const r = await fetch(`${base}/api/config`);
  assert.equal(r.status, 400);
});

test('POST /api/config sets a step; GET reflects it', async () => {
  let r = await fetch(`${base}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectDir: proj, step: 'reviewer', model: 'claude-opus-4-8', effort: 'max' }),
  });
  assert.equal(r.status, 200);
  r = await fetch(`${base}/api/config?${q({ projectDir: proj })}`);
  assert.deepEqual((await r.json()).config.steps.reviewer, { model: 'claude-opus-4-8', effort: 'max' });
});

test('POST /api/config with an unsupported effort -> 400', async () => {
  const r = await fetch(`${base}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectDir: proj, step: 'reviewer', model: 'claude-haiku-4-5', effort: 'xhigh' }),
  });
  assert.equal(r.status, 400);
});

test('add then delete a custom model over HTTP', async () => {
  let r = await fetch(`${base}/api/config/models`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectDir: proj, id: 'my-model-x' }),
  });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).models.some((m) => m.id === 'my-model-x'));

  r = await fetch(`${base}/api/config/models?${q({ projectDir: proj, id: 'my-model-x' })}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.ok(!(await r.json()).models.some((m) => m.id === 'my-model-x'));
});
