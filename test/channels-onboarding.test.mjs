// test/channels-onboarding.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate, publish, CHANNEL_IDS } from '../src/core/channels.mjs';

const A = { projectDir: '/p', pipelineDir: '/pipe', baseName: 'feat', datePrefix: '28-06-26', cycle: 1 };

test('CHANNEL_IDS includes graph + readiness', () => {
  assert.ok(CHANNEL_IDS.includes('graph'));
  assert.ok(CHANNEL_IDS.includes('readiness'));
});

test('allocate(graph) → summary path in pipeline dir + committed graphify-out dir', () => {
  const g = allocate('graph', { ...A, key: 'onboardingAnalyzer' });
  assert.equal(g.kind, 'graph');
  assert.equal(g.path, '/pipe/graph-summary.json');
  assert.equal(g.graphDir, '/p/graphify-out');
  assert.equal(allocate('graph', { ...A, key: 'onboardingAnalyzer', cycle: 2 }).path, '/pipe/graph-summary-cycle2.json');
});

test('allocate(readiness) → md + json pair', () => {
  const r = allocate('readiness', { ...A, key: 'onboardingEvaluator' });
  assert.equal(r.path, '/pipe/readiness.md');
  assert.equal(r.jsonPath, '/pipe/readiness.json');
  // Canonical "latest" pointer: every cycle writes the SAME unsuffixed path so the
  // card always reflects the final cycle (never frozen at cycle 1).
  assert.equal(allocate('readiness', { ...A, cycle: 3 }).jsonPath, '/pipe/readiness.json');
  assert.equal(allocate('readiness', { ...A, cycle: 3 }).path, '/pipe/readiness.md');
});

test('publish folds graph summary path onto the bus', () => {
  const bus = {};
  publish(['graph'], { summary: 'ok' }, { graph: allocate('graph', { ...A, key: 'onboardingAnalyzer' }) }, bus);
  assert.equal(bus.graph.path, '/pipe/graph-summary.json');
});
