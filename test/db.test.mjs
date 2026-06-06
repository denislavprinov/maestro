// test/db.test.mjs
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getDb, closeDb, _resetForTests, prepare, tx } from '../src/core/db.mjs';
import { maestroHome } from '../src/core/projects.mjs';

// Each test gets its own MAESTRO_HOME so the singleton DB path is fresh and
// isolated; _resetForTests() drops the cached handle so the next getDb() reopens
// against the new home. Mirrors the temp-home discipline in projects.test.mjs.
// A14: realpath() canonicalizes the temp dir so db.location() (which resolves
// symlinks on macOS) agrees with maestroHome() (which does not canonicalize).
const homes = [];
async function freshHome() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'maestro-db-')));
  homes.push(dir);
  _resetForTests();
  process.env.MAESTRO_HOME = dir;
  return dir;
}

beforeEach(async () => {
  await freshHome();
});

after(async () => {
  _resetForTests();
  delete process.env.MAESTRO_HOME;
  await Promise.all(homes.map((d) => rm(d, { recursive: true, force: true })));
});

test('getDb() opens a DatabaseSync at <maestroHome>/maestro.db', () => {
  const db = getDb();
  assert.ok(db, 'getDb() returns a handle');
  const dbPath = join(maestroHome(), 'maestro.db');
  assert.equal(db.location(), dbPath, 'db.location() is <maestroHome>/maestro.db');
  assert.ok(existsSync(dbPath), 'the db file is created on disk');
});

test('getDb() is a singleton — same handle across calls', () => {
  assert.equal(getDb(), getDb(), 'repeated getDb() returns the same instance');
});

test('closeDb() then getDb() reopens a fresh handle', () => {
  const a = getDb();
  closeDb();
  const b = getDb();
  assert.notEqual(a, b, 'a new handle is created after closeDb()');
});
