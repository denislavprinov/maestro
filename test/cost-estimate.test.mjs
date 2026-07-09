import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, CALIBRATION } from '../src/core/costEstimate.mjs';

// Anchored on the three real onboarding runs recorded in maestro.db:
//   tinytool  $4.49 / ~10min (tiny repo)   tinytool2 $5.53 / ~13min (tiny repo)
//   bevup-admin $20.13 / ~46min (real app)
// The model is calibrated so a tiny repo lands ~$5 and a real app ~$20.

test('tiny repo lands in the ~$5 ballpark', () => {
  const e = estimateCost({ loc: 500, fileCount: 12, answers: {} });
  assert.ok(e.mid >= 3 && e.mid <= 8, `tiny mid=${e.mid}`);
  assert.ok(e.low < e.mid && e.mid < e.high, 'range brackets mid');
});

test('real app lands in the ~$20 ballpark', () => {
  const e = estimateCost({ loc: 8000, fileCount: 300, answers: {} });
  assert.ok(e.mid >= 14 && e.mid <= 28, `app mid=${e.mid}`);
});

test('cost is monotonic in LOC', () => {
  const small = estimateCost({ loc: 1000, answers: {} });
  const big = estimateCost({ loc: 20000, answers: {} });
  assert.ok(big.mid > small.mid, 'more LOC -> more cost');
  assert.ok(big.minutes > small.minutes, 'more LOC -> more time');
});

test('heavier test tier raises cost', () => {
  const base = estimateCost({ loc: 4000, answers: { testTier: 'docs-only' } });
  const heavy = estimateCost({ loc: 4000, answers: { testTier: 'characterization' } });
  assert.ok(heavy.mid > base.mid, `characterization ${heavy.mid} > docs-only ${base.mid}`);
});

test('full vendoring + canary raise cost above minimal answers', () => {
  const min = estimateCost({ loc: 4000, answers: { vendoringDepth: 'none', canary: 'no' } });
  const max = estimateCost({ loc: 4000, answers: { vendoringDepth: 'full', canary: 'yes' } });
  assert.ok(max.mid > min.mid);
});

test('more multi-tool targets raise cost', () => {
  const one = estimateCost({ loc: 4000, answers: { multiToolTargets: [] } });
  const many = estimateCost({ loc: 4000, answers: { multiToolTargets: ['cursor', 'copilot', 'agents'] } });
  assert.ok(many.mid > one.mid);
});

test('graph node count overrides LOC as the size source when present', () => {
  const e = estimateCost({ loc: 4000, graphNodes: 250, answers: {} });
  assert.equal(e.basis.sizeSource, 'graph');
  const noGraph = estimateCost({ loc: 4000, answers: {} });
  assert.equal(noGraph.basis.sizeSource, 'loc');
});

test('falls back to file count when no LOC', () => {
  const e = estimateCost({ loc: 0, fileCount: 40, answers: {} });
  assert.equal(e.basis.sizeSource, 'files');
  assert.ok(e.mid > 0);
});

test('floors at BASE for an empty/unknown repo', () => {
  const e = estimateCost({ loc: 0, fileCount: 0, answers: {} });
  assert.ok(e.mid >= CALIBRATION.BASE_USD);
  assert.equal(e.basis.sizeSource, 'none');
});

test('all figures are finite, non-negative, and 2dp', () => {
  const e = estimateCost({ loc: 3000, answers: { testTier: 'smoke' } });
  for (const k of ['low', 'mid', 'high']) {
    assert.ok(Number.isFinite(e[k]) && e[k] >= 0, `${k}=${e[k]}`);
    assert.equal(Math.round(e[k] * 100) / 100, e[k], `${k} rounded to cents`);
  }
  assert.ok(Number.isInteger(e.minutes) && e.minutes > 0);
});
