// test/orchestrator-worktree.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { createOrchestrator } from '../src/core/orchestrator.mjs';

const created = [];
after(() => Promise.all(created.map((d) => rm(d, { recursive: true, force: true }))));

async function freshRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-orch-'));
  created.push(dir);
  const g = (args) => spawnSync('git', args, { cwd: dir });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  await writeFile(join(dir, 'seed.txt'), 'seed\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);
  return dir;
}

test('orchestrator creates a worktree on source branch with a derived feature branch', async () => {
  const repo = await freshRepo();
  const orch = createOrchestrator({
    projectDir: repo,
    prompt: 'Add login flow',
    auto: true,
    claude: { mock: true },
    branch: { source: 'main' },
  });
  const result = await orch.run();
  assert.equal(result.status, 'done', JSON.stringify(result));

  const wtBase = join(repo, '.maestro', 'worktrees');
  assert.ok(existsSync(wtBase), 'worktrees base dir should exist');

  const state = orch.getState();
  assert.ok(state.branch, 'state.branch should be set');
  assert.equal(state.branch.source, 'main');
  assert.match(state.branch.feature, /^maestro\//);
  assert.match(state.branch.worktreeDir, /\.maestro\/worktrees\//);
  assert.equal(state.branch.reusedExisting, false);

  const head = spawnSync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD']);
  assert.equal(head.stdout.toString().trim(), 'main');
});

test('explicit featureBranch is honored verbatim (after sanitize)', async () => {
  const repo = await freshRepo();
  const orch = createOrchestrator({
    projectDir: repo,
    prompt: 'whatever',
    auto: true,
    claude: { mock: true },
    branch: { source: 'main', feature: 'feat/my-thing' },
  });
  await orch.run();
  assert.equal(orch.getState().branch.feature, 'feat/my-thing');
});

// ── C1: worktree lifecycle (teardown actually runs) ──────────────────────────
function branchList(dir) {
  return spawnSync('git', ['-C', dir, 'branch', '--format=%(refname:short)'])
    .stdout.toString().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

test('C1: on done the worktree dir is removed but the feature branch is kept', async () => {
  const repo = await freshRepo();
  const orch = createOrchestrator({
    projectDir: repo, prompt: 'Add login flow', auto: true, claude: { mock: true }, branch: { source: 'main' },
  });
  const result = await orch.run();
  assert.equal(result.status, 'done', JSON.stringify(result));
  const feature = orch.getState().branch.feature;
  const wtDir = orch.getState().branch.worktreeDir;
  assert.ok(!existsSync(wtDir), `worktree dir should be removed, still present: ${wtDir}`);
  assert.ok(branchList(repo).includes(feature), `feature branch ${feature} should be KEPT on success`);
});

test('C1: on stop the worktree dir AND the freshly-created branch are removed', async () => {
  const repo = await freshRepo();
  const orch = createOrchestrator({
    projectDir: repo, prompt: 'x', auto: true, claude: { mock: true }, branch: { source: 'main' },
  });
  // Stop as soon as the worktree exists; the next _checkAbort aborts the run.
  orch.on('state', (s) => { if (s.branch && s.branch.feature) orch.stop(); });
  const result = await orch.run();
  assert.equal(result.status, 'stopped', JSON.stringify(result));
  const feature = orch.getState().branch.feature;
  const wtDir = orch.getState().branch.worktreeDir;
  assert.ok(!existsSync(wtDir), 'worktree dir should be removed on stop');
  assert.ok(!branchList(repo).includes(feature), `freshly-created branch ${feature} should be removed on stop`);
});

// ── C2: nested projectDir must NOT mutate the enclosing repo ──────────────────
test('C2: a projectDir nested in an enclosing repo gets its own repo, parent untouched', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'maestro-parent-'));
  created.push(parent);
  const gp = (a) => spawnSync('git', a, { cwd: parent });
  gp(['init', '-q', '-b', 'main']);
  gp(['config', 'user.email', 't@t']); gp(['config', 'user.name', 't']);
  await writeFile(join(parent, 'root.txt'), 'root\n');
  gp(['add', '-A']); gp(['commit', '-qm', 'init']);

  // Nested dir with NO .git of its own (this is the C2 footgun).
  const sub = join(parent, 'sub');
  await mkdir(sub, { recursive: true });
  await writeFile(join(sub, 'app.txt'), 'app\n');

  const orch = createOrchestrator({ projectDir: sub, prompt: 'x', auto: true, claude: { mock: true } });
  const result = await orch.run();
  assert.equal(result.status, 'done', JSON.stringify(result));

  assert.ok(existsSync(join(sub, '.git')), 'sub should have been given its OWN git repo');
  const feature = orch.getState().branch.feature;
  assert.ok(branchList(sub).includes(feature), `feature branch should live in sub's repo`);
  assert.ok(!branchList(parent).includes(feature), `parent repo must NOT have ${feature}`);
  assert.ok(!branchList(parent).some((b) => b.startsWith('maestro/')), 'parent repo must have no maestro/* branches');
});

test('source branch defaults to actual HEAD when not "main"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-master-'));
  created.push(dir);
  const g = (args) => spawnSync('git', args, { cwd: dir });
  g(['init', '-q', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  await writeFile(join(dir, 'a.txt'), 'a\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);
  const orch = createOrchestrator({
    projectDir: dir, prompt: 'x', auto: true, claude: { mock: true },
  });
  await orch.run();
  assert.equal(orch.getState().branch.source, 'master');
});
