import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAgentRegistry } from '../src/core/agent-registry.mjs';

function readAgentBody(filename) {
  const path = join('agents', filename);
  const content = readFileSync(path, 'utf-8');
  // Extract body after front matter (---)
  const parts = content.split('---');
  return parts.length > 2 ? parts.slice(2).join('---') : content;
}

test('onboarding agents are registered with correct channel wiring', () => {
  const reg = loadAgentRegistry(undefined, { userAgentsDir: null }); // built-in layer only
  assert.equal(Object.keys(reg).length, 19);                          // was 12, +5 onboarding, +1 enableClarifier, +1 onboardingExecutor

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

test('infra-gen prompt instructs multi-tool skill mirroring', () => {
  const body = readAgentBody('maestro-project-onboarding.md');
  assert.match(body, /\.cursor\/skills/, 'names .cursor/skills');
  assert.match(body, /\.agents\/skills/, 'names .agents/skills');
  assert.match(body, /copilot/i, 'covers the copilot no-skills case');
});
