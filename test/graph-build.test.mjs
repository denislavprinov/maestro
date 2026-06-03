// test/graph-build.test.mjs
// Unit + integration tests for the in-worktree graphify build: the agent
// instruction, the spawn-with-timeout helper, the orchestrator's
// _buildWorktreeGraph guards, and the end-to-end leak-safety guarantees.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { worktreeGraphInstruction, runGraphifyUpdate } from '../src/core/preflight.mjs';
import { createOrchestrator } from '../src/core/orchestrator.mjs';

const tmpDirs = [];
async function makeTmpDir(prefix = 'maestro-graph-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
// Write an executable fake `graphify` into binDir and return that PATH value.
async function fakeGraphify(binDir, body) {
  await writeFile(join(binDir, 'graphify'), body, 'utf8');
  await chmod(join(binDir, 'graphify'), 0o755);
  return binDir;
}
after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

test('worktreeGraphInstruction: cwd-relative, AST-only, lists the query commands', () => {
  const text = worktreeGraphInstruction();
  assert.match(text, /graphify-out/, 'points at graphify-out/');
  assert.match(text, /AST-only|structural/i, 'calls out AST-only nature');
  assert.match(text, /graphify query/, 'lists query');
  assert.match(text, /graphify explain/, 'lists explain');
  assert.match(text, /graphify path/, 'lists path');
  assert.doesNotMatch(text, /<projectDir>/, 'no dead placeholder');
  assert.doesNotMatch(text, /Skill\(/, 'CLI workflow, not the Skill tool');
});

test('runGraphifyUpdate: success — runs in cwd and targets the dir arg', async () => {
  const binDir = await makeTmpDir('maestro-bin-');
  const work = await makeTmpDir('maestro-work-');   // the dir arg (target)
  const cwd = await makeTmpDir('maestro-cwd-');      // the spawn cwd
  // Fake graphify: prove it received the dir as argv[2] and ran in `cwd`.
  await fakeGraphify(
    binDir,
    '#!/bin/sh\nmkdir -p "$2/graphify-out"\ntouch "$PWD/ran-here"\nexit 0\n',
  );
  const prevPath = process.env.PATH;
  process.env.PATH = binDir + ':' + prevPath; // keep /usr/bin:/bin so mkdir/touch resolve
  try {
    const res = await runGraphifyUpdate({ dir: work, cwd, timeoutMs: 10000 });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.timedOut, false);
    assert.ok(existsSync(join(work, 'graphify-out')), 'graph built under the dir arg');
    assert.ok(existsSync(join(cwd, 'ran-here')), 'spawned with cwd=cwd');
  } finally {
    process.env.PATH = prevPath;
  }
});

test('runGraphifyUpdate: missing binary → ok:false, never throws', async () => {
  const work = await makeTmpDir('maestro-work-');
  const prevPath = process.env.PATH;
  process.env.PATH = ''; // nothing named graphify resolvable (intentional)
  try {
    const res = await runGraphifyUpdate({ dir: work, cwd: work, timeoutMs: 10000 });
    assert.equal(res.ok, false);
  } finally {
    process.env.PATH = prevPath;
  }
});

test('runGraphifyUpdate: non-zero exit → ok:false, timedOut:false (clean failure)', async () => {
  const binDir = await makeTmpDir('maestro-bin-');
  const work = await makeTmpDir('maestro-work-');
  // Binary runs and FAILS — exercises the close(code!==0) branch, distinct from
  // both the missing-binary (spawn error) and the timeout (SIGKILL) paths.
  await fakeGraphify(binDir, '#!/bin/sh\necho "boom" 1>&2\nexit 1\n');
  const prevPath = process.env.PATH;
  process.env.PATH = binDir + ':' + prevPath;
  try {
    const res = await runGraphifyUpdate({ dir: work, cwd: work, timeoutMs: 10000 });
    assert.equal(res.ok, false);
    assert.equal(res.timedOut, false);
    assert.equal(res.code, 1, 'reports the child exit code');
  } finally {
    process.env.PATH = prevPath;
  }
});

test('runGraphifyUpdate: overrun is killed and reported as timedOut', async () => {
  const binDir = await makeTmpDir('maestro-bin-');
  const work = await makeTmpDir('maestro-work-');
  await fakeGraphify(binDir, '#!/bin/sh\nsleep 5\nexit 0\n');
  const prevPath = process.env.PATH;
  process.env.PATH = binDir + ':' + prevPath; // keep /usr/bin:/bin so `sleep` resolves and blocks
  try {
    const res = await runGraphifyUpdate({ dir: work, cwd: work, timeoutMs: 200 });
    assert.equal(res.ok, false);
    assert.equal(res.timedOut, true);
  } finally {
    process.env.PATH = prevPath;
  }
});
