// test/server-validate.test.mjs — GET /api/validate-detect wraps
// detectValidationCommands (Task 5); POST /api/run threads validateCommands into
// the created orchestrator, on both the single-project and workspace branches.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let srv, base, runs, prevHome, homeDir;
const created = [];

before(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'maestro-validate-ui-'));
  prevHome = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = homeDir;
  process.env.MAESTRO_MOCK = '1';
  const mod = await import('../ui/server.mjs');
  runs = mod.runs;
  srv = http.createServer(mod.app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => {
  if (srv) await new Promise((r) => srv.close(r));
  runs.clear();
  if (prevHome === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prevHome;
  delete process.env.MAESTRO_MOCK;
  await rm(homeDir, { recursive: true, force: true });
  await Promise.all(created.map((d) => rm(d, { recursive: true, force: true })));
});

async function makeDir() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-validate-fixture-'));
  created.push(dir);
  return dir;
}

test('GET /api/validate-detect: fixture with package.json scripts.test -> {commands:["npm test"]}', async () => {
  const dir = await makeDir();
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const r = await fetch(`${base}/api/validate-detect?projectDir=${encodeURIComponent(dir)}`);
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.deepEqual(data.commands, ['npm test']);
});

test('GET /api/validate-detect: empty fixture -> {commands:[]}', async () => {
  const dir = await makeDir();
  const r = await fetch(`${base}/api/validate-detect?projectDir=${encodeURIComponent(dir)}`);
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.deepEqual(data.commands, []);
});

test('GET /api/validate-detect: missing projectDir -> 400', async () => {
  const r = await fetch(`${base}/api/validate-detect`);
  assert.equal(r.status, 400);
});

test('POST /api/run: validateCommands threads into the created single-project orchestrator', async () => {
  const dir = await makeDir();
  const r = await fetch(`${base}/api/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectDir: dir, prompt: 'x', mock: true, validateCommands: ['exit 0'] }),
  });
  assert.equal(r.status, 200);
  const { runId } = await r.json();
  const entry = runs.get(runId);
  assert.ok(entry, 'run entry created');
  assert.deepEqual(entry.orch.validateCommands, ['exit 0']);
});
