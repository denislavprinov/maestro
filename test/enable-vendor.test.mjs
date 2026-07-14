import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after);

// deterministic skill-resolution home for the vendor endpoint (read at import time)
const skillsHome = mkdtempSync(join(tmpdir(), 'enable-vendor-home-'));
process.env.ENABLE_SKILLS_HOME = skillsHome;

let app, server, base, cookie;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts = {}) =>
  realFetch(url, { ...opts, headers: { ...(opts.headers || {}), cookie } });

before(async () => {
  ({ app, server } = await import('../apps/enable/server.mjs'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${server.address().port}`;
  const res = await realFetch(`http://${base}/`);
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
});
after(async () => { if (server) await new Promise((r) => server.close(r)); });

function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'enable-vendor-'));
  execSync('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: dir });
  return dir;
}

async function post(path, body) {
  const res = await fetch(`http://${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('vendor: a name off the curated allowlist is rejected 400 (never copied)', async () => {
  const { status, json } = await post('/api/enable/vendor', { dir: freshRepo(), name: 'my-private-thing' });
  assert.equal(status, 400);
  assert.match(json.error, /allowlist/);
});

test('vendor: happy path copies a global-resolved skill and appends VENDORED.md', async () => {
  const skillDir = join(skillsHome, '.claude', 'skills', 'writing-plans');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# writing-plans\n');
  const dir = freshRepo();
  const { status, json } = await post('/api/enable/vendor', { dir, name: 'writing-plans' });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.already, false);
  assert.ok(existsSync(join(dir, '.claude', 'skills', 'writing-plans', 'SKILL.md')));
  assert.match(readFileSync(join(dir, '.claude', 'skills', 'VENDORED.md'), 'utf8'), /writing-plans/);
  // idempotent re-vendor
  const again = await post('/api/enable/vendor', { dir, name: 'writing-plans' });
  assert.equal(again.json.already, true);
});

test('vendor: allowlisted but unresolvable on this machine -> 404', async () => {
  const { status } = await post('/api/enable/vendor', { dir: freshRepo(), name: 'requesting-code-review' });
  assert.equal(status, 404);
});

test('vendor: dir resolving into the user-global ~/.claude is rejected 400 (never copied)', async () => {
  const { status, json } = await post('/api/enable/vendor', { dir: homedir(), name: 'writing-plans' });
  assert.equal(status, 400);
  assert.match(json.error, /~?\.claude|user-global|global/);
});

test('vendor: a project .claude that is a SYMLINK into the user-global ~/.claude is rejected 400, not copied through', async () => {
  // The guard compares `path.join(dir, '.claude', 'skills', name)` against
  // ~/.claude lexically. If the project's `.claude` is a symlink into the
  // real (or, here, HOME-overridden "fake") global ~/.claude, a purely lexical
  // prefix check never sees the escape and cpSync would write straight through
  // the symlink into the global config the guard exists to protect.
  const prevHome = process.env.HOME;
  const fakeHome = mkdtempSync(join(tmpdir(), 'enable-vendor-fakehome-'));
  const fakeGlobalClaude = join(fakeHome, '.claude');
  mkdirSync(fakeGlobalClaude, { recursive: true });
  // os.homedir() re-reads process.env.HOME on every call (Node, POSIX), so the
  // server's `path.join(os.homedir(), '.claude')` picks this up per-request —
  // no need to touch the running server or its module state.
  process.env.HOME = fakeHome;
  try {
    const dir = freshRepo();
    symlinkSync(fakeGlobalClaude, join(dir, '.claude'), 'dir');

    const srcSkillDir = join(skillsHome, '.claude', 'skills', 'writing-plans');
    mkdirSync(srcSkillDir, { recursive: true });
    writeFileSync(join(srcSkillDir, 'SKILL.md'), '# writing-plans\n');

    const { status, json } = await post('/api/enable/vendor', { dir, name: 'writing-plans' });
    assert.equal(status, 400);
    assert.match(json.error, /~?\.claude|user-global|global/);
    // nothing landed through the symlink into the (fake) global .claude
    assert.ok(!existsSync(join(fakeGlobalClaude, 'skills', 'writing-plans')));
  } finally {
    process.env.HOME = prevHome;
  }
});
