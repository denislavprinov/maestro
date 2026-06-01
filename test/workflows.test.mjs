// test/workflows.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_WORKFLOW,
  workflowsDir,
  listWorkflows,
  readWorkflow,
  writeWorkflow,
  deleteWorkflow,
  resolveWorkflow,
} from '../src/core/workflows.mjs';

// Each test gets its own ~/.maestro via MAESTRO_HOME so the global store is
// isolated and nothing touches the developer's real home dir.
const homes = [];
async function freshHome() {
  const d = await mkdtemp(join(tmpdir(), 'maestro-home-'));
  homes.push(d);
  process.env.MAESTRO_HOME = d;
  return d;
}
const projects = [];
async function freshProject() {
  const d = await mkdtemp(join(tmpdir(), 'maestro-proj-'));
  projects.push(d);
  return d;
}
after(async () => {
  delete process.env.MAESTRO_HOME;
  await Promise.all([...homes, ...projects].map((d) => rm(d, { recursive: true, force: true })));
});

test('DEFAULT_WORKFLOW is the Plan->Refine->Implement->Review topology', () => {
  assert.equal(DEFAULT_WORKFLOW.id, 'wf_default');
  assert.equal(DEFAULT_WORKFLOW.name, 'Default');
  assert.equal(DEFAULT_WORKFLOW.version, 1);
  // 4 sequential steps, one node each.
  assert.equal(DEFAULT_WORKFLOW.steps.length, 4);
  assert.deepEqual(DEFAULT_WORKFLOW.steps.map((s) => s.length), [1, 1, 1, 1]);
  assert.deepEqual(
    DEFAULT_WORKFLOW.steps.map((s) => s[0].key),
    ['planner', 'refiner', 'implementer', 'reviewer'],
  );
  // Node ids are unique instance ids.
  const ids = DEFAULT_WORKFLOW.steps.flat().map((n) => n.id);
  assert.deepEqual(ids, ['s0_0', 's1_0', 's2_0', 's3_0']);
});

test('DEFAULT_WORKFLOW feedbacks reproduce the refine self-loop and review->implement loop', () => {
  // Two loops: refiner self-loop (s1_0 -> s1_0) and review -> implement (s3_0 -> s2_0).
  const fbs = DEFAULT_WORKFLOW.feedbacks;
  assert.equal(fbs.length, 2);
  const refine = fbs.find((f) => f.from === 's1_0');
  const review = fbs.find((f) => f.from === 's3_0');
  assert.ok(refine, 'refine loop present');
  assert.equal(refine.to, 's1_0'); // self-loop, mirrors _refineLoop re-running refine
  assert.ok(review, 'review loop present');
  assert.equal(review.to, 's2_0'); // review -> implement (fix pass), mirrors _reviewLoop
  // Feedback ids are unique.
  assert.equal(new Set(fbs.map((f) => f.id)).size, fbs.length);
});

test('workflowsDir is <MAESTRO_HOME>/.maestro/workflows', async () => {
  const home = await freshHome();
  assert.equal(workflowsDir(), join(home, '.maestro', 'workflows'));
});

test('writeWorkflow stamps id/createdAt/updatedAt and roundtrips through readWorkflow', async () => {
  await freshHome();
  const saved = await writeWorkflow({
    name: 'Quick Fix',
    steps: [[{ id: 's0_0', key: 'planner' }], [{ id: 's1_0', key: 'implementer' }]],
    feedbacks: [],
  });
  assert.match(saved.id, /^wf_/);
  assert.equal(saved.name, 'Quick Fix');
  assert.equal(saved.version, 1);
  assert.ok(saved.createdAt && saved.updatedAt, 'timestamps stamped');

  // Persisted on disk as <id>.json.
  const onDisk = JSON.parse(await readFile(join(workflowsDir(), `${saved.id}.json`), 'utf8'));
  assert.equal(onDisk.name, 'Quick Fix');

  const got = await readWorkflow(saved.id);
  assert.deepEqual(got.steps, saved.steps);
  assert.deepEqual(got.feedbacks, saved.feedbacks);
});

test('writeWorkflow derives a wf_<slug> id from the name when id is missing', async () => {
  await freshHome();
  const saved = await writeWorkflow({ name: 'My Cool Flow', steps: [[{ id: 's0_0', key: 'planner' }]], feedbacks: [] });
  assert.match(saved.id, /^wf_my-cool-flow/);
});

test('writeWorkflow preserves createdAt but bumps updatedAt on re-save', async () => {
  await freshHome();
  const first = await writeWorkflow({ id: 'wf_x', name: 'X', steps: [[{ id: 's0_0', key: 'planner' }]], feedbacks: [] });
  const second = await writeWorkflow({ ...first, name: 'X2', updatedAt: undefined });
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.name, 'X2');
});

test('listWorkflows returns user templates sorted newest-first; excludes wf_default', async () => {
  await freshHome();
  const a = await writeWorkflow({ id: 'wf_a', name: 'A', steps: [[{ id: 's0_0', key: 'planner' }]], feedbacks: [], createdAt: '2026-01-01T00:00:00.000Z' });
  const b = await writeWorkflow({ id: 'wf_b', name: 'B', steps: [[{ id: 's0_0', key: 'planner' }]], feedbacks: [], createdAt: '2026-02-01T00:00:00.000Z' });
  const list = await listWorkflows();
  assert.deepEqual(list.map((w) => w.id), ['wf_b', 'wf_a']); // newest createdAt first
  assert.ok(!list.some((w) => w.id === 'wf_default'), 'DEFAULT_WORKFLOW is not in the user store');
});

test('readWorkflow returns DEFAULT_WORKFLOW for "wf_default"', async () => {
  await freshHome();
  const got = await readWorkflow('wf_default');
  assert.equal(got.id, 'wf_default');
  assert.equal(got.steps.length, 4);
});

test('readWorkflow returns null for a missing id; listWorkflows is [] on an empty store', async () => {
  await freshHome();
  assert.equal(await readWorkflow('wf_nope'), null);
  assert.deepEqual(await listWorkflows(), []);
});
