// test/orchestrator-worktree.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
