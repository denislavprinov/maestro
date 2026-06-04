// test/pr-api.test.mjs
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from '../ui/server.mjs';
import { _testing as gitInfo } from '../src/core/git-info.mjs';

let srv, base, home, prevHome;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'maestro-pr-'));
  prevHome = process.env.MAESTRO_HOME; process.env.MAESTRO_HOME = home;
  const dir = join(home, '.maestro', 'store', 'beta-00000002', 'pipelines', 'pp');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    id: 'pp', title: 'My feature', status: 'stopped', projectDir: '/repo/beta',
    branch: { source: 'main', feature: 'maestro/my-feature-pp', branchKept: true, commit: 'abc' },
  }), 'utf8');
  await writeFile(join(home, '.maestro', 'store', 'beta-00000002', 'meta.json'),
    JSON.stringify({ key: 'beta-00000002', name: 'Beta', path: '/repo/beta' }), 'utf8');
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => {
  if (srv) await new Promise((r) => srv.close(r));
  gitInfo.reset();
  if (prevHome === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

beforeEach(() => gitInfo.reset());

const post = (body) => fetch(`${base}/api/pr`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('POST /api/pr -> 400 when id is missing', async () => {
  assert.equal((await post({ projectKey: 'beta-00000002' })).status, 400);
});

test('POST /api/pr -> 409 when gh is unavailable', async () => {
  gitInfo.setRunner((cmd) => Promise.resolve(
    cmd === 'gh' ? { ok: false, stdout: '', stderr: 'not found', code: 127 }
                 : { ok: true, stdout: '', stderr: '', code: 0 }));
  assert.equal((await post({ projectKey: 'beta-00000002', id: 'pp' })).status, 409);
});

test('POST /api/pr pushes, creates the PR, returns url + mergeable', async () => {
  const seen = [];
  gitInfo.setRunner((cmd, args) => {
    seen.push([cmd, ...args]);
    if (cmd === 'gh' && args[0] === '--version') return Promise.resolve({ ok: true, stdout: 'gh 2.x', stderr: '', code: 0 });
    if (cmd === 'git' && args[0] === 'push') return Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0 });
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create')
      return Promise.resolve({ ok: true, stdout: 'https://github.com/x/y/pull/7\n', stderr: '', code: 0 });
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view')
      return Promise.resolve({ ok: true, stdout: 'MERGEABLE\n', stderr: '', code: 0 });
    return Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0 });
  });
  const r = await post({ projectKey: 'beta-00000002', id: 'pp' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.url, 'https://github.com/x/y/pull/7');
  assert.equal(j.mergeable, 'MERGEABLE');
  assert.ok(seen.some((c) => c[0] === 'git' && c[1] === 'push'), 'branch was pushed');
  assert.ok(seen.some((c) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'create'), 'PR was created');
});

test('GET /api/history exposes ghAvailable', async () => {
  gitInfo.setRunner((cmd, args) =>
    Promise.resolve(cmd === 'gh' && args[0] === '--version'
      ? { ok: true, stdout: 'gh 2.x', stderr: '', code: 0 }
      : { ok: true, stdout: '', stderr: '', code: 0 }));
  const j = await (await fetch(`${base}/api/history`)).json();
  assert.equal(j.ghAvailable, true);
});
