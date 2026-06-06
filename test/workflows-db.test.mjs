// test/workflows-db.test.mjs
// workflows.mjs stores user templates in SQLite (table: workflows); DEFAULT_WORKFLOW
// stays built-in. Signatures unchanged (all async, same shapes). Per-test throwaway
// MAESTRO_HOME + DB reset.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_WORKFLOW, listWorkflows, readWorkflow, writeWorkflow, deleteWorkflow,
} from '../src/core/workflows.mjs';
import { getDb, _resetForTests } from '../src/core/db.mjs';

const homes = [];
async function freshHome() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-wfdb-'));
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

test('readWorkflow returns the built-in DEFAULT_WORKFLOW for "wf_default" (not a row)', async () => {
  const got = await readWorkflow('wf_default');
  assert.equal(got.id, 'wf_default');
  assert.equal(got.steps.length, 4);
  // It is NOT stored in the table.
  const row = getDb().prepare('SELECT 1 FROM workflows WHERE id = ?').get('wf_default');
  assert.equal(row, undefined, 'default workflow is never a DB row');
});

test('readWorkflow returns null for a missing id; listWorkflows is [] on an empty store', async () => {
  assert.equal(await readWorkflow('wf_nope'), null);
  assert.deepEqual(await listWorkflows(), []);
});

test('listWorkflows reads rows newest-first by created_at and parses steps/feedbacks JSON', async () => {
  const db = getDb();
  const ins = db.prepare(
    'INSERT INTO workflows (id, name, version, steps, feedbacks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  ins.run('wf_a', 'A', 1, JSON.stringify([[{ id: 's0_0', key: 'planner' }]]), '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  ins.run('wf_b', 'B', 1, JSON.stringify([[{ id: 's0_0', key: 'planner' }]]), '[]', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
  const list = await listWorkflows();
  assert.deepEqual(list.map((w) => w.id), ['wf_b', 'wf_a'], 'newest created_at first');
  assert.ok(Array.isArray(list[0].steps), 'steps parsed from JSON');
  assert.ok(!list.some((w) => w.id === 'wf_default'), 'DEFAULT_WORKFLOW never in the user store');
});

test('readWorkflow parses a stored row into the template shape', async () => {
  getDb().prepare(
    'INSERT INTO workflows (id, name, version, steps, feedbacks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('wf_x', 'X', 1,
    JSON.stringify([[{ id: 's0_0', key: 'planner' }], [{ id: 's1_0', key: 'implementer' }]]),
    JSON.stringify([{ id: 'fb_0', from: 's1_0', to: 's0_0' }]),
    '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z');
  const got = await readWorkflow('wf_x');
  assert.equal(got.name, 'X');
  assert.equal(got.steps.length, 2);
  assert.deepEqual(got.feedbacks, [{ id: 'fb_0', from: 's1_0', to: 's0_0' }]);
});

test('readWorkflow rejects path-traversal / unsafe ids (returns null)', async () => {
  for (const bad of ['../foo', 'a/b', 'foo.bar', 'foo bar', '', '.', '..']) {
    assert.equal(await readWorkflow(bad), null, `must reject "${bad}"`);
  }
});
