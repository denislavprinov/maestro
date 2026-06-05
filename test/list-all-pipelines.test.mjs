// test/list-all-pipelines.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAllPipelines } from '../src/core/artifacts.mjs';
import { storeRoot, workspacesStoreRoot } from '../src/core/store.mjs';

async function seed(key, name, id, title) {
  const dir = join(storeRoot(), key, 'pipelines', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'),
    JSON.stringify({ id, title, status: 'done', startedAt: '2026-06-01T00:00:00Z' }), 'utf8');
  if (name != null) {
    await writeFile(join(storeRoot(), key, 'meta.json'),
      JSON.stringify({ key, path: '/x/' + key, name }), 'utf8');
  }
}

test('listAllPipelines merges every store key, tags project, sorts newest-first', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maestro-all-'));
  const prev = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = home;
  try {
    await seed('alpha-00000001', 'Alpha', 'a1', 'Alpha run');
    await seed('beta-00000002', 'Beta', 'b1', 'Beta run');
    await seed('orphan-00000003', null, 'o1', 'Orphan run'); // no meta.json
    const all = await listAllPipelines();
    assert.equal(all.length, 3);
    const byId = Object.fromEntries(all.map((p) => [p.id, p]));
    assert.equal(byId.a1.projectName, 'Alpha');
    assert.equal(byId.a1.projectKey, 'alpha-00000001');
    assert.equal(byId.o1.projectName, 'orphan-00000003', 'orphan falls back to the key');
  } finally { if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev; }
});

async function seedWorkspace(wkey, name, id, title, projectPaths) {
  const dir = join(workspacesStoreRoot(), wkey, 'pipelines', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'),
    JSON.stringify({ id, title, status: 'done', target: 'workspace', startedAt: '2026-06-02T00:00:00Z' }), 'utf8');
  await writeFile(join(workspacesStoreRoot(), wkey, 'meta.json'),
    JSON.stringify({ key: wkey, id: wkey, name, projectKeys: [], projectPaths }), 'utf8');
}

test('listAllPipelines descends workspaces/ and tags the row with a composite key + target', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maestro-allws-'));
  const prev = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = home;
  try {
    await seed('alpha-00000001', 'Alpha', 'a1', 'Alpha run');
    await seedWorkspace('wks-demo-9f3a1c20', 'Demo WS', 'w1', 'WS run', ['/abs/one', '/abs/two']);
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
  } finally { if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev; }
});

test('listAllPipelines returns [] when the store is absent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maestro-all-empty-'));
  const prev = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = home;
  try { assert.deepEqual(await listAllPipelines(), []); }
  finally { if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev; }
});
