import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflow } from '../src/core/workflow-validator.mjs';
import { loadAgentRegistry } from '../src/core/agent-registry.mjs';
import { ONBOARDING_WORKFLOW } from '../src/core/builtin-workflows.mjs';

test('ONBOARDING_WORKFLOW validates against the registry (no errors)', () => {
  const reg = loadAgentRegistry(undefined, { userAgentsDir: null });
  const { ok, errors } = validateWorkflow(ONBOARDING_WORKFLOW, reg);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test('the single feedback edge is a legal back-edge eval(step4) → infra(step2)', () => {
  const idx = (id) => ONBOARDING_WORKFLOW.steps.findIndex((g) => g.some((n) => n.id === id));
  const fb = ONBOARDING_WORKFLOW.feedbacks[0];
  assert.equal(fb.from, 's_eval'); assert.equal(fb.to, 's_infra');
  assert.ok(idx(fb.to) < idx(fb.from), 'target step must precede source step');
});
