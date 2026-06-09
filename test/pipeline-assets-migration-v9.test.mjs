// test/pipeline-assets-migration-v9.test.mjs
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
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'maestro-assets-mig-v9-')));
  homes.push(dir);
  _resetForTests();
  process.env.MAESTRO_HOME = dir;
});
after(async () => {
  _resetForTests();
  delete process.env.MAESTRO_HOME;
  await Promise.all(homes.map((d) => rm(d, { recursive: true, force: true })));
});

const V1_PIPELINES = `
  CREATE TABLE pipelines (
    id TEXT PRIMARY KEY, project_key TEXT NOT NULL, workspace_key TEXT,
    target TEXT NOT NULL DEFAULT 'project', title TEXT, base_name TEXT,
    date_prefix TEXT, status TEXT NOT NULL DEFAULT 'created',
    phase TEXT NOT NULL DEFAULT 'created', cycle INTEGER NOT NULL DEFAULT 0,
    started_at TEXT, updated_at TEXT, total_cost_usd REAL NOT NULL DEFAULT 0,
    total_active_ms INTEGER NOT NULL DEFAULT 0, prompt TEXT, branch TEXT,
    workspace_meta TEXT, stepper TEXT, tools TEXT
  );`;

test('opening a user_version=8 DB forward-migrates to v9 (adds pipeline_assets)', () => {
  mkdirSync(maestroHome(), { recursive: true });
  const seed = new DatabaseSync(dbPath());
  seed.exec(V1_PIPELINES);
  seed.exec('PRAGMA user_version = 8');
  assert.equal(
    seed.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='pipeline_assets'").get().n,
    0, 'seed (v8) has no pipeline_assets table');
  seed.close();

  const db = getDb();
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9, 'forward-migrated to v9');
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='pipeline_assets'").get().n,
    1, 'pipeline_assets table created by the v8->v9 migration');
});
