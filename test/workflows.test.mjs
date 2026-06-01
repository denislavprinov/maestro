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
import { setNodeModel, setFeedbackCycles } from '../src/core/config.mjs';

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

test('deleteWorkflow removes a saved template and returns true', async () => {
  await freshHome();
  const saved = await writeWorkflow({ id: 'wf_del', name: 'Del', steps: [[{ id: 's0_0', key: 'planner' }]], feedbacks: [] });
  assert.equal(await deleteWorkflow(saved.id), true);
  assert.equal(await readWorkflow(saved.id), null);
  const files = await readdir(workflowsDir());
  assert.ok(!files.includes('wf_del.json'));
});

test('deleteWorkflow returns false for a missing id', async () => {
  await freshHome();
  assert.equal(await deleteWorkflow('wf_ghost'), false);
});

test('deleteWorkflow refuses to delete the built-in default (returns false, leaves it readable)', async () => {
  await freshHome();
  assert.equal(await deleteWorkflow('wf_default'), false);
  const still = await readWorkflow('wf_default');
  assert.equal(still.id, 'wf_default'); // DEFAULT_WORKFLOW is always present
});

// Inline fake registry mirroring Phase 1's AgentMeta shape. agentFile values are
// the REAL agent prompt files on disk so prompt + tools load is exercised.
const REGISTRY = {
  planner: { key: 'planner', runnerType: 'producer', agentFile: 'maestro-planner.md', loopSource: false },
  refiner: { key: 'refiner', runnerType: 'producer', agentFile: 'maestro-plan-refiner.md', loopSource: false },
  implementer: { key: 'implementer', runnerType: 'producer', agentFile: 'maestro-implementer.md', loopSource: false },
  reviewer: { key: 'reviewer', runnerType: 'verifier', agentFile: 'maestro-code-reviewer.md', loopSource: true },
};

test('resolveWorkflow(default) yields a 4-step ExecutablePlan with prompts and default cycles', async () => {
  await freshHome();
  const p = await freshProject();
  const plan = await resolveWorkflow(p, 'wf_default', REGISTRY);
  assert.equal(plan.id, 'wf_default');
  assert.equal(plan.steps.length, 4);
  const flat = plan.steps.flat();
  assert.deepEqual(flat.map((n) => n.key), ['planner', 'refiner', 'implementer', 'reviewer']);
  // Each node carries the resolved runner + a non-empty agentPrompt from its file.
  for (const n of flat) {
    assert.ok(['producer', 'verifier'].includes(n.runnerType), `runnerType for ${n.key}`);
    assert.ok(typeof n.agentPrompt === 'string' && n.agentPrompt.length > 0, `prompt for ${n.key}`);
    assert.ok('model' in n && 'effort' in n, 'model/effort fields present');
    assert.ok(Array.isArray(n.tools), 'tools array present');
  }
  // loopSource flows through from the registry.
  assert.equal(flat.find((n) => n.key === 'reviewer').loopSource, true);
  assert.equal(flat.find((n) => n.key === 'planner').loopSource, false);
  // Feedbacks carry the gate + a default maxCycles of 5 (orchestrator parity).
  assert.equal(plan.feedbacks.length, 2);
  for (const f of plan.feedbacks) {
    assert.equal(f.gate, 'hasBlocking');
    assert.equal(f.maxCycles, 5);
  }
});

test('resolveWorkflow overlays per-project model/effort and feedback cycles', async () => {
  await freshHome();
  const p = await freshProject();
  await setNodeModel(p, 'wf_default', 's2_0', { model: 'claude-opus-4-8', effort: 'high' });
  await setFeedbackCycles(p, 'wf_default', 'fb_review', 2);
  const plan = await resolveWorkflow(p, 'wf_default', REGISTRY);
  const impl = plan.steps.flat().find((n) => n.nodeId === 's2_0');
  assert.equal(impl.model, 'claude-opus-4-8');
  assert.equal(impl.effort, 'high');
  const reviewFb = plan.feedbacks.find((f) => f.id === 'fb_review');
  assert.equal(reviewFb.maxCycles, 2);
});

test('resolveWorkflow resolves a saved template (incl. a parallel step)', async () => {
  await freshHome();
  const p = await freshProject();
  await writeWorkflow({
    id: 'wf_par',
    name: 'Parallel',
    steps: [
      [{ id: 'n_plan', key: 'planner' }],
      [{ id: 'n_impl', key: 'implementer' }, { id: 'n_refine', key: 'refiner' }], // parallel group
      [{ id: 'n_rev', key: 'reviewer' }],
    ],
    feedbacks: [{ id: 'fb_r', from: 'n_rev', to: 'n_impl' }],
  });
  const plan = await resolveWorkflow(p, 'wf_par', REGISTRY);
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.steps[1].length, 2); // the parallel group survives
  assert.deepEqual(plan.steps[1].map((n) => n.nodeId).sort(), ['n_impl', 'n_refine']);
  assert.equal(plan.feedbacks[0].from, 'n_rev');
  assert.equal(plan.feedbacks[0].to, 'n_impl');
});

test('resolveWorkflow throws for an unknown workflow id', async () => {
  await freshHome();
  const p = await freshProject();
  await assert.rejects(() => resolveWorkflow(p, 'wf_missing', REGISTRY), /wf_missing|not found|unknown/i);
});
