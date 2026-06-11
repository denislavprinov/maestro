// test/db-schema-sentinel.test.mjs
//
// A db file whose user_version claims the latest schema but is MISSING the
// objects our migrations create (e.g. stamped by a diverged checkout whose
// migration numbering collided) must fail LOUDLY on open — not silently
// fast-path and then die on the first INSERT with a cryptic column error.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, _resetForTests, dbPath } from '../src/core/db.mjs';
import { maestroHome } from '../src/core/projects.mjs';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite');

const homes = [];
beforeEach(async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'maestro-sentinel-')));
  homes.push(dir);
  _resetForTests();
  process.env.MAESTRO_HOME = dir;
});
after(async () => {
  _resetForTests();
  delete process.env.MAESTRO_HOME;
  await Promise.all(homes.map((d) => rm(d, { recursive: true, force: true })));
});

test('opening a db stamped at the latest version but missing migration objects throws actionably', () => {
  // Simulate a foreign checkout's db: it claims the latest user_version but
  // its "v5" was a different migration — pipelines exists without resume_point.
  mkdirSync(maestroHome(), { recursive: true });
  const seed = new DatabaseSync(dbPath());
  seed.exec(`CREATE TABLE pipelines (id TEXT PRIMARY KEY, project_key TEXT NOT NULL);`);
  seed.exec('PRAGMA user_version = 99'); // any value >= SCHEMA_VERSION fast-paths migrate()
  seed.close();

  assert.throws(
    () => getDb(),
    (err) => /diverged|different .*checkout|missing/i.test(err.message),
    'getDb() must throw a descriptive schema-mismatch error'
  );
});

test('a healthy freshly-migrated db passes the sentinel check', () => {
  const db = getDb(); // fresh home -> full migration ladder runs
  assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('pipelines') WHERE name='resume_point'").get(),
    'freshly migrated db has the v5 sentinel column');
  _resetForTests();
  assert.ok(getDb(), 're-open of a healthy db does not throw');
});
