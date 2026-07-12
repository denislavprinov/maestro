// test/config-api.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetForTests } from '../src/core/db.mjs';

let proj, srv, base, homeDir, prevHome;
const q = (o) => new URLSearchParams(o).toString();

before(async () => {
  // POST /api/config* drives setStep/addCustomModel/removeCustomModel, which now
  // write the DB. Isolate that DB under a throwaway MAESTRO_HOME and reset the
  // db.mjs singleton so its writes can't leak into / inherit from neighbours in
  // the shared single-process `node --test` run.
  homeDir = await mkdtemp(join(tmpdir(), 'maestro-cfgapi-home-'));
  prevHome = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = homeDir;
  _resetForTests();
  proj = await mkdtemp(join(tmpdir(), 'maestro-cfgapi-'));
  const { app } = await import('../ui/server.mjs'); // imported => does not bind a port
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => {
  if (srv) await new Promise((r) => srv.close(r));
  _resetForTests();
  if (prevHome === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prevHome;
  await rm(proj, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
});

test('GET /api/config returns predefined models + empty config + step defs', async () => {
  const r = await fetch(`${base}/api/config?${q({ projectDir: proj })}`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.config, { steps: {}, customModels: [], workflows: {} });
  assert.ok(j.models.some((m) => m.id === 'claude-opus-4-8'));
  assert.ok(j.steps.some((s) => s.key === 'planner'));
  assert.ok(j.efforts.includes('xhigh'));
});

test('GET /api/config without projectDir -> built-in models, empty config', async () => {
  const r = await fetch(`${base}/api/config`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.config, { steps: {}, customModels: [] });
  // Every predefined model is present, none flagged custom (no project = no customs).
  assert.ok(j.models.some((m) => m.id === 'claude-opus-4-8'));
  assert.ok(j.models.some((m) => m.id === 'claude-sonnet-4-6'));
  assert.ok(j.models.some((m) => m.id === 'claude-haiku-4-5'));
  assert.ok(j.models.every((m) => m.custom === false));
  assert.ok(j.steps.some((s) => s.key === 'planner'));
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

test('GET /api/config lists the 1M long-context variants', async () => {
  const r = await fetch(`${base}/api/config?${q({ projectDir: proj })}`);
  const j = await r.json();
  assert.ok(j.models.some((m) => m.id === 'claude-opus-4-8[1m]'));
  assert.ok(j.models.some((m) => m.id === 'claude-sonnet-4-6[1m]'));
  // Haiku 1M is intentionally absent (subscription-gated).
  assert.ok(!j.models.some((m) => m.id === 'claude-haiku-4-5[1m]'));
});

test('POST /api/config accepts a 1M model + its effort', async () => {
  let r = await fetch(`${base}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectDir: proj, step: 'planner', model: 'claude-opus-4-8[1m]', effort: 'xhigh' }),
  });
  assert.equal(r.status, 200);
  r = await fetch(`${base}/api/config?${q({ projectDir: proj })}`);
  assert.deepEqual((await r.json()).config.steps.planner, { model: 'claude-opus-4-8[1m]', effort: 'xhigh' });
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

test('POST /api/config passes askQuestions through to setStep', async () => {
  let r = await fetch(`${base}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectDir: proj, step: 'planner', askQuestions: true }),
  });
  assert.equal(r.status, 200);
  const { config } = await r.json();
  assert.equal(config.steps.planner.askQuestions, true);
});

test('POST /api/config responds with the FULL run-config shape (workflows layer, mirrors PATCH)', async () => {
  // Clients assign the response to their whole config state; setStep's legacy
  // {steps, customModels} view dropped config.workflows and made saved node
  // models paint as unconfigured after any default-stage edit.
  const r = await fetch(`${base}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectDir: proj, step: 'refiner', model: 'claude-opus-4-8' }),
  });
  assert.equal(r.status, 200);
  const { config } = await r.json();
  assert.ok(config.workflows && typeof config.workflows === 'object', 'run-config workflows layer present');
  assert.equal(config.steps.refiner.model, 'claude-opus-4-8');
});
