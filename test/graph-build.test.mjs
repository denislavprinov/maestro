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

// --- constructor timeout resolution (spec open question: default + configurable) ---

test('graphBuildTimeoutMs: defaults to 120000 when neither option nor env is set', async () => {
  const dir = await makeTmpDir();
  const prev = process.env.MAESTRO_GRAPH_TIMEOUT_MS;
  delete process.env.MAESTRO_GRAPH_TIMEOUT_MS;
  try {
    const orch = createOrchestrator({ projectDir: dir, prompt: 'x', claude: { mock: true } });
    assert.equal(orch.graphBuildTimeoutMs, 120000);
  } finally {
    if (prev === undefined) delete process.env.MAESTRO_GRAPH_TIMEOUT_MS;
    else process.env.MAESTRO_GRAPH_TIMEOUT_MS = prev;
  }
});

test('graphBuildTimeoutMs: option / env / precedence / invalid-env fallback', async () => {
  const dir = await makeTmpDir();
  const mk = (extra) =>
    createOrchestrator({ projectDir: dir, prompt: 'x', claude: { mock: true }, ...extra });
  const prev = process.env.MAESTRO_GRAPH_TIMEOUT_MS;
  try {
    // Constructor option wins outright (no env).
    delete process.env.MAESTRO_GRAPH_TIMEOUT_MS;
    assert.equal(mk({ graphBuildTimeoutMs: 5000 }).graphBuildTimeoutMs, 5000, 'option used');
    // Env is used when no option is given.
    process.env.MAESTRO_GRAPH_TIMEOUT_MS = '7000';
    assert.equal(mk({}).graphBuildTimeoutMs, 7000, 'env used when no option');
    // Option beats env.
    assert.equal(mk({ graphBuildTimeoutMs: 5000 }).graphBuildTimeoutMs, 5000, 'option beats env');
    // Invalid env falls back to the default.
    process.env.MAESTRO_GRAPH_TIMEOUT_MS = 'not-a-number';
    assert.equal(mk({}).graphBuildTimeoutMs, 120000, 'invalid env → default');
  } finally {
    if (prev === undefined) delete process.env.MAESTRO_GRAPH_TIMEOUT_MS;
    else process.env.MAESTRO_GRAPH_TIMEOUT_MS = prev;
  }
});

// --- _buildWorktreeGraph decision logic, exercised on the raw instance (no full run) ---

function newOrch(projectDir) {
  return createOrchestrator({ projectDir, prompt: 'x', auto: true, claude: { mock: false } });
}

test('_buildWorktreeGraph: mock mode skips the build (offline smoke stays clean)', async () => {
  const dir = await makeTmpDir();
  const orch = createOrchestrator({ projectDir: dir, prompt: 'x', claude: { mock: true } });
  orch.workDir = await makeTmpDir(); // pretend a worktree exists
  orch.state.tools = { kind: 'cli' };
  orch.pipeline = { dir }; // appendAudit/_log target
  orch.toolInstruction = 'SENTINEL';
  await orch._buildWorktreeGraph();
  assert.equal(orch.toolInstruction, 'SENTINEL', 'mock must not touch the instruction');
});

test('_buildWorktreeGraph: no worktree (workDir===projectDir) skips', async () => {
  const dir = await makeTmpDir();
  const orch = newOrch(dir);
  // workDir defaults to projectDir until _setupWorktree runs.
  orch.state.tools = { kind: 'cli' };
  orch.pipeline = { dir };
  orch.toolInstruction = 'SENTINEL';
  await orch._buildWorktreeGraph();
  assert.equal(orch.toolInstruction, 'SENTINEL');
});

test('_buildWorktreeGraph: graphify not on PATH (kind!=cli) clears the instruction', async () => {
  const dir = await makeTmpDir();
  const orch = newOrch(dir);
  orch.workDir = await makeTmpDir();
  orch.state.tools = { kind: 'skill' };
  orch.pipeline = { dir };
  orch.toolInstruction = 'SENTINEL';
  await orch._buildWorktreeGraph();
  assert.equal(orch.toolInstruction, '');
});

test('_buildWorktreeGraph: build failure clears the instruction and logs a warning (fail-safe + observable)', async () => {
  const dir = await makeTmpDir();
  const work = await makeTmpDir('maestro-work-');
  const binDir = await makeTmpDir('maestro-bin-');
  await fakeGraphify(binDir, '#!/bin/sh\necho "kaboom" 1>&2\nexit 1\n'); // on PATH, but fails
  const orch = newOrch(dir);
  orch.workDir = work;
  orch.state.tools = { kind: 'cli' };
  orch.pipeline = { dir };
  orch.toolInstruction = 'SENTINEL';
  // Spy on _log to prove the failure is observable (spec: emit an event on failure).
  const logs = [];
  orch._log = (source, level, text) => logs.push({ source, level, text });
  const prevPath = process.env.PATH;
  process.env.PATH = binDir + ':' + prevPath;
  try {
    await orch._buildWorktreeGraph(); // must NOT throw
  } finally {
    process.env.PATH = prevPath;
  }
  assert.equal(orch.toolInstruction, '', 'instruction cleared on build failure');
  assert.ok(
    logs.some((l) => l.level === 'warn' && /fail|timed out/i.test(l.text)),
    'a warn-level failure event was logged',
  );
});

test('_buildWorktreeGraph: success builds in the worktree and sets the worktree instruction', async () => {
  const dir = await makeTmpDir();
  const work = await makeTmpDir('maestro-work-');
  const binDir = await makeTmpDir('maestro-bin-');
  await fakeGraphify(binDir, '#!/bin/sh\nmkdir -p "$2/graphify-out"\nexit 0\n');
  const orch = newOrch(dir);
  orch.workDir = work;
  orch.state.tools = { kind: 'cli' };
  orch.pipeline = { dir }; // appendAudit writes here
  orch.toolInstruction = 'SENTINEL';
  const prevPath = process.env.PATH;
  process.env.PATH = binDir + ':' + prevPath; // keep /usr/bin:/bin so `mkdir` resolves
  try {
    await orch._buildWorktreeGraph();
  } finally {
    process.env.PATH = prevPath;
  }
  assert.equal(orch.toolInstruction, worktreeGraphInstruction());
  assert.ok(existsSync(join(work, 'graphify-out')), 'graph built inside the worktree');
});

test('_buildWorktreeGraph: success is fail-safe even when the audit write fails', async () => {
  const dir = await makeTmpDir();
  const work = await makeTmpDir('maestro-work-');
  const binDir = await makeTmpDir('maestro-bin-');
  await fakeGraphify(binDir, '#!/bin/sh\nmkdir -p "$2/graphify-out"\nexit 0\n');
  const orch = newOrch(dir);
  orch.workDir = work;
  orch.state.tools = { kind: 'cli' };
  // pipeline.dir is a FILE, so appendAudit's write rejects (ENOTDIR) — the method must still not throw.
  const notADir = join(await makeTmpDir('maestro-pipe-'), 'iam-a-file');
  writeFileSync(notADir, 'x');
  orch.pipeline = { dir: notADir };
  orch.toolInstruction = 'SENTINEL';
  const prevPath = process.env.PATH;
  process.env.PATH = binDir + ':' + prevPath;
  try {
    await orch._buildWorktreeGraph(); // must NOT throw despite the failing audit write
  } finally {
    process.env.PATH = prevPath;
  }
  assert.equal(orch.toolInstruction, worktreeGraphInstruction(), 'instruction still set on success');
  assert.ok(existsSync(join(work, 'graphify-out')), 'graph still built inside the worktree');
});
