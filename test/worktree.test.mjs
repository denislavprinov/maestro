// test/worktree.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  sanitizeBranchName,
  suggestBranchName,
  listLocalBranches,
  currentBranch,
  resolveDefaultBranch,
  createWorktree,
  removeWorktree,
} from '../src/core/worktree.mjs';

const created = [];
async function freshRepo({ initialBranch = 'main' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-wt-'));
  created.push(dir);
  const g = (args) => spawnSync('git', args, { cwd: dir });
  g(['init', '-q', '-b', initialBranch]);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  await writeFile(join(dir, 'README.md'), '# hi\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);
  return dir;
}
after(() => Promise.all(created.map((d) => rm(d, { recursive: true, force: true }))));

test('sanitizeBranchName: kebab, strips junk, forbids leading slash', () => {
  assert.equal(sanitizeBranchName('Add Multi Branch!!'), 'add-multi-branch');
  assert.equal(sanitizeBranchName('feat/Foo Bar'), 'feat/foo-bar');
  assert.equal(sanitizeBranchName('   '), '');
  assert.equal(sanitizeBranchName('--bad--'), 'bad');
  assert.equal(sanitizeBranchName('a..b'), 'a-b');
  assert.equal(sanitizeBranchName('weird@{ref}'), 'weird-ref');
  assert.ok(sanitizeBranchName('a'.repeat(120)).length <= 80);
});

test('suggestBranchName (mock): derives from prompt deterministically', async () => {
  const name = await suggestBranchName({
    prompt: 'Add login screen with Google SSO',
    pipelineId: 'abc12345',
    mock: true,
  });
  assert.match(name, /^maestro\/add-login-screen-with-google-sso-abc12345$/);
});

test('listLocalBranches returns the initial branch', async () => {
  const repo = await freshRepo();
  const branches = await listLocalBranches(repo);
  assert.ok(branches.includes('main'), `expected main in ${branches.join(',')}`);
});

test('resolveDefaultBranch picks the actual HEAD even when not "main"', async () => {
  const repo = await freshRepo({ initialBranch: 'master' });
  assert.equal(await resolveDefaultBranch(repo), 'master');
});

test('createWorktree checks out a new branch from source in an isolated dir', async () => {
  const repo = await freshRepo();
  const wt = await createWorktree({
    projectDir: repo,
    pipelineId: 'pid1',
    sourceBranch: 'main',
    featureBranch: 'maestro/x-pid1',
  });
  assert.match(wt.worktreeDir, /\.maestro\/worktrees\/pid1$/);
  assert.equal(wt.branch, 'maestro/x-pid1');
  assert.equal(wt.reusedExisting, false);
  const head = spawnSync('git', ['-C', wt.worktreeDir, 'rev-parse', '--abbrev-ref', 'HEAD']);
  assert.equal(head.stdout.toString().trim(), 'maestro/x-pid1');
});

test('two worktrees on the same project coexist (concurrent runs)', async () => {
  const repo = await freshRepo();
  const a = await createWorktree({ projectDir: repo, pipelineId: 'a', sourceBranch: 'main', featureBranch: 'maestro/a' });
  const b = await createWorktree({ projectDir: repo, pipelineId: 'b', sourceBranch: 'main', featureBranch: 'maestro/b' });
  assert.notEqual(a.worktreeDir, b.worktreeDir);
  const list = await listLocalBranches(repo);
  assert.ok(list.includes('maestro/a'));
  assert.ok(list.includes('maestro/b'));
});

test('createWorktree reuses an existing branch and reports reusedExisting=true', async () => {
  const repo = await freshRepo();
  spawnSync('git', ['-C', repo, 'branch', 'maestro/resume']);
  const wt = await createWorktree({
    projectDir: repo, pipelineId: 'r1', sourceBranch: 'main', featureBranch: 'maestro/resume',
  });
  assert.equal(wt.reusedExisting, true);
});

test('removeWorktree prunes the dir + branch', async () => {
  const repo = await freshRepo();
  const wt = await createWorktree({ projectDir: repo, pipelineId: 'gone', sourceBranch: 'main', featureBranch: 'maestro/gone' });
  await removeWorktree({ projectDir: repo, worktreeDir: wt.worktreeDir, branch: wt.branch, force: true });
  const list = await listLocalBranches(repo);
  assert.ok(!list.includes('maestro/gone'));
});

test('createWorktree throws a useful error when sourceBranch is missing', async () => {
  const repo = await freshRepo();
  await assert.rejects(
    () => createWorktree({ projectDir: repo, pipelineId: 'oops', sourceBranch: 'no-such-branch', featureBranch: 'maestro/x' }),
    /git worktree add failed/,
  );
});

// currentBranch sanity (separate so failure points are obvious).
test('currentBranch returns the HEAD branch name', async () => {
  const repo = await freshRepo();
  assert.equal(await currentBranch(repo), 'main');
});
