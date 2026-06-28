import test from 'node:test';
import assert from 'node:assert/strict';
import { EMBEDDED_AGENTS, mergePalette, canConnect } from '../ui/public/composer-core.mjs';

test('palette has all onboarding agents and the connectsTo mismatch is fixed', () => {
  for (const k of ['onboardingClarifier','onboardingAnalyzer','onboardingTests','onboardingEvaluator','onboardingCanary'])
    assert.ok(EMBEDDED_AGENTS[k], `missing ${k}`);
  assert.deepEqual(EMBEDDED_AGENTS.projectOnboarding.connectsTo, ['onboardingTests']); // was []
  assert.equal(mergePalette(null).length, 15);                                          // was 10
});

test('governance allows the onboarding chain', () => {
  const a = mergePalette(null).reduce((m, x) => (m[x.key] = x, m), {});
  assert.equal(canConnect('onboardingAnalyzer', 'projectOnboarding', a).ok, true);
  assert.equal(canConnect('projectOnboarding', 'onboardingTests', a).ok, true);
  assert.equal(canConnect('onboardingTests', 'onboardingEvaluator', a).ok, true);
});
