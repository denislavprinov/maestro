// test/workflow-validator.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateWorkflow } from '../src/core/workflow-validator.mjs';
import { DEFAULT_WORKFLOW } from '../src/core/workflows.mjs';

// Inline fake registry (matches Phase 1's AgentMeta shape) so this phase tests
// independently of agent-registry.mjs. Only `key` is consulted by the validator.
const REGISTRY = {
  planner: { key: 'planner', runnerType: 'producer', agentFile: 'maestro-planner.md', loopSource: false },
  refiner: { key: 'refiner', runnerType: 'producer', agentFile: 'maestro-plan-refiner.md', loopSource: false },
  implementer: { key: 'implementer', runnerType: 'producer', agentFile: 'maestro-implementer.md', loopSource: false },
  reviewer: { key: 'reviewer', runnerType: 'verifier', agentFile: 'maestro-code-reviewer.md', loopSource: true },
};

// A minimal valid template builder so each test perturbs exactly one rule.
function valid() {
  return {
    id: 'wf_t',
    name: 'T',
    steps: [
      [{ id: 's0_0', key: 'planner' }],
      [{ id: 's1_0', key: 'implementer' }],
      [{ id: 's2_0', key: 'reviewer' }],
    ],
    feedbacks: [{ id: 'fb_0', from: 's2_0', to: 's1_0' }],
  };
}

test('a well-formed workflow passes', () => {
  const { ok, errors } = validateWorkflow(valid(), REGISTRY);
  assert.equal(ok, true, errors.join('; '));
  assert.deepEqual(errors, []);
});

test('DEFAULT_WORKFLOW passes against a registry of its 4 keys', () => {
  const { ok, errors } = validateWorkflow(DEFAULT_WORKFLOW, REGISTRY);
  assert.equal(ok, true, errors.join('; '));
});

test('rejects a workflow with no steps', () => {
  const t = valid();
  t.steps = [];
  const { ok, errors } = validateWorkflow(t, REGISTRY);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /at least one step|no steps|empty/i.test(e)), errors.join('; '));
});

test('rejects an empty step (a step with zero nodes)', () => {
  const t = valid();
  t.steps = [[{ id: 's0_0', key: 'planner' }], [], [{ id: 's2_0', key: 'reviewer' }]];
  const { ok, errors } = validateWorkflow(t, REGISTRY);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /empty step|step 1|no nodes/i.test(e)), errors.join('; '));
});

test('rejects an unknown node key (not in registry)', () => {
  const t = valid();
  t.steps[0][0].key = 'wizard';
  const { ok, errors } = validateWorkflow(t, REGISTRY);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /wizard/.test(e) && /registry|unknown/i.test(e)), errors.join('; '));
});

test('rejects duplicate node ids', () => {
  const t = valid();
  t.steps[1][0].id = 's0_0'; // collide with the planner node id
  const { ok, errors } = validateWorkflow(t, REGISTRY);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /duplicate/i.test(e) && /s0_0/.test(e)), errors.join('; '));
});

test('rejects a node with a missing/blank id', () => {
  const t = valid();
  delete t.steps[1][0].id;
  const { ok, errors } = validateWorkflow(t, REGISTRY);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /id/i.test(e)), errors.join('; '));
});

test('rejects a dangling feedback (from references a non-existent node)', () => {
  const t = valid();
  t.feedbacks = [{ id: 'fb_0', from: 'sX_0', to: 's1_0' }];
  const { ok, errors } = validateWorkflow(t, REGISTRY);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /sX_0/.test(e) && /from|exist|unknown/i.test(e)), errors.join('; '));
});

test('rejects a dangling feedback (to references a non-existent node)', () => {
  const t = valid();
  t.feedbacks = [{ id: 'fb_0', from: 's2_0', to: 'sY_0' }];
  const { ok, errors } = validateWorkflow(t, REGISTRY);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /sY_0/.test(e) && /to|exist|unknown/i.test(e)), errors.join('; '));
});

test('rejects a forward-pointing feedback (target step index >= source step index)', () => {
  const t = valid();
  // from s1_0 (step 1) to s2_0 (step 2) points forward -> illegal.
  t.feedbacks = [{ id: 'fb_0', from: 's1_0', to: 's2_0' }];
  const { ok, errors } = validateWorkflow(t, REGISTRY);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /precede|forward|before|step/i.test(e)), errors.join('; '));
});

test('accepts a self-loop feedback (to step index == from step index is NOT allowed)', () => {
  // The refine loop in DEFAULT is a self-loop (from===to, same node). The rule is
  // "target step index < source step index"; a same-node self-loop has equal
  // indices and must be allowed as a special case (same node id), but a DIFFERENT
  // node in the SAME step pointing back is still forward-equal and rejected.
  const t = valid();
  t.feedbacks = [{ id: 'fb_0', from: 's1_0', to: 's1_0' }];
  const { ok, errors } = validateWorkflow(t, REGISTRY);
  assert.equal(ok, true, errors.join('; '));
});

test('rejects duplicate feedback ids', () => {
  const t = valid();
  t.feedbacks = [
    { id: 'fb_0', from: 's2_0', to: 's1_0' },
    { id: 'fb_0', from: 's2_0', to: 's0_0' },
  ];
  const { ok, errors } = validateWorkflow(t, REGISTRY);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /duplicate/i.test(e) && /fb_0/.test(e)), errors.join('; '));
});

test('rejects a null/non-object template', () => {
  assert.equal(validateWorkflow(null, REGISTRY).ok, false);
  assert.equal(validateWorkflow({}, REGISTRY).ok, false);
});
