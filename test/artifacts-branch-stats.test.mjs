// test/artifacts-branch-stats.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let home, prevHome, repo;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'maestro-bs-'));
  prevHome = process.env.MAESTRO_HOME; process.env.MAESTRO_HOME = home;
  // A real repo whose feature branch adds one line over main.
  repo = await mkdtemp(join(tmpdir(), 'maestro-repo-'));
  const g = (a) => spawnSync('git', a, { cwd: repo });
  g(['init', '-q', '-b', 'main']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  await writeFile(join(repo, 'f.txt'), 'a\n'); g(['add', '-A']); g(['commit', '-qm', 'init']);
  g(['checkout', '-q', '-b', 'maestro/feat-1']);
  await writeFile(join(repo, 'f.txt'), 'a\nb\n'); g(['add', '-A']); g(['commit', '-qm', 'add b']);
});

after(async () => {
  if (prevHome === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

test('pipelineEntry adds survived + sourceBranch + added/removed for a live branch', async () => {
  const { listPipelines, artifactPaths } = await import('../src/core/artifacts.mjs');
  // Seed a pipeline whose state.branch points at the repo's feature branch.
  const dir = join(artifactPaths(repo).pipelines, 'pp-1');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    id: 'pp-1', title: 'Feat', status: 'stopped', projectDir: repo,
    branch: { source: 'main', feature: 'maestro/feat-1', branchKept: true },
  }), 'utf8');

  const rows = await listPipelines(repo);
  const row = rows.find((r) => r.id === 'pp-1');
  assert.equal(row.branch, 'maestro/feat-1');
  assert.equal(row.sourceBranch, 'main');
  assert.equal(row.survived, true);
  assert.equal(row.added, 1);
  assert.equal(row.removed, 0);
});

test('pipelineEntry reports survived=false when the branch is gone', async () => {
  const { listPipelines, artifactPaths } = await import('../src/core/artifacts.mjs');
  const dir = join(artifactPaths(repo).pipelines, 'pp-2');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    id: 'pp-2', title: 'Gone', status: 'done', projectDir: repo,
    branch: { source: 'main', feature: 'maestro/deleted', branchKept: true },
  }), 'utf8');
  const row = (await listPipelines(repo)).find((r) => r.id === 'pp-2');
  assert.equal(row.survived, false);
  assert.equal(row.added, 0);
  assert.equal(row.removed, 0);
});

test('listAllPipelines threads meta.path so survived/added are computed machine-wide', async () => {
  const { listAllPipelines } = await import('../src/core/artifacts.mjs');
  // Register the repo as an onboarded project via its store meta.json so that
  // listAllPipelines hands meta.path into pipelineEntry as the git repo root.
  const { projectKey, projectStorePath } = await import('../src/core/store.mjs');
  const key = projectKey(repo);
  await writeFile(join(projectStorePath(key), 'meta.json'),
    JSON.stringify({ key, name: 'Repo', path: repo }), 'utf8');

  const rows = await listAllPipelines();
  const row = rows.find((r) => r.id === 'pp-1');
  assert.ok(row, 'pp-1 present in machine-wide history');
  assert.equal(row.projectDir, repo);
  assert.equal(row.survived, true);
  assert.equal(row.added, 1);
  assert.equal(row.removed, 0);
});
