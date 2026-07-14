// test/onboarding-contracts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIMENSION_KEYS,
  normalizeReadiness,
  normalizeGraphSummary,
} from '../src/core/onboarding-contracts.mjs';
import { DIMENSION_LABELS } from '../src/core/onboarding.mjs';

function canonicalDimensions(fill = 80) {
  const out = {};
  for (const k of DIMENSION_KEYS) out[k] = fill;
  return out;
}

test('DIMENSION_KEYS matches DIMENSION_LABELS keys exactly (parity)', () => {
  assert.deepEqual([...DIMENSION_KEYS].sort(), Object.keys(DIMENSION_LABELS).sort());
});

// ── normalizeReadiness ──────────────────────────────────────────────────────

test('normalizeReadiness: canonical object passes with zero warnings, value deep-equals input', () => {
  const input = { score: 80, baselineScore: 60, delta: 20, dimensions: canonicalDimensions(), gaps: ['add tests'] };
  const res = normalizeReadiness(input);
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings, []);
  assert.deepEqual(res.value, input);
});

test('normalizeReadiness: recomputes a mismatched delta and warns', () => {
  const res = normalizeReadiness({ score: 65, baselineScore: 60, delta: 60, dimensions: canonicalDimensions(), gaps: [] });
  assert.equal(res.ok, true);
  assert.equal(res.value.delta, 5);
  assert.ok(res.warnings.some((w) => /delta/i.test(w)));
});

test('normalizeReadiness: numeric-string score is coerced with a warning', () => {
  const res = normalizeReadiness({ score: '93', baselineScore: null, delta: null, dimensions: canonicalDimensions(), gaps: [] });
  assert.equal(res.ok, true);
  assert.equal(res.value.score, 93);
  assert.ok(res.warnings.some((w) => /score/i.test(w)));
});

test('normalizeReadiness: score above 100 is clamped', () => {
  const res = normalizeReadiness({ score: 150, baselineScore: null, delta: null, dimensions: canonicalDimensions(), gaps: [] });
  assert.equal(res.ok, true);
  assert.equal(res.value.score, 100);
  assert.ok(res.warnings.some((w) => /clamp/i.test(w)));
});

test('normalizeReadiness: missing dimension key -> null + warn', () => {
  const dims = canonicalDimensions();
  delete dims.codeHealth;
  const res = normalizeReadiness({ score: 80, baselineScore: null, delta: null, dimensions: dims, gaps: [] });
  assert.equal(res.ok, true);
  assert.equal(res.value.dimensions.codeHealth, null);
  assert.ok(res.warnings.some((w) => /codeHealth/.test(w)));
});

test('normalizeReadiness: unknown dimension key is dropped + warn', () => {
  const dims = canonicalDimensions();
  dims.bogusKey = 42;
  const res = normalizeReadiness({ score: 80, baselineScore: null, delta: null, dimensions: dims, gaps: [] });
  assert.equal(res.ok, true);
  assert.equal(res.value.dimensions.bogusKey, undefined);
  assert.deepEqual(Object.keys(res.value.dimensions).sort(), [...DIMENSION_KEYS].sort());
  assert.ok(res.warnings.some((w) => /bogusKey/.test(w)));
});

test('normalizeReadiness: garbage gaps -> [] + warn', () => {
  const res = normalizeReadiness({ score: 80, baselineScore: null, delta: null, dimensions: canonicalDimensions(), gaps: 'not-an-array' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value.gaps, []);
  assert.ok(res.warnings.some((w) => /gaps/i.test(w)));
});

test('normalizeReadiness: fatal on non-object input', () => {
  const res = normalizeReadiness(null);
  assert.equal(res.ok, false);
  assert.equal(res.value, undefined);
});

test('normalizeReadiness: fatal on missing score', () => {
  const res = normalizeReadiness({ baselineScore: null, delta: null, dimensions: canonicalDimensions(), gaps: [] });
  assert.equal(res.ok, false);
});

test('normalizeReadiness: fatal on non-numeric score string', () => {
  const res = normalizeReadiness({ score: 'high', baselineScore: null, delta: null, dimensions: canonicalDimensions(), gaps: [] });
  assert.equal(res.ok, false);
});

// ── normalizeGraphSummary ───────────────────────────────────────────────────

function canonicalGraph() {
  return {
    skillCandidates: [{ name: 'x', surface: 'y', footgun: 'z', whySkill: 'w', frequency: 3, exampleFiles: ['a.mjs'] }],
    pureUnits: [{ file: 'a.mjs', symbol: 'foo', why: 'pure' }],
    baselineReadiness: { score: 40, dimensions: canonicalDimensions(40), note: 'n' },
    degraded: false,
    stack: { lang: 'js' },
    domain: 'prose passthrough',
  };
}

test('normalizeGraphSummary: canonical object passes with zero warnings', () => {
  const input = canonicalGraph();
  const res = normalizeGraphSummary(input);
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings, []);
  assert.deepEqual(res.value, input);
});

test('normalizeGraphSummary: non-object skillCandidate entry dropped + warn', () => {
  const input = canonicalGraph();
  input.skillCandidates = [input.skillCandidates[0], 'garbage', null];
  const res = normalizeGraphSummary(input);
  assert.equal(res.ok, true);
  assert.equal(res.value.skillCandidates.length, 1);
  assert.ok(res.warnings.some((w) => /skillCandidates/.test(w)));
});

test('normalizeGraphSummary: missing pureUnits -> [] + warn', () => {
  const input = canonicalGraph();
  delete input.pureUnits;
  const res = normalizeGraphSummary(input);
  assert.equal(res.ok, true);
  assert.deepEqual(res.value.pureUnits, []);
  assert.ok(res.warnings.some((w) => /pureUnits/.test(w)));
});

test('normalizeGraphSummary: absent baselineReadiness stays absent, no warn', () => {
  const input = canonicalGraph();
  delete input.baselineReadiness;
  const res = normalizeGraphSummary(input);
  assert.equal(res.ok, true);
  assert.equal('baselineReadiness' in res.value, false);
  assert.deepEqual(res.warnings, []);
});

test('normalizeGraphSummary: non-boolean degraded coerced to false + warn', () => {
  const input = canonicalGraph();
  delete input.degraded;
  const res = normalizeGraphSummary(input);
  assert.equal(res.ok, true);
  assert.equal(res.value.degraded, false);
  assert.ok(res.warnings.some((w) => /degraded/i.test(w)));
});

test('normalizeGraphSummary: fatal on non-object input', () => {
  const res = normalizeGraphSummary('nope');
  assert.equal(res.ok, false);
});
