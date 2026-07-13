import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after);

// PROJECTS_ROOT is read at module load; set before the server import in before()
const ROOT = mkdtempSync(join(tmpdir(), 'enable-todo-root-'));
process.env.MAESTRO_ENABLE_PROJECTS_ROOT = ROOT;

const PROJ = mkdtempSync(join(tmpdir(), 'enable-todo-proj-'));

let server, base, cookie;
before(async () => {
  ({ server } = await import('../apps/enable/server.mjs'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${server.address().port}`;
  const res = await fetch(`http://${base}/`);
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
});
after(async () => { if (server) await new Promise((r) => server.close(r)); });

const post = (body) => fetch(`http://${base}/api/enable/todo`, {
  method: 'POST', headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('creates TODO.md with a dated section and checkbox items', async () => {
  const res = await post({ dir: PROJ, gaps: ['Add integration tests', 'Document release flow'] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.written, 2);
  assert.equal(body.skipped, 0);
  assert.equal(body.path, join(PROJ, 'TODO.md'));
  const text = readFileSync(join(PROJ, 'TODO.md'), 'utf8');
  assert.match(text, /^## Enable — still worth doing \(\d{4}-\d{2}-\d{2}\)$/m);
  assert.match(text, /^- \[ \] Add integration tests$/m);
  assert.match(text, /^- \[ \] Document release flow$/m);
});

test('dedup: re-posting the same gaps writes nothing new', async () => {
  const res = await post({ dir: PROJ, gaps: ['Add integration tests', 'Document release flow'] });
  const body = await res.json();
  assert.equal(body.written, 0);
  assert.equal(body.skipped, 2);
  const text = readFileSync(join(PROJ, 'TODO.md'), 'utf8');
  assert.equal(text.match(/Add integration tests/g).length, 1);
  // no empty second section appended
  assert.equal(text.match(/## Enable — still worth doing/g).length, 1);
});

test('dedup counts checked-off items too', async () => {
  const done = mkdtempSync(join(tmpdir(), 'enable-todo-done-'));
  writeFileSync(join(done, 'TODO.md'), '# TODO\n\n- [x] Ship the thing\n');
  const res = await post({ dir: done, gaps: ['Ship the thing', 'New gap'] });
  const body = await res.json();
  assert.equal(body.written, 1);
  assert.equal(body.skipped, 1);
});

test('appends to an existing TODO.md without clobbering it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'enable-todo-exist-'));
  writeFileSync(join(dir, 'TODO.md'), '# My notes\n\n- [ ] Pre-existing item\n');
  await post({ dir, gaps: ['Fresh gap'] });
  const text = readFileSync(join(dir, 'TODO.md'), 'utf8');
  assert.match(text, /Pre-existing item/);
  assert.match(text, /^- \[ \] Fresh gap$/m);
});

test('400 on missing dir, non-dir, or empty gaps', async () => {
  assert.equal((await post({ dir: join(PROJ, 'nope'), gaps: ['x'] })).status, 400);
  assert.equal((await post({ dir: PROJ, gaps: [] })).status, 400);
  assert.equal((await post({ gaps: ['x'] })).status, 400);
  const f = join(PROJ, 'afile.txt'); writeFileSync(f, 'hi');
  assert.equal((await post({ dir: f, gaps: ['x'] })).status, 400);
  assert.equal(existsSync(join(PROJ, 'nope', 'TODO.md')), false);
});

test('non-string gaps are rejected', async () => {
  assert.equal((await post({ dir: PROJ, gaps: [{ title: 'obj' }] })).status, 400);
});

test('bare project name resolves under PROJECTS_ROOT', async () => {
  const dir = join(ROOT, 'myproj');
  mkdirSync(dir, { recursive: true });
  execSync('git init -q', { cwd: dir });
  const res = await post({ dir: 'myproj', gaps: ['Named-project gap'] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.written, 1);
  assert.match(readFileSync(join(dir, 'TODO.md'), 'utf8'), /^- \[ \] Named-project gap$/m);
});

test('unknown bare name is a 400, not a write anywhere', async () => {
  const res = await post({ dir: 'no-such-project', gaps: ['x'] });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown project/);
});
