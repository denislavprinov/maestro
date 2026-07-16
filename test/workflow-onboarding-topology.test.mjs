import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflow } from '../src/core/workflow-validator.mjs';
import { loadAgentRegistry } from '../src/core/agent-registry.mjs';
import { ONBOARDING_WORKFLOW } from '../src/core/builtin-workflows.mjs';
import { ENABLE_WORKFLOW, ENABLE_QUESTION_IDS } from '../src/core/onboarding.mjs';

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

test('ENABLE_WORKFLOW validates against the registry (no errors)', () => {
  const reg = loadAgentRegistry(undefined, { userAgentsDir: null });
  const { ok, errors } = validateWorkflow(ENABLE_WORKFLOW, reg);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test('ENABLE_WORKFLOW: s_execute sits between s_eval and s_canary with a legal fb_exec back-edge', () => {
  const idx = (id) => ENABLE_WORKFLOW.steps.findIndex((g) => g.some((n) => n.id === id));
  assert.ok(idx('s_eval') < idx('s_execute'), 'execute after eval');
  assert.ok(idx('s_execute') < idx('s_canary'), 'execute before canary');
  const fb = ENABLE_WORKFLOW.feedbacks.find((f) => f.id === 'fb_exec');
  assert.equal(fb.from, 's_execute');
  assert.equal(fb.to, 's_eval');
  assert.ok(idx(fb.to) < idx(fb.from), 'target step must precede source step');
});

test('ENABLE_QUESTION_IDS carries the two new clarify ids', () => {
  assert.ok(ENABLE_QUESTION_IDS.includes('optionalTools'));
  assert.ok(ENABLE_QUESTION_IDS.includes('executeTasks'));
});

test('onboardingExecutor registry meta: verifier, loopSource, tasks channelDef', () => {
  const reg = loadAgentRegistry(undefined, { userAgentsDir: null });
  const m = reg.onboardingExecutor;
  assert.ok(m, 'onboardingExecutor is registered');
  assert.equal(m.runnerType, 'verifier');
  assert.equal(m.loopSource, true);
  assert.ok(m.produces.includes('tasks'));
  assert.ok(m.consumes.includes('readiness'));
});

test('projectOnboarding registry meta: produces the tools channel with a json channelDef', () => {
  const reg = loadAgentRegistry(undefined, { userAgentsDir: null });
  const m = reg.projectOnboarding;
  assert.ok(m.produces.includes('tools'));
  const def = (m.channelDefs || []).find((d) => d.id === 'tools');
  assert.ok(def, 'tools channelDef declared');
  assert.equal(def.kind, 'json');
});
