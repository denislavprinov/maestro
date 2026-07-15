import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAgentRegistry } from '../src/core/agent-registry.mjs';

test('onboarding agents are registered with correct channel wiring', () => {
  const reg = loadAgentRegistry(undefined, { userAgentsDir: null }); // built-in layer only
  assert.equal(Object.keys(reg).length, 19);                          // was 12, +5 onboarding, +1 enableClarifier, +1 shellGate

  assert.deepEqual(reg.onboardingClarifier.produces, ['clarify']);
  assert.equal(reg.onboardingClarifier.runnerType, 'clarifier');

  assert.deepEqual(reg.onboardingAnalyzer.produces, ['graph']);
  assert.equal(reg.onboardingAnalyzer.consumes.includes('graph'), false);
  assert.deepEqual(reg.onboardingAnalyzer.connectsTo, ['projectOnboarding']);

  assert.deepEqual(reg.projectOnboarding.consumes, ['graph', 'clarify']); // retargeted
  assert.deepEqual(reg.projectOnboarding.connectsTo, ['onboardingTests']);

  assert.deepEqual(reg.onboardingTests.produces, ['code']);
  assert.deepEqual(reg.onboardingTests.connectsTo, ['onboardingEvaluator']);

  assert.equal(reg.onboardingEvaluator.runnerType, 'verifier');
  assert.equal(reg.onboardingEvaluator.loopSource, true);
  assert.deepEqual(reg.onboardingEvaluator.produces, ['review', 'readiness']);

  assert.deepEqual(reg.onboardingCanary.produces, ['review']);
  assert.deepEqual(reg.onboardingCanary.connectsTo, []);                  // terminal
  assert.ok(reg.onboardingCanary.optionalConsumes.includes('clarify'));   // honors canary=no
});
