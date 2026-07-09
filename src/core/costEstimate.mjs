// Pre-run cost/time estimator for an Enable onboarding run.
//
// Calibration is deliberately thin: only three real onboarding runs exist on disk
// (tinytool $4.49/~10min, tinytool2 $5.53/~13min, bevup-admin $20.13/~46min). The
// model is a floor + linear-in-size term, nudged by the run's answers. Everything
// tunable lives in CALIBRATION so it can be re-fit as more real runs are logged.
//
// Size signal (decided): LOC is primary; a knowledge-graph node count overrides it
// when graphify-out already exists (a better proxy for how much the agents read).
// File count is a last-resort fallback when LOC can't be measured.

export const CALIBRATION = Object.freeze({
  // cost = BASE + PER_KUNIT * sizeKUnits^SIZE_EXP, then * answerMultiplier.
  // SIZE_EXP < 1 makes cost sublinear in size: agents read a subset of a big repo,
  // not every line, so a linear model wildly overshoots large codebases. Fit so a
  // tiny repo (~0.5 kUnit) lands ~$5 and a real app (~11 kUnit) ~$20.
  SIZE_EXP: 0.6,
  BASE_USD: 2.17,
  PER_KUNIT_USD: 4.28,
  // time = TIME_BASE + TIME_PER_KUNIT * sizeKUnits^SIZE_EXP (minutes), * multiplier
  TIME_BASE_MIN: 5.6,
  TIME_PER_KUNIT_MIN: 9.71,
  // range width around the mid (thin calibration -> wide, honest band)
  LOW_FACTOR: 0.6,
  HIGH_FACTOR: 1.7,
  // size conversions to a common "kUnit" (~1000 LOC) scale
  LOC_PER_KUNIT: 1000,
  GRAPH_NODES_PER_KUNIT: 40,   // ~40 graph nodes ≈ 1k LOC of code
  FILES_PER_KUNIT: 25,         // ~25 source files ≈ 1k LOC (fallback only)
  // answer multipliers — biggest lever is the test tier (real test generation)
  TEST_TIER: { 'docs-only': 0.85, scaffold: 1.0, smoke: 1.2, characterization: 1.45 },
  VENDORING: { none: 0.9, 'baseline-only': 1.0, full: 1.15 },
  CANARY: { no: 1.0, yes: 1.1 },
  PER_EXTRA_TOOL: 0.03,        // each non-Claude tool target adds a little work
});

const round2 = (n) => Math.round(n * 100) / 100;

// Resolve the run's size onto a common kUnit scale, preferring graph > loc > files.
function resolveSize({ loc, fileCount, graphNodes }) {
  const C = CALIBRATION;
  if (Number.isFinite(graphNodes) && graphNodes > 0) {
    return { sizeKUnits: graphNodes / C.GRAPH_NODES_PER_KUNIT, sizeSource: 'graph' };
  }
  if (Number.isFinite(loc) && loc > 0) {
    return { sizeKUnits: loc / C.LOC_PER_KUNIT, sizeSource: 'loc' };
  }
  if (Number.isFinite(fileCount) && fileCount > 0) {
    return { sizeKUnits: fileCount / C.FILES_PER_KUNIT, sizeSource: 'files' };
  }
  return { sizeKUnits: 0, sizeSource: 'none' };
}

// Combine per-answer multipliers into one factor applied to both cost and time.
function answerMultiplier(answers = {}) {
  const C = CALIBRATION;
  let m = 1;
  m *= C.TEST_TIER[answers.testTier] ?? 1;
  m *= C.VENDORING[answers.vendoringDepth] ?? 1;
  m *= C.CANARY[answers.canary] ?? 1;
  const targets = Array.isArray(answers.multiToolTargets) ? answers.multiToolTargets : [];
  const extra = targets.filter((t) => t && t !== 'claude').length;
  m *= 1 + C.PER_EXTRA_TOOL * extra;
  return m;
}

/**
 * Estimate the cost + wall-clock of an Enable run before it starts.
 *
 * @param {{loc?:number, fileCount?:number, graphNodes?:number|null, answers?:object}} input
 * @returns {{low:number, mid:number, high:number, minutes:number,
 *            minutesLow:number, minutesHigh:number,
 *            basis:{sizeKUnits:number, sizeSource:string}}}
 */
export function estimateCost({ loc = 0, fileCount = 0, graphNodes = null, answers = {} } = {}) {
  const C = CALIBRATION;
  const { sizeKUnits, sizeSource } = resolveSize({ loc, fileCount, graphNodes });
  const mult = answerMultiplier(answers);
  const size = Math.pow(sizeKUnits, C.SIZE_EXP);   // sublinear in repo size

  const midCost = (C.BASE_USD + C.PER_KUNIT_USD * size) * mult;
  const midMin = (C.TIME_BASE_MIN + C.TIME_PER_KUNIT_MIN * size) * mult;

  return {
    low: round2(midCost * C.LOW_FACTOR),
    mid: round2(midCost),
    high: round2(midCost * C.HIGH_FACTOR),
    minutes: Math.max(1, Math.round(midMin)),
    minutesLow: Math.max(1, Math.round(midMin * C.LOW_FACTOR)),
    minutesHigh: Math.max(1, Math.round(midMin * C.HIGH_FACTOR)),
    basis: { sizeKUnits: round2(sizeKUnits), sizeSource },
  };
}
