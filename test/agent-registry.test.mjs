// test/agent-registry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadAgentRegistry, registryToSteps } from '../src/core/agent-registry.mjs';
import { AGENT_STEPS } from '../src/core/config.mjs';

test('loadAgentRegistry returns the 6 shipped agents', () => {
  const reg = loadAgentRegistry();
  assert.deepEqual(
    Object.keys(reg).sort(),
    ['implementer', 'manualTestsChecklist', 'manualWebUiTesting', 'planner', 'refiner', 'reviewer'],
  );
  assert.equal(Object.keys(reg).length, 6);
});

test('each entry is a well-formed AgentMeta', () => {
  const reg = loadAgentRegistry();
  const COLORS = new Set(['green', 'peach', 'red', 'blue', 'violet', 'amber']);
  for (const [key, m] of Object.entries(reg)) {
    assert.equal(m.key, key);
    assert.equal(typeof m.displayName, 'string');
    assert.ok(COLORS.has(m.color), `bad color for ${key}: ${m.color}`);
    assert.equal(typeof m.icon, 'string');
    assert.ok(m.icon.length > 0);
    assert.ok(['producer', 'verifier'].includes(m.runnerType));
    assert.equal(typeof m.loopSource, 'boolean');
    assert.ok(m.connectsTo === '*' || Array.isArray(m.connectsTo), `connectsTo for ${key}: ${JSON.stringify(m.connectsTo)}`);
    assert.equal(typeof m.order, 'number');
  }
});

test('shipped colors match the mockup palette EXACTLY (pins C5 — coercion would hide a typo)', () => {
  // normalizeMeta coerces an out-of-set color to 'amber', so the generic COLORS.has
  // check above would NOT catch a `blue` -> `bleu` typo. Pin the intended colors.
  const reg = loadAgentRegistry();
  assert.equal(reg.planner.color, 'violet');
  assert.equal(reg.refiner.color, 'green');
  assert.equal(reg.implementer.color, 'peach');
  assert.equal(reg.reviewer.color, 'blue');
  assert.equal(reg.manualTestsChecklist.color, 'blue');   // C5: blue everywhere
  assert.equal(reg.manualWebUiTesting.color, 'violet');
});

test('registry insertion order follows .order ascending', () => {
  const reg = loadAgentRegistry();
  const orders = Object.values(reg).map((m) => m.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  assert.deepEqual(Object.keys(reg), [
    'planner', 'refiner', 'implementer', 'reviewer', 'manualTestsChecklist', 'manualWebUiTesting',
  ]);
});

test('registryToSteps matches the legacy AGENT_STEPS for the original 4', () => {
  const reg = loadAgentRegistry();
  const steps = registryToSteps(reg);
  assert.deepEqual(steps.slice(0, 4), [
    { key: 'planner', label: 'Plan' },
    { key: 'refiner', label: 'Refine' },
    { key: 'implementer', label: 'Implement' },
    { key: 'reviewer', label: 'Review' },
  ]);
  // And config.AGENT_STEPS (derived from the registry in Task 6) stays equal to it.
  assert.deepEqual(steps, AGENT_STEPS);
});

test('registryToSteps appends the two new agents with their display names', () => {
  const steps = registryToSteps(loadAgentRegistry());
  assert.equal(steps.length, 6);
  assert.deepEqual(steps[4], { key: 'manualTestsChecklist', label: 'Manual Tests Checklist' });
  assert.deepEqual(steps[5], { key: 'manualWebUiTesting', label: 'Manual web UI testing' });
});

test('every agentFile points at an existing prompt under agents/', () => {
  const reg = loadAgentRegistry();
  const agentsDir = new URL('../agents/', import.meta.url).pathname;
  for (const m of Object.values(reg)) {
    assert.ok(m.agentFile, `${m.key} has no agentFile`);
    assert.ok(
      existsSync(join(agentsDir, m.agentFile)),
      `missing prompt file for ${m.key}: ${m.agentFile}`,
    );
  }
});

test('original four agentFiles match the orchestrator AGENT_FILES map', () => {
  const reg = loadAgentRegistry();
  // Mirror of orchestrator.mjs:48-53 (the hardcoded map a later phase replaces).
  const LEGACY_AGENT_FILES = {
    planner: 'maestro-planner.md',
    refiner: 'maestro-plan-refiner.md',
    implementer: 'maestro-implementer.md',
    reviewer: 'maestro-code-reviewer.md',
  };
  for (const [key, file] of Object.entries(LEGACY_AGENT_FILES)) {
    assert.equal(reg[key].agentFile, file, `agentFile mismatch for ${key}`);
  }
});

test('exactly the two verifiers are loopSources; producers are not', () => {
  const reg = loadAgentRegistry();
  const loopSources = Object.values(reg).filter((m) => m.loopSource).map((m) => m.key).sort();
  assert.deepEqual(loopSources, ['manualWebUiTesting', 'reviewer']);
  for (const m of Object.values(reg)) {
    if (m.runnerType === 'producer') assert.equal(m.loopSource, false, `${m.key} producer must not loop`);
  }
});

test('registry stamps default channel spec for the six built-ins', () => {
  const reg = loadAgentRegistry(); // real agents/ dir
  assert.deepEqual(reg.planner.consumes, ['userPrompt']);
  assert.deepEqual(reg.planner.produces, ['plan']);
  assert.deepEqual(reg.refiner.produces, ['plan', 'review']);
  assert.deepEqual(reg.implementer.consumes, ['plan', 'review']);
  assert.deepEqual(reg.implementer.optionalConsumes, ['review']);
  assert.deepEqual(reg.implementer.produces, ['code']);
  assert.deepEqual(reg.reviewer.consumes, ['plan', 'code']);
  assert.deepEqual(reg.reviewer.produces, ['review']);
  // connectsTo superset keeps shipped pipelines legal
  assert.ok(reg.reviewer.connectsTo.includes('implementer'));
  assert.ok(reg.reviewer.connectsTo.includes('manualTestsChecklist'));
  assert.ok(reg.refiner.connectsTo.includes('refiner')); // self-loop legal
});
