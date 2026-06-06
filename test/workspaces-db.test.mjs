// test/workspaces-db.test.mjs
// workspaces.mjs stores the workspace registry in SQLite (workspaces +
// workspace_projects). Signatures unchanged; derived projectKeys/exists are
// recomputed on read. Members must be real git repos (createWorkspace validates).
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  workspaceKey, listWorkspaces, readWorkspace, createWorkspace,
} from '../src/core/workspaces.mjs';
import { projectKey } from '../src/core/store.mjs';
import { getDb, _resetForTests } from '../src/core/db.mjs';

const created = [];
async function freshHome() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-wsdb-home-'));
  created.push(dir);
  _resetForTests();
  process.env.MAESTRO_HOME = dir;
  return dir;
}
async function freshRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-wsdb-repo-'));
  created.push(dir);
  const g = (a) => spawnSync('git', a, { cwd: dir });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  await writeFile(join(dir, 'README.md'), '# hi\n');
  g(['add', '-A']); g(['commit', '-qm', 'init']);
  return dir;
}
beforeEach(freshHome);
after(async () => {
  _resetForTests();
  delete process.env.MAESTRO_HOME;
  await Promise.all(created.map((d) => rm(d, { recursive: true, force: true })));
});

test('listWorkspaces / readWorkspace are [] / null on an empty store', async () => {
  assert.deepEqual(await listWorkspaces(), []);
  assert.equal(await readWorkspace('wks-nope-00000000'), null);
  assert.equal(await readWorkspace(''), null);
});

test('createWorkspace persists workspace + member rows; readWorkspace annotates derived fields', async () => {
  const a = await freshRepo();
  const b = await freshRepo();
  const ws = await createWorkspace({ name: 'Demo WS', projectPaths: [a, b], description: 'desc' });
  assert.equal(ws.id, workspaceKey({ name: 'Demo WS', projectPaths: [a, b] }));
  assert.equal(ws.description, 'desc');

  // workspaces row + 2 member rows persisted.
  const db = getDb();
  const wrow = db.prepare('SELECT name, description FROM workspaces WHERE id = ?').get(ws.id);
  assert.equal(wrow.name, 'Demo WS');
  const members = db.prepare(
    'SELECT project_key, ordinal FROM workspace_projects WHERE workspace_id = ? ORDER BY ordinal'
  ).all(ws.id);
  assert.equal(members.length, 2);
  assert.deepEqual(members.map((m) => m.ordinal), [0, 1], 'ordinal preserves persisted order');

  // readWorkspace returns annotated derived fields (projectKeys sorted, exists[]).
  const got = await readWorkspace(ws.id);
  assert.ok(Array.isArray(got.projectKeys) && got.projectKeys.length === 2);
  assert.deepEqual(got.projectKeys, [...got.projectKeys].sort(), 'projectKeys sorted ascending');
  for (let i = 0; i < got.projectKeys.length; i++) {
    assert.equal(got.projectKeys[i], projectKey(got.projectPaths[i]), 'projectKeys index-aligned with paths');
  }
  assert.deepEqual(got.exists, [true, true]);
});

test('listWorkspaces marks a vanished member exists=false but keeps the workspace', async () => {
  const a = await freshRepo();
  const b = await freshRepo();
  await createWorkspace({ name: 'Vanish', projectPaths: [a, b] });
  await rm(b, { recursive: true, force: true });
  const [ws] = await listWorkspaces();
  assert.equal(ws.projectPaths.length, 2);
  const idx = ws.projectPaths.indexOf(b);
  assert.equal(ws.exists[idx], false);
});
