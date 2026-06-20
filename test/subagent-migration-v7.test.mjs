// test/subagent-migration-v7.test.mjs  (structure copied from subagent-migration-v6.test.mjs)
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
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'maestro-v7-')));
  homes.push(dir); _resetForTests(); process.env.MAESTRO_HOME = dir;
});
after(async () => { _resetForTests(); delete process.env.MAESTRO_HOME; await Promise.all(homes.map((d) => rm(d, { recursive: true, force: true }))); });

// Minimal v6 seed: pipelines + sub_agents(+skills), stamped user_version=6.
// (Only sub_agents is touched by the v6->v7 migration, so the minimal seed is
//  sufficient — migrate() runs ONLY `if (current < 7)` from a v6-stamped DB.
//  sub_agents MUST already carry the v6 `skills` column so the v7 ALTER is the
//  only delta, exactly mirroring how subagent-migration-v6's V5_SEED carries ui_phase.)
const V6_SEED = `
CREATE TABLE pipelines (id TEXT PRIMARY KEY, project_key TEXT);
CREATE TABLE sub_agents (pipeline_id TEXT, id TEXT, skills TEXT, PRIMARY KEY (pipeline_id,id));
INSERT INTO pipelines (id, project_key) VALUES ('p1','proj');
`;

test('opening a user_version=6 DB forward-migrates to v7 (adds subagent_type to sub_agents)', () => {
  mkdirSync(maestroHome(), { recursive: true });
  const seed = new DatabaseSync(dbPath());
  seed.exec(V6_SEED); seed.exec('PRAGMA user_version = 6');
  const before = seed.prepare('PRAGMA table_info(sub_agents)').all().map((c) => c.name);
  assert.ok(!before.includes('subagent_type'), 'seed lacks subagent_type');
  seed.close();

  const db = getDb(); // production open → runs migrate()
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7, 'forward-migrated to v7');
  assert.ok(db.prepare('PRAGMA table_info(sub_agents)').all().map((c) => c.name).includes('subagent_type'));
  assert.ok(db.prepare("SELECT 1 FROM pipelines WHERE id='p1'").get(), 'pre-existing data preserved');
});
