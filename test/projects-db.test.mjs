// test/projects-db.test.mjs
// projects.mjs persists the named-project registry in SQLite (table: projects).
// Signatures are unchanged (listProjects/addProject/removeProject stay async and
// return the SAME annotated shapes). Each test gets a throwaway MAESTRO_HOME and
// resets the DB singleton so getDb() reopens against it.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addProject, removeProject, listProjects } from '../src/core/projects.mjs';
import { getDb, _resetForTests } from '../src/core/db.mjs';

const homes = [];
async function freshHome() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-projdb-'));
  homes.push(dir);
  _resetForTests();
  process.env.MAESTRO_HOME = dir;
  return dir;
}
beforeEach(freshHome);
after(async () => {
  _resetForTests();
  delete process.env.MAESTRO_HOME;
  await Promise.all(homes.map((d) => rm(d, { recursive: true, force: true })));
});

test('listProjects returns [] when the projects table is empty', async () => {
  assert.deepEqual(await listProjects(), []);
});

test('listProjects reads rows from the DB and recomputes exists on read', async () => {
  const home = homes[homes.length - 1];
  // Insert a row directly (real dir => exists:true) to prove listProjects reads the DB.
  const db = getDb();
  db.prepare('INSERT INTO projects (key, name, path, created_at) VALUES (?, ?, ?, ?)')
    .run('k1', 'demo', home, '2026-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO projects (key, name, path, created_at) VALUES (?, ?, ?, ?)')
    .run('k2', 'ghost', '/no/such/dir/here', '2026-01-02T00:00:00.000Z');
  const list = await listProjects();
  const byName = Object.fromEntries(list.map((p) => [p.name, p]));
  assert.equal(byName.demo.path, home);
  assert.equal(byName.demo.exists, true, 'real dir => exists true (recomputed)');
  assert.equal(byName.ghost.exists, false, 'missing dir => exists false (recomputed)');
  // The returned shape is exactly {name, path, exists} — no DB-only fields leak.
  assert.deepEqual(Object.keys(byName.demo).sort(), ['exists', 'name', 'path']);
});
