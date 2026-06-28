// test/workflows-domain-reconcile.test.mjs  (structure copied from subagent-migration-v8.test.mjs)
//
// Regression for the two-checkout schema collision: a shared ~/.maestro/maestro.db can be
// stamped to a user_version PAST the v8->v9 step (which adds workflows.domain) by a DIVERGENT
// migration ladder that never actually added the column. The version-gated ladder then skips
// SCHEMA_V9 (current >= 9), so the column stays missing and the UI's stale-run reconcile fails
// with "table workflows has no column named domain". reconcileColumns()/addMissingIncrementalColumns()
// make migrate() self-heal that DB regardless of user_version.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { getDb, dbPath, _resetForTests } from '../src/core/db.mjs';
import { maestroHome } from '../src/core/projects.mjs';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite');
const homes = [];
beforeEach(async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'maestro-domain-')));
  homes.push(dir); _resetForTests(); process.env.MAESTRO_HOME = dir;
});
after(async () => { _resetForTests(); delete process.env.MAESTRO_HOME; await Promise.all(homes.map((d) => rm(d, { recursive: true, force: true }))); });

// A workflows table at its v1 shape — NO domain column — exactly the prod schema observed.
const WORKFLOWS_NO_DOMAIN = `
CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT, version INTEGER NOT NULL DEFAULT 1, steps TEXT, feedbacks TEXT, created_at TEXT, updated_at TEXT);
`;

test('user_version=10 DB whose ladder skipped the domain ALTER self-heals + seeds on open', () => {
  mkdirSync(maestroHome(), { recursive: true });
  const seed = new DatabaseSync(dbPath());
  seed.exec(WORKFLOWS_NO_DOMAIN);
  seed.exec('PRAGMA user_version = 10'); // stamped past v9 by a divergent ladder
  assert.ok(!seed.prepare('PRAGMA table_info(workflows)').all().map((c) => c.name).includes('domain'),
    'seed workflows lacks domain');
  seed.close();

  const db = getDb(); // production open → runs migrate(): ladder is gated off V9, addMissing adds domain before seed
  const cols = db.prepare('PRAGMA table_info(workflows)').all().map((c) => c.name);
  assert.ok(cols.includes('domain'), 'domain column added by self-heal');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11, 'forward-migrated to v11');
  // current < 11 ran seedBuiltinWorkflows against the now-present domain column without error.
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM workflows').get().n > 0, 'built-in workflows seeded');
});

test('user_version=11 DB missing domain (divergent same-version ladder) is healed on fast path', () => {
  mkdirSync(maestroHome(), { recursive: true });
  const seed = new DatabaseSync(dbPath());
  seed.exec(WORKFLOWS_NO_DOMAIN);
  seed.exec('PRAGMA user_version = 11'); // already at SCHEMA_VERSION, but column never added
  seed.close();

  const db = getDb(); // fast path (uv >= SCHEMA_VERSION) must still reconcileColumns()
  const cols = db.prepare('PRAGMA table_info(workflows)').all().map((c) => c.name);
  assert.ok(cols.includes('domain'), 'domain column added on the fast path');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11, 'version unchanged');
});
