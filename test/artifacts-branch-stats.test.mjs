// test/artifacts-branch-stats.test.mjs
// Phase 3.6 — rowToHistoryEntry computes survived + sourceBranch + added/removed
// from the row's branch JSON via the SAME (unchanged) git helpers. Fixtures seed
// DB rows (seedPipelineRow) + store_meta instead of state.json + meta.json.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { _resetForTests } from '../src/core/db.mjs';
import { seedPipelineRow } from './helpers/db-seed.mjs';

let home, prevHome, repo;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'maestro-bs-'));
  prevHome = process.env.MAESTRO_HOME; process.env.MAESTRO_HOME = home;
  _resetForTests(); // open the DB under this temp home
  // A real repo whose feature branch adds one line over main.
  repo = await mkdtemp(join(tmpdir(), 'maestro-repo-'));
  const g = (a) => spawnSync('git', a, { cwd: repo });
  g(['init', '-q', '-b', 'main']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  await writeFile(join(repo, 'f.txt'), 'a\n'); g(['add', '-A']); g(['commit', '-qm', 'init']);
  g(['checkout', '-q', '-b', 'maestro/feat-1']);
  await writeFile(join(repo, 'f.txt'), 'a\nb\n'); g(['add', '-A']); g(['commit', '-qm', 'add b']);
});

after(async () => {
  _resetForTests();
  if (prevHome === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

test('rowToHistoryEntry adds survived + sourceBranch + added/removed for a live branch', async () => {
  const { listPipelines } = await import('../src/core/artifacts.mjs');
  const { projectKey } = await import('../src/core/store.mjs');
  // Seed a pipeline row whose branch points at the repo's feature branch.
  seedPipelineRow({
    id: 'pp-1', projectKey: projectKey(repo), title: 'Feat', status: 'stopped',
    startedAt: '2026-06-01T00:00:00Z',
    branch: { source: 'main', feature: 'maestro/feat-1', branchKept: true },
  });
  const rows = await listPipelines(repo);
  const row = rows.find((r) => r.id === 'pp-1');
  assert.equal(row.branch, 'maestro/feat-1');
  assert.equal(row.sourceBranch, 'main');
  assert.equal(row.survived, true);
  assert.equal(row.added, 1);
  assert.equal(row.removed, 0);
});

test('rowToHistoryEntry reports survived=false when the branch is gone', async () => {
  const { listPipelines } = await import('../src/core/artifacts.mjs');
  const { projectKey } = await import('../src/core/store.mjs');
  seedPipelineRow({
    id: 'pp-2', projectKey: projectKey(repo), title: 'Gone', status: 'done',
    startedAt: '2026-06-01T00:00:00Z',
    branch: { source: 'main', feature: 'maestro/deleted', branchKept: true },
  });
  const row = (await listPipelines(repo)).find((r) => r.id === 'pp-2');
  assert.equal(row.survived, false);
  assert.equal(row.added, 0);
  assert.equal(row.removed, 0);
});

test('listAllPipelines threads store_meta.path so survived/added are computed machine-wide', async () => {
  const { listAllPipelines, writeStoreMeta } = await import('../src/core/artifacts.mjs');
  const { projectKey } = await import('../src/core/store.mjs');
  const key = projectKey(repo);
  // Register the repo via its store_meta row so listAllPipelines hands meta.path
  // into rowToHistoryEntry as the git repo root.
  writeStoreMeta(key, 'project', { key, name: 'Repo', path: repo });

  const rows = await listAllPipelines();
  const row = rows.find((r) => r.id === 'pp-1');
  assert.ok(row, 'pp-1 present in machine-wide history');
  assert.equal(row.projectDir, repo);
  assert.equal(row.survived, true);
  assert.equal(row.added, 1);
  assert.equal(row.removed, 0);
});
