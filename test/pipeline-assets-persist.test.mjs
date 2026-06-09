// test/pipeline-assets-persist.test.mjs
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertAssetInvocation, listAssetInvocations } from '../src/core/artifacts.mjs';
import { getDb, _resetForTests } from '../src/core/db.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';

const homes = [];
beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-assets-persist-'));
  homes.push(dir); _resetForTests(); process.env.MAESTRO_HOME = dir;
});
after(async () => {
  _resetForTests(); delete process.env.MAESTRO_HOME;
  await Promise.all(homes.map((d) => rm(d, { recursive: true, force: true })));
});

test('upsert inserts; list returns the camelCase shape', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'maestro-assets-proj-'));
  const { id: pid } = await seedPipeline(proj, { title: 'Run', status: 'running' });
  upsertAssetInvocation(pid, {
    id: 'toolu_s1', kind: 'skill', name: 'browse', detail: 'open url',
    nodeId: 's2_0', uiPhase: 'implement', stepIndex: 2, cycle: 0,
    stepKey: '2:s2_0', invokedAt: '2026-06-09T00:00:01Z',
  });
  assert.deepEqual(listAssetInvocations(pid), [{
    id: 'toolu_s1', kind: 'skill', name: 'browse', detail: 'open url',
    nodeId: 's2_0', uiPhase: 'implement', stepIndex: 2, cycle: 0,
    stepKey: '2:s2_0', invokedAt: '2026-06-09T00:00:01Z',
  }]);
});

test('re-upsert is idempotent and COALESCE does not clobber set fields', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'maestro-assets-proj-'));
  const { id: pid } = await seedPipeline(proj, { title: 'Run', status: 'running' });
  upsertAssetInvocation(pid, {
    id: 'toolu_s1', kind: 'skill', name: 'browse', detail: 'open url',
    nodeId: 's2_0', uiPhase: 'implement', stepIndex: 2, cycle: 0,
    stepKey: '2:s2_0', invokedAt: '2026-06-09T00:00:01Z',
  });
  // partial re-upsert on the same id: no detail/attr — must NOT wipe the prior values
  upsertAssetInvocation(pid, { id: 'toolu_s1', kind: 'skill', name: 'browse' });
  const rows = listAssetInvocations(pid);
  assert.equal(rows.length, 1, 'still one row (idempotent on (pipeline_id,id))');
  assert.equal(rows[0].detail, 'open url', 'detail preserved by COALESCE');
  assert.equal(rows[0].nodeId, 's2_0', 'nodeId preserved by COALESCE');
  assert.equal(rows[0].invokedAt, '2026-06-09T00:00:01Z', 'invokedAt preserved');
});

test('list orders by (invoked_at, id); empty -> []', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'maestro-assets-proj-'));
  const { id: pid } = await seedPipeline(proj, { title: 'Run', status: 'running' });
  assert.deepEqual(listAssetInvocations(pid), []);
  upsertAssetInvocation(pid, { id: 'b', kind: 'agent', name: 'Explore', invokedAt: '2026-06-09T00:00:05Z' });
  upsertAssetInvocation(pid, { id: 'a', kind: 'agent', name: 'Explore', invokedAt: '2026-06-09T00:00:05Z' });
  upsertAssetInvocation(pid, { id: 'm', kind: 'graphify', name: 'graphify', invokedAt: '2026-06-09T00:00:01Z' });
  assert.deepEqual(listAssetInvocations(pid).map((r) => r.id), ['m', 'a', 'b']);
});

test('FK cascades on pipeline delete', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'maestro-assets-proj-'));
  const { id: pid } = await seedPipeline(proj, { title: 'Run', status: 'running' });
  upsertAssetInvocation(pid, { id: 'x', kind: 'skill', name: 'qa', invokedAt: '2026-06-09T00:00:01Z' });
  assert.equal(listAssetInvocations(pid).length, 1);
  getDb().prepare('DELETE FROM pipelines WHERE id = ?').run(pid);
  assert.equal(listAssetInvocations(pid).length, 0);
});
