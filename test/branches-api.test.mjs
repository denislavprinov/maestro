// test/branches-api.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { app } from '../ui/server.mjs';

let srv, base;
const created = [];

before(async () => {
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => {
  if (srv) await new Promise((r) => srv.close(r));
  await Promise.all(created.map((d) => rm(d, { recursive: true, force: true })));
});

async function freshRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-api-'));
  created.push(dir);
  const g = (a) => spawnSync('git', a, { cwd: dir });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  await writeFile(join(dir, 'a'), 'a');
  g(['add', '-A']); g(['commit', '-qm', 'init']);
  g(['branch', 'feature/x']);
  return dir;
}

test('GET /api/branches returns local branches + current', async () => {
  const repo = await freshRepo();
  const r = await fetch(`${base}/api/branches?projectDir=${encodeURIComponent(repo)}`);
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.ok(Array.isArray(data.branches));
  assert.ok(data.branches.includes('main'));
  assert.ok(data.branches.includes('feature/x'));
  assert.equal(data.current, 'main');
});

test('GET /api/branches 400s without projectDir', async () => {
  const r = await fetch(`${base}/api/branches`);
  assert.equal(r.status, 400);
});
