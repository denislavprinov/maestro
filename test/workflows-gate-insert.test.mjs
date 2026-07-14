// test/workflows-gate-insert.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkflow } from '../src/core/workflows.mjs';
import { loadAgentRegistry } from '../src/core/agent-registry.mjs';
import { validateWorkflow } from '../src/core/workflow-validator.mjs';

const registry = loadAgentRegistry();

test('no commands: resolved default plan has no gate node (byte-identical topology)', async () => {
  const plan = await resolveWorkflow(process.cwd(), 'wf_default', registry);
  assert.ok(!plan.steps.flat().some((n) => n.key === 'shellGate'));
  assert.ok(!plan.feedbacks.some((fb) => fb.id === 'fb_gate'));
  assert.notEqual(plan.gateSkipped, true);
});

test('with commands: gate node inserted before reviewer, fb_gate targets implementer', async () => {
  const plan = await resolveWorkflow(process.cwd(), 'wf_default', registry, undefined, {
    validateCommands: ['npm test'],
  });
  const flatKeys = plan.steps.map((g) => g.map((n) => n.key));
  const gateStep = flatKeys.findIndex((g) => g.includes('shellGate'));
  const reviewStep = flatKeys.findIndex((g) => g.includes('reviewer'));
  const implStep = flatKeys.findIndex((g) => g.includes('implementer'));
  assert.ok(gateStep > implStep, 'gate after implementer');
  assert.equal(gateStep, reviewStep - 1, 'gate directly before reviewer');

  const gateNode = plan.steps.flat().find((n) => n.key === 'shellGate');
  assert.equal(gateNode.nodeId, 's_gate');
  assert.equal(gateNode.runnerType, 'verifier');
  assert.deepEqual(gateNode.commands, ['npm test']);

  const fbGate = plan.feedbacks.find((fb) => fb.id === 'fb_gate');
  const fbReview = plan.feedbacks.find((fb) => fb.id === 'fb_review');
  assert.equal(fbGate.from, 's_gate');
  assert.equal(fbGate.to, fbReview.to);           // both rewind to the implementer
  assert.equal(fbGate.maxCycles, fbReview.maxCycles);
  assert.equal(fbGate.loopGroup, 'impl');
  assert.equal(fbReview.loopGroup, 'impl');       // shared budget
});

test('inserted topology passes the workflow validator', async () => {
  const plan = await resolveWorkflow(process.cwd(), 'wf_default', registry, undefined, {
    validateCommands: ['npm test'],
  });
  const tpl = {
    steps: plan.steps.map((g) => g.map((n) => ({ id: n.nodeId, key: n.key }))),
    feedbacks: plan.feedbacks,
  };
  const v = validateWorkflow(tpl, registry);
  assert.equal(v.errors?.length || 0, 0, JSON.stringify(v.errors));
});

test('workflow without a review loop: gate skipped with marker', async () => {
  // wf_onboarding's only feedback originates at the evaluator (a verifier), so
  // build a synthetic verifier-less template via the registry-tolerant path:
  // resolveWorkflow on a stored workflow is covered by workflows.test.mjs; here
  // we assert the skip marker using a plan whose feedbacks are empty.
  const { writeWorkflow, deleteWorkflow } = await import('../src/core/workflows.mjs');
  const tpl = await writeWorkflow({
    name: 'gate-skip-fixture',
    steps: [[{ id: 'n1', key: 'planner' }], [{ id: 'n2', key: 'implementer' }]],
    feedbacks: [],
  });
  try {
    const plan = await resolveWorkflow(process.cwd(), tpl.id, registry, undefined, {
      validateCommands: ['npm test'],
    });
    assert.ok(!plan.steps.flat().some((n) => n.key === 'shellGate'));
    assert.equal(plan.gateSkipped, true);
  } finally {
    await deleteWorkflow(tpl.id);
  }
});
