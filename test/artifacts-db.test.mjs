// test/artifacts-db.test.mjs
// Phase 3 — artifacts.mjs on node:sqlite (store_meta, ensureMeta, writeState,
// appendAudit). Each test runs against a throwaway MAESTRO_HOME with the DB
// singleton reset so getDb() reopens against it (mirrors 01-db-foundation.md).
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetForTests, getDb } from '../src/core/db.mjs';
import { readStoreMeta, writeStoreMeta, deleteStoreMeta } from '../src/core/artifacts.mjs';
import { ensureArtifactDirs, writeState } from '../src/core/artifacts.mjs';
import { projectKey } from '../src/core/store.mjs';

const homes = [];
beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-art-'));
  homes.push(dir);
  _resetForTests();
  process.env.MAESTRO_HOME = dir;
});
after(async () => {
  _resetForTests();
  delete process.env.MAESTRO_HOME;
  await Promise.all(homes.map((d) => rm(d, { recursive: true, force: true })));
});

// ── Task 3.1 — store_meta read/write/delete ────────────────────────────────────

test('store_meta: write then read round-trips the JSON payload', () => {
  const data = { key: 'k1', path: '/p/k1', name: 'K One', firstSeenAt: '2026-01-01T00:00:00Z' };
  writeStoreMeta('k1', 'project', data);
  assert.deepEqual(readStoreMeta('k1'), data);
});

test('store_meta: read of an unknown key returns null', () => {
  assert.equal(readStoreMeta('nope'), null);
});

test('store_meta: write is an upsert (second write replaces)', () => {
  writeStoreMeta('k1', 'project', { name: 'old' });
  writeStoreMeta('k1', 'project', { name: 'new' });
  assert.deepEqual(readStoreMeta('k1'), { name: 'new' });
});

test('store_meta: delete removes the row', () => {
  writeStoreMeta('k1', 'workspace', { name: 'x' });
  deleteStoreMeta('k1');
  assert.equal(readStoreMeta('k1'), null);
});

// ── Task 3.2 — ensureMeta/ensureWorkspaceMeta back onto store_meta ──────────────

test('ensureArtifactDirs persists project meta to store_meta and preserves firstSeenAt', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'maestro-proj-'));
  homes.push(proj);
  const p1 = await ensureArtifactDirs(proj);
  assert.equal(p1.meta.key, projectKey(proj));
  assert.ok(p1.meta.firstSeenAt);
  // Row exists in the DB, not as a meta.json file.
  assert.deepEqual(readStoreMeta(projectKey(proj)), p1.meta);
  const p2 = await ensureArtifactDirs(proj); // re-run
  assert.equal(p2.meta.firstSeenAt, p1.meta.firstSeenAt, 'firstSeenAt preserved');
});

// ── Task 3.3 — writeState UPSERT pipelines + REPLACE pipeline_steps ─────────────

function fullState(over = {}) {
  return {
    id: 'aaaa1111', title: 'Demo', projectDir: '/p', projectKey: 'proj-00000001',
    projectName: 'P', status: 'running', phase: 'plan', cycle: 1,
    startedAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
    totalCostUsd: 0.17, totalActiveMs: 4200, prompt: 'do the thing',
    branch: { source: 'main', feature: 'maestro/demo-aaaa1111', worktreeDir: '/wt', reusedExisting: false },
    stepper: { nodes: [{ id: 's0_0' }] }, tools: { tool: 'graphify', kind: 'cli' },
    steps: [
      { key: 'plan', phase: 'plan', nodeId: 's0_0', stepIndex: 0, cycle: 1, status: 'done',
        startedAt: '2026-06-01T00:00:01Z', updatedAt: '2026-06-01T00:00:02Z', activeMs: 1200, runningSince: null, costUsd: 0.10 },
      { key: 'implement#1', phase: 'implement', cycle: 1, status: 'running',
        startedAt: '2026-06-01T00:00:03Z', updatedAt: '2026-06-01T00:00:03Z', activeMs: 0, runningSince: 1700000000000, costUsd: 0.07 },
    ],
    ...over,
  };
}

test('writeState upserts a pipelines row with scalar + JSON columns', async () => {
  const out = await writeState('/some/dir-aaaa1111', fullState());
  assert.ok(out.updatedAt, 'returns the stamped object');
  const row = getDb().prepare('SELECT * FROM pipelines WHERE id = ?').get('aaaa1111');
  assert.equal(row.title, 'Demo');
  assert.equal(row.project_key, 'proj-00000001');
  assert.equal(row.status, 'running');
  assert.equal(row.total_cost_usd, 0.17);
  assert.equal(row.total_active_ms, 4200);
  assert.equal(row.prompt, 'do the thing');
  assert.equal(JSON.parse(row.branch).feature, 'maestro/demo-aaaa1111');
  assert.equal(JSON.parse(row.tools).tool, 'graphify');
});

