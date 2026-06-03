// test/history-api.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let homeDir, srv, base, prevHome;

before(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'maestro-histapi-'));
  prevHome = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = homeDir;
  const store = join(homeDir, '.maestro', 'store', 'alpha-00000001', 'pipelines', 'p1');
  await mkdir(store, { recursive: true });
  await writeFile(join(store, 'state.json'),
    JSON.stringify({ id: 'p1', title: 'Alpha run', status: 'done', startedAt: '2026-06-01T00:00:00Z' }), 'utf8');
  await writeFile(join(homeDir, '.maestro', 'store', 'alpha-00000001', 'meta.json'),
    JSON.stringify({ key: 'alpha-00000001', name: 'Alpha', path: '/x/alpha' }), 'utf8');
  await writeFile(join(store, 'pipeline.md'), '# Alpha run\n', 'utf8');
  const { app } = await import('../ui/server.mjs');
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => {
  if (srv) await new Promise((r) => srv.close(r));
  if (prevHome === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prevHome;
  await rm(homeDir, { recursive: true, force: true });
});

test('GET /api/history lists pipelines across the store', async () => {
  const r = await fetch(`${base}/api/history`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.pipelines.length, 1);
  assert.equal(j.pipelines[0].projectName, 'Alpha');
  assert.equal(j.pipelines[0].projectKey, 'alpha-00000001');
});

test('GET /api/history/:key/:id returns detail; unknown -> 404', async () => {
  const r = await fetch(`${base}/api/history/alpha-00000001/p1`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).state.title, 'Alpha run');
  assert.equal((await fetch(`${base}/api/history/alpha-00000001/nope`)).status, 404);
});
