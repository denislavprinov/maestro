// test/list-all-pipelines.test.mjs
// Phase 3.6 — listAllPipelines SELECTs from the pipelines table; project/workspace
// names come from store_meta rows. Fixtures now seed DB rows (via seedPipelineRow)
// + store_meta (via writeStoreMeta), not state.json + meta.json files. The wire
// shape is identical to the legacy walk, so the assertions are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAllPipelines, writeStoreMeta } from '../src/core/artifacts.mjs';
import { _resetForTests } from '../src/core/db.mjs';
import { seedPipelineRow } from './helpers/db-seed.mjs';

function seed(key, name, id, title) {
  if (name != null) writeStoreMeta(key, 'project', { key, path: '/x/' + key, name });
  seedPipelineRow({ id, projectKey: key, title, status: 'done', startedAt: '2026-06-01T00:00:00Z',
                    updatedAt: '2026-06-01T00:00:00Z' });
}
function seedWorkspace(wkey, name, id, title, projectPaths) {
  writeStoreMeta(wkey, 'workspace', { key: wkey, id: wkey, name, projectKeys: [], projectPaths });
  seedPipelineRow({ id, workspaceKey: wkey, target: 'workspace', title, status: 'done',
                    startedAt: '2026-06-02T00:00:00Z', updatedAt: '2026-06-02T00:00:00Z' });
}

test('listAllPipelines merges every store key, tags project, sorts newest-first', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maestro-all-'));
  const prev = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = home;
  _resetForTests();
  try {
    seed('alpha-00000001', 'Alpha', 'a1', 'Alpha run');
    seed('beta-00000002', 'Beta', 'b1', 'Beta run');
    seed('orphan-00000003', null, 'o1', 'Orphan run'); // no store_meta
    const all = await listAllPipelines();
    assert.equal(all.length, 3);
    const byId = Object.fromEntries(all.map((p) => [p.id, p]));
    assert.equal(byId.a1.projectName, 'Alpha');
    assert.equal(byId.a1.projectKey, 'alpha-00000001');
    assert.equal(byId.o1.projectName, 'orphan-00000003', 'orphan falls back to the key');
  } finally {
    _resetForTests();
    if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev;
  }
});

test('listAllPipelines descends workspaces/ and tags the row with a composite key + target', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maestro-allws-'));
  const prev = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = home;
  _resetForTests();
  try {
    seed('alpha-00000001', 'Alpha', 'a1', 'Alpha run');
    seedWorkspace('wks-demo-9f3a1c20', 'Demo WS', 'w1', 'WS run', ['/abs/one', '/abs/two']);
    const all = await listAllPipelines();
    assert.equal(all.length, 2, 'project row + workspace row, NOT a bogus "workspaces" key row');
    const ws = all.find((p) => p.id === 'w1');
    assert.ok(ws, 'workspace pipeline discovered by the machine-wide walker');
    assert.equal(ws.projectKey, 'workspaces/wks-demo-9f3a1c20', 'literal store-relative composite key');
    assert.equal(ws.target, 'workspace');
    assert.equal(ws.projectName, 'Demo WS', 'name from the workspace meta');
    assert.equal(ws.workspaceName, 'Demo WS', 'explicit workspaceName the History UI prefers');
    assert.equal(ws.projectDir, '/abs/one', 'primary projectPaths[0]');
    // The single-project row keeps target undefined (or non-workspace).
    const proj = all.find((p) => p.id === 'a1');
    assert.notEqual(proj.target, 'workspace');
  } finally {
    _resetForTests();
    if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev;
  }
});

test('listAllPipelines returns [] when the store is absent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maestro-all-empty-'));
  const prev = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = home;
  _resetForTests();
  try { assert.deepEqual(await listAllPipelines(), []); }
  finally {
    _resetForTests();
    if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev;
  }
});

test('listAllPipelines orders equal-mtime rows deterministically by (projectKey,id)', async () => {
  // The build runs in parallel batches, so equal-mtime rows must not reorder
  // run-to-run. The sort tiebreaker keys on (projectKey, id). Seeding both rows
  // with the SAME updatedAt makes mtime tie so only the tiebreaker decides.
  const home = await mkdtemp(join(tmpdir(), 'maestro-all-det-'));
  const prev = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = home;
  _resetForTests();
  try {
    seed('zeta-00000009', 'Zeta', 'z1', 'Zeta run');
    seed('alpha-00000001', 'Alpha', 'a1', 'Alpha run');
    const order1 = (await listAllPipelines()).map((p) => `${p.projectKey}/${p.id}`);
    const order2 = (await listAllPipelines()).map((p) => `${p.projectKey}/${p.id}`);
    assert.deepEqual(order1, order2, 'stable across repeated calls');
    assert.deepEqual(order1, ['alpha-00000001/a1', 'zeta-00000009/z1'],
      'projectKey asc then id asc when mtimes tie');
  } finally {
    _resetForTests();
    if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev;
  }
});
