// test/cli-subcommands.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, '..', 'src', 'cli', 'maestro.mjs');

const created = [];
async function freshHome() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-cli-'));
  created.push(dir);
  return dir;
}
async function freshProj() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-proj-'));
  created.push(dir);
  // Canonicalize to match what process.cwd() reports inside the spawned child
  // (macOS resolves /var -> /private/var and /tmp -> /private/tmp on getcwd).
  return realpath(dir);
}
after(() => Promise.all(created.map((d) => rm(d, { recursive: true, force: true }))));

function run(args, { home, cwd, extraEnv } = {}) {
  return new Promise((res) => {
    const env = { ...process.env };
    if (home) env.MAESTRO_HOME = home;
    if (extraEnv) Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('exit', (code) => res({ code: code ?? 0, stdout, stderr }));
  });
}

// Escape a string for safe inclusion as a literal in a RegExp.
function reEsc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('add uses cwd basename as default name', async () => {
  const home = await freshHome();
  const proj = await freshProj();
  const r = await run(['add'], { home, cwd: proj });
  assert.equal(r.code, 0, r.stderr);
  const expectedName = proj.split('/').pop();
  assert.match(r.stdout, new RegExp(`Added project "${reEsc(expectedName)}" -> ${reEsc(proj)}`));
  const list = await run(['list'], { home });
  assert.equal(list.code, 0);
  assert.match(list.stdout, new RegExp(`${reEsc(expectedName)}\\t${reEsc(proj)}`));
});

test('add accepts explicit name and --path', async () => {
  const home = await freshHome();
  const r = await run(['add', 'demo', '--path', '/tmp/nope-explicit'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Added project "demo" -> \/tmp\/nope-explicit/);
});

test('add supports --path=<dir> form', async () => {
  const home = await freshHome();
  const r = await run(['add', 'demo', '--path=/tmp/nope-inline'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /-> \/tmp\/nope-inline/);
});

test('add expands a leading ~ in --path using HOME', async () => {
  const home = await freshHome();
  // Force a known HOME for the spawned CLI so we can predict the expansion.
  const fakeHome = '/tmp/maestro-fake-home';
  const r = await run(['add', 'demo', '--path=~/sub/dir'], { home, extraEnv: { HOME: fakeHome } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`-> ${reEsc(fakeHome)}/sub/dir`));
});

test('add rejects --path without a value (exit 2)', async () => {
  const home = await freshHome();
  const r = await run(['add', 'demo', '--path'], { home });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--path requires a value/);
});

test('add rejects unknown flag (exit 2)', async () => {
  const home = await freshHome();
  const r = await run(['add', 'demo', '--bogus'], { home });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown flag: --bogus/);
});

test('duplicate add exits 1 with stderr message', async () => {
  const home = await freshHome();
  await run(['add', 'demo', '--path', '/tmp/x'], { home });
  const r = await run(['add', 'demo', '--path', '/tmp/y'], { home });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already exists/);
});

test('list on empty registry prints hint and exits 0', async () => {
  const home = await freshHome();
  const r = await run(['list'], { home });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /No projects registered/);
});

test('list shows entries, marks missing ones', async () => {
  const home = await freshHome();
  await run(['add', 'ghost', '--path', '/no/such/dir/x'], { home });
  const r = await run(['list'], { home });
  assert.equal(r.code, 0);
  // stdout is from a non-TTY pipe, so [missing] is uncolored.
  assert.match(r.stdout, /ghost\t\/no\/such\/dir\/x\t\[missing\]/);
});

test('remove without name exits 2 (usage)', async () => {
  const home = await freshHome();
  const r = await run(['remove'], { home });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Usage: maestro remove/);
});

test('remove on unknown name exits 1', async () => {
  const home = await freshHome();
  const r = await run(['remove', 'nope'], { home });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /No project named "nope"/);
});

test('remove drops the entry, exits 0', async () => {
  const home = await freshHome();
  await run(['add', 'demo', '--path', '/tmp/x'], { home });
  const r = await run(['remove', 'demo'], { home });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Removed project "demo"/);
  const list = await run(['list'], { home });
  assert.match(list.stdout, /No projects registered/);
});

test('--help shows Subcommands section and does not regress', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Subcommands:/);
  assert.match(r.stdout, /^\s+add\b/m);
  assert.match(r.stdout, /^\s+list\b/m);
  assert.match(r.stdout, /^\s+remove\b/m);
});