test('writeState replaces pipeline_steps from state.steps[]', async () => {
  await writeState('/d-aaaa1111', fullState());
  let steps = getDb().prepare('SELECT * FROM pipeline_steps WHERE pipeline_id = ? ORDER BY key').all('aaaa1111');
  assert.equal(steps.length, 2);
  const plan = steps.find((s) => s.key === 'plan');
  assert.equal(plan.node_id, 's0_0');
  assert.equal(plan.active_ms, 1200);
  assert.equal(plan.cost_usd, 0.10);
  assert.equal(plan.running_since, null);
  const impl = steps.find((s) => s.key === 'implement#1');
  assert.equal(impl.running_since, '1700000000000', 'epoch-ms stored as text is round-trippable');

  // A second writeState with FEWER steps must REPLACE (not merge).
  await writeState('/d-aaaa1111', fullState({ steps: [fullState().steps[0]] }));
  steps = getDb().prepare('SELECT key FROM pipeline_steps WHERE pipeline_id = ?').all('aaaa1111');
  assert.deepEqual(steps.map((s) => s.key), ['plan'], 'old implement#1 row removed on replace');
});

test('writeState persists the workspace superset into workspace_meta', async () => {
  await writeState('/d-bbbb2222', fullState({
    id: 'bbbb2222', target: 'workspace', workspaceKey: 'wks-demo-12345678',
    workspaceId: 'wks-demo-12345678', workspaceName: 'Demo WS', workspaceDescription: 'desc',
    projectKeys: ['p1', 'p2'], projects: [{ projectKey: 'p1', projectDir: '/a', projectName: 'a' }],
    checkpointRefs: { p1: 'abc' }, branches: { p1: { feature: 'f' } },
  }));
  const row = getDb().prepare('SELECT target, workspace_key, workspace_meta FROM pipelines WHERE id = ?').get('bbbb2222');
  assert.equal(row.target, 'workspace');
  assert.equal(row.workspace_key, 'wks-demo-12345678');
  const wm = JSON.parse(row.workspace_meta);
  assert.deepEqual(wm.projectKeys, ['p1', 'p2']);
  assert.equal(wm.workspaceName, 'Demo WS');
  assert.deepEqual(wm.branches, { p1: { feature: 'f' } });
});

// A11(a) — the curated ON CONFLICT DO UPDATE SET list MUST NOT clobber the
// creation-immutable identity columns that the orchestrator's this.state omits.
// Simulate: createPipeline's INSERT (full identity) then a _persist()-style
// re-write whose object is missing prompt/project_key (as this.state is). The
// immutable columns must survive; only the mutable columns update.
test('writeState UPSERT preserves creation-immutable columns absent from a later state (A11a)', async () => {
  // 1) Initial persist with the full identity (what createPipeline writes).
  await writeState('/d-cccc3333', fullState({
    id: 'cccc3333', prompt: 'ORIGINAL PROMPT', title: 'Orig Title',
    baseName: 'orig-base', datePrefix: '01-06-26', startedAt: '2026-06-01T00:00:00Z',
    status: 'created', phase: 'created',
  }));
  // 2) A later persist whose object OMITS prompt/baseName/datePrefix/title (mirrors
  //    orchestrator this.state, which never carries them) but mutates status/cost.
  const later = fullState({ id: 'cccc3333', status: 'done', phase: 'done', totalCostUsd: 0.99 });
  delete later.prompt; delete later.baseName; delete later.datePrefix;
  later.title = undefined; // present-but-undefined, as a partial state object can be
  await writeState('/d-cccc3333', later);
  const row = getDb().prepare('SELECT * FROM pipelines WHERE id = ?').get('cccc3333');
  // Mutable columns updated:
  assert.equal(row.status, 'done', 'status mutates');
  assert.equal(row.total_cost_usd, 0.99, 'cost mutates');
  // Creation-immutable columns survived (NOT nulled by the second write):
  assert.equal(row.prompt, 'ORIGINAL PROMPT', 'prompt preserved (A11a)');
  assert.equal(row.base_name, 'orig-base', 'base_name preserved (A11a)');
  assert.equal(row.date_prefix, '01-06-26', 'date_prefix preserved (A11a)');
  assert.equal(row.title, 'Orig Title', 'title preserved (A11a)');
  assert.equal(row.started_at, '2026-06-01T00:00:00Z', 'started_at preserved (A11a)');
});

// C1 — toPipelineRow derives project_key from projectDir when the object omits
// projectKey (the orchestrator's this.state carries projectDir, not projectKey).
// The INSERT arm must satisfy project_key NOT NULL via the derivation.
test('writeState derives project_key from projectDir when projectKey is absent (C1)', async () => {
  const st = fullState({ id: 'dddd4444' });
  delete st.projectKey; // mirror orchestrator this.state (projectDir only)
  st.projectDir = '/p';
  await writeState('/d-dddd4444', st);
  const row = getDb().prepare('SELECT project_key FROM pipelines WHERE id = ?').get('dddd4444');
  assert.equal(row.project_key, projectKey('/p'), 'project_key derived from projectDir');
});

test('writeState with an id-less state is a no-op (returns the stamped object, inserts nothing)', async () => {
  const before = getDb().prepare('SELECT COUNT(*) c FROM pipelines').get().c;
  const out = await writeState('/d-noid', fullState({ id: null }));
  assert.ok(out.updatedAt, 'still returns the stamped object');
  const after = getDb().prepare('SELECT COUNT(*) c FROM pipelines').get().c;
  assert.equal(after, before, 'no row inserted for an id-less state');
});
