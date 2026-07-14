// test/cli-validate-flag.test.mjs
//
// The CLI has no exported internals (parseArgs, main are module-private), so
// every test here mirrors cli-branch-flags.test.mjs's mechanism: spawn the
// real CLI binary end-to-end (--mock --yes) and assert on observable
// behavior — stdout phase/log lines and exit codes — rather than reaching
// into `flags` directly. The shell validation gate always uses a REAL shell
// (never mocked), so `--validate <cmd>` deterministically produces a
// "shellGate" phase line and "$ <cmd>" log lines in stdout when (and only
// when) validateCommands reached the orchestrator opts non-empty.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useTempHome } from './helpers/temp-home.mjs';

const CLI = resolve(fileURLToPath(import.meta.url), '..', '..', 'src', 'cli', 'maestro.mjs');

useTempHome(after);

const created = [];
after(() => Promise.all(created.map((d) => rm(d, { recursive: true, force: true }))));
async function freshRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-cli-validate-'));
  created.push(dir);
  const g = (a) => spawnSync('git', a, { cwd: dir });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  await writeFile(join(dir, 'a'), 'a');
  g(['add', '-A']); g(['commit', '-qm', 'init']);
  return dir;
}

function run(args, extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [CLI, ...args],
    { env: { ...process.env, MAESTRO_MOCK: '1', ...extraEnv }, encoding: 'utf8' },
  );
}

test('--help advertises --validate', () => {
  const r = spawnSync(process.execPath, [CLI, '--help']);
  assert.match(r.stdout.toString(), /--validate/);
});

test('repeatable --validate: both commands reach the shell gate, in order', async () => {
  const repo = await freshRepo();
  const r = run([
    '--project', repo, '--prompt', 'demo', '--mock', '--yes',
    '--validate', 'echo VALIDATE_MARK_A',
    '--validate', 'echo VALIDATE_MARK_B',
  ]);
  assert.equal(r.status, 0, `cli failed: ${r.stderr}`);
  assert.match(r.stdout, /shellGate/, 'gate phase should run when --validate is passed');
  const ia = r.stdout.indexOf('VALIDATE_MARK_A');
  const ib = r.stdout.indexOf('VALIDATE_MARK_B');
  assert.ok(ia !== -1, 'first --validate command should have run');
  assert.ok(ib !== -1, 'second --validate command should have run');
  assert.ok(ia < ib, 'commands should run in the order --validate was repeated');
});

test('--validate=<cmd> (equals form) is accepted', async () => {
  const repo = await freshRepo();
  const r = run([
    '--project', repo, '--prompt', 'demo', '--mock', '--yes',
    '--validate=echo VALIDATE_MARK_EQ',
  ]);
  assert.equal(r.status, 0, `cli failed: ${r.stderr}`);
  assert.match(r.stdout, /shellGate/);
  assert.match(r.stdout, /VALIDATE_MARK_EQ/);
});

test('no --validate: gate stays off, orchestrator opts carry no validateCommands', async () => {
  const repo = await freshRepo();
  const r = run(['--project', repo, '--prompt', 'demo', '--mock', '--yes']);
  assert.equal(r.status, 0, `cli failed: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /shellGate/, 'no gate phase should run without --validate');
});

test('no --validate + detectable project: prints one detection hint, gate still off', async () => {
  const repo = await freshRepo();
  await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'echo hi' } }));
  spawnSync('git', ['-C', repo, 'add', '-A']);
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'add package.json']);
  const r = run(['--project', repo, '--prompt', 'demo', '--mock', '--yes']);
  assert.equal(r.status, 0, `cli failed: ${r.stderr}`);
  assert.match(r.stdout, /hint:.*detected.*npm test.*--validate/, 'expected one-line detection hint');
  assert.doesNotMatch(r.stdout, /shellGate/, 'hint alone must not enable the gate');
});

test('--validate passed on a detectable project suppresses the hint', async () => {
  const repo = await freshRepo();
  await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'echo hi' } }));
  spawnSync('git', ['-C', repo, 'add', '-A']);
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'add package.json']);
  const r = run(['--project', repo, '--prompt', 'demo', '--mock', '--yes', '--validate', 'true']);
  assert.equal(r.status, 0, `cli failed: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /hint:.*detected/, 'hint should be suppressed when --validate was passed');
  assert.match(r.stdout, /shellGate/);
});
