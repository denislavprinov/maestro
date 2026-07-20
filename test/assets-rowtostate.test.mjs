// test/assets-rowtostate.test.mjs
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPipelineByKey, upsertAssetInvocation } from '../src/core/artifacts.mjs';
import { _resetForTests } from '../src/core/db.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';

const homes = [];
beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-assets-r2s-home-'));
  homes.push(dir); _resetForTests(); process.env.MAESTRO_HOME = dir;
});
after(async () => {
  _resetForTests(); delete process.env.MAESTRO_HOME;
  await Promise.all(homes.map((d) => rm(d, { recursive: true, force: true })));
});

test('rowToState carries assets from the DB', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'maestro-assets-r2s-'));
  const { id: pid, key } = await seedPipeline(proj, { title: 'Run', status: 'done' });
  upsertAssetInvocation(pid, { id: 't1', kind: 'skill', name: 'browse', invokedAt: '2026-06-09T00:00:01Z' });
  const detail = await readPipelineByKey(key, pid);   // <-- MUST await
  assert.equal(detail.state.assets.length, 1);
  assert.equal(detail.state.assets[0].name, 'browse');
});
