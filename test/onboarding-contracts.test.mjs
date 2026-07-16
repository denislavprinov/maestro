// test/onboarding-contracts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIMENSION_KEYS,
  normalizeReadiness,
  normalizeGraphSummary,
  normalizeToolsReport,
  normalizeTasksReport,
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

// ── normalizeToolsReport ────────────────────────────────────────────────────

test('normalizeToolsReport: canonical object passes clean', () => {
  const input = {
    installed: [{ name: 'graphify', source: 'global', mandatory: true },
                { name: 'writing-plans', source: 'bundle', mandatory: false }],
    skipped: [{ name: 'my-private-thing', reason: 'not on allowlist' }],
    suggested: [{ name: 'executing-plans', reason: 'pairs with writing-plans', source: 'catalog' }],
  };
  const res = normalizeToolsReport(input);
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings, []);
  assert.deepEqual(res.value, input);
});

test('normalizeToolsReport: not an object is fatal', () => {
  assert.equal(normalizeToolsReport([]).ok, false);
  assert.equal(normalizeToolsReport('x').ok, false);
});

test('normalizeToolsReport: missing arrays default to [] with warnings', () => {
  const res = normalizeToolsReport({});
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, { installed: [], skipped: [], suggested: [] });
  assert.equal(res.warnings.length, 3);
});

test('normalizeToolsReport: mandatory is recomputed from the curated baseline', () => {
  const res = normalizeToolsReport({ installed: [
    { name: 'caveman', source: 'plugin', mandatory: false },      // lies: caveman IS baseline
    { name: 'writing-plans', source: 'global', mandatory: true }, // lies: it is not
  ], skipped: [], suggested: [] });
  assert.equal(res.ok, true);
  assert.equal(res.value.installed[0].mandatory, true);
  assert.equal(res.value.installed[1].mandatory, false);
  assert.ok(res.warnings.length >= 2);
});

test('normalizeToolsReport: bad entries dropped, unknown source coerced, installed names pruned from suggested', () => {
  const res = normalizeToolsReport({
    installed: [{ name: 'graphify', source: 'weird' }, { source: 'global' }, 'junk'],
    skipped: [{ name: 'x' }],
    suggested: [{ name: 'graphify', reason: 'dupe' }, { name: 'executing-plans', source: 'nope' }],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value.installed, [{ name: 'graphify', source: 'unknown', mandatory: true }]);
  assert.deepEqual(res.value.skipped, [{ name: 'x', reason: '' }]);
  assert.deepEqual(res.value.suggested, [{ name: 'executing-plans', reason: '', source: 'catalog' }]);
  assert.ok(res.warnings.length >= 4);
});

test('normalizeToolsReport: stack matches union into suggested with source stack-match', () => {
  const r = normalizeToolsReport(
    { installed: [{ name: 'graphify', source: 'bundle' }], skipped: [], suggested: [] },
    { stackMatches: [{ stack: 'spring-boot', evidence: 'Spring Boot detected (pom.xml)' }] },
  );
  assert.equal(r.ok, true);
  const names = r.value.suggested.map((s) => s.name);
  for (const n of ['rest-api-conventions', 'spring-data-jpa', 'spring-security-jwt', 'flyway-migrations', 'testing-pyramid']) {
    assert.ok(names.includes(n), `${n} suggested for spring-boot`);
  }
  const s = r.value.suggested.find((x) => x.name === 'spring-data-jpa');
  assert.equal(s.source, 'stack-match');
  assert.equal(s.reason, 'Spring Boot detected (pom.xml)');
});

test('normalizeToolsReport: union skips installed names and agent suggestions win collisions', () => {
  const r = normalizeToolsReport(
    {
      installed: [{ name: 'docker', source: 'bundle' }],
      skipped: [],
      suggested: [{ name: 'terraform', reason: 'agents saw infra dirs', source: 'analyzer' }],
    },
    { stackMatches: [{ stack: 'docker', evidence: 'Docker detected (Dockerfile)' },
                     { stack: 'terraform', evidence: 'Terraform detected (*.tf)' }] },
  );
  assert.equal(r.ok, true);
  assert.ok(!r.value.suggested.some((s) => s.name === 'docker'), 'installed name never suggested');
  const tf = r.value.suggested.filter((s) => s.name === 'terraform');
  assert.equal(tf.length, 1, 'no duplicate');
  assert.equal(tf[0].source, 'analyzer', 'agent suggestion wins the collision');
});

test('normalizeToolsReport: agent-written stack-match source is accepted verbatim', () => {
  const r = normalizeToolsReport({ installed: [], skipped: [], suggested: [{ name: 'docker', reason: 'x', source: 'stack-match' }] });
  assert.equal(r.ok, true);
  assert.equal(r.value.suggested[0].source, 'stack-match');
});

// ── normalizeTasksReport ────────────────────────────────────────────────────

test('normalizeTasksReport: canonical object passes clean, counts intact', () => {
  const input = {
    attempted: [
      { gap: 'Add smoke test for CLI entry', status: 'completed', notes: 'test added + passing' },
      { gap: 'Document release flow', status: 'skipped', notes: 'needs a human decision' },
    ],
    completed: 1, skipped: 1, failed: 0,
  };
  const res = normalizeTasksReport(input);
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings, []);
  assert.deepEqual(res.value, input);
});

test('normalizeTasksReport: not an object is fatal', () => {
  assert.equal(normalizeTasksReport(null).ok, false);
  assert.equal(normalizeTasksReport([1]).ok, false);
});

test('normalizeTasksReport: counts are recomputed from attempted, mismatch warns', () => {
  const res = normalizeTasksReport({
    attempted: [{ gap: 'x', status: 'completed' }, { gap: 'y', status: 'failed' }],
    completed: 9, skipped: 9, failed: 9,
  });
  assert.equal(res.ok, true);
  assert.equal(res.value.completed, 1);
  assert.equal(res.value.skipped, 0);
  assert.equal(res.value.failed, 1);
  assert.ok(res.warnings.some((w) => /completed/.test(w)));
});

test('normalizeTasksReport: bad status coerced to skipped, gapless entries dropped', () => {
  const res = normalizeTasksReport({ attempted: [
    { gap: 'x', status: 'wat' }, { status: 'completed' }, 'junk',
  ] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value.attempted, [{ gap: 'x', status: 'skipped', notes: '' }]);
  assert.equal(res.value.skipped, 1);
  assert.ok(res.warnings.length >= 3); // bad status + 2 drops (+ count defaults)
});
