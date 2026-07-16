// src/core/onboarding-contracts.mjs
// Pure normalizers for the LLM-written onboarding JSON contracts
// (readiness.json, graph-summary.json). No I/O — callers read/write the
// files. Policy: repair + warn what code can fix; fail only when the
// artifact is unusable (see docs/superpowers/specs/2026-07-14-onboarding-contracts-design.md).
//
// Each normalizer returns { ok, value, warnings }:
//   ok:false   -> fatal (unusable); value is absent.
//   ok:true    -> value is the normalized object; warnings describes every repair.

import { CURATED_BASELINE, STACK_CATALOG } from './skill-vendor.mjs';

/** The 9 readiness dimension keys — single source of truth, kept in parity
 *  with DIMENSION_LABELS (src/core/onboarding.mjs) by a dedicated test. */
export const DIMENSION_KEYS = Object.freeze([
  'docs', 'skillsAgents', 'rules', 'tests', 'featureSkillCoverage',
  'realTests', 'vendoring', 'multiTool', 'codeHealth',
]);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Coerce to a finite number (numeric strings accepted); null otherwise. */
function toNumberOrNull(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function clamp0to100(n) {
  return Math.min(100, Math.max(0, n));
}

/** Normalize the 9-key dimensions object; always returns a complete object. */
function normalizeDimensions(raw, warnings, label) {
  const out = {};
  const src = isPlainObject(raw) ? raw : null;
  if (!src) warnings.push(`${label}.dimensions: missing or not an object — defaulted to all-null`);
  for (const key of DIMENSION_KEYS) {
    if (!src || !(key in src)) {
      out[key] = null;
      if (src) warnings.push(`${label}.dimensions.${key}: missing — defaulted to null`);
      continue;
    }
    const v = src[key];
    if (v === null) { out[key] = null; continue; }
    const n = toNumberOrNull(v);
    if (n === null) {
      out[key] = null;
      warnings.push(`${label}.dimensions.${key}: not a usable number (${JSON.stringify(v)}) — defaulted to null`);
    } else {
      out[key] = clamp0to100(n);
    }
  }
  if (src) {
    for (const key of Object.keys(src)) {
      if (!DIMENSION_KEYS.includes(key)) {
        warnings.push(`${label}.dimensions.${key}: unknown dimension key — dropped`);
      }
    }
  }
  return out;
}

/**
 * Normalize a readiness.json object.
 * Fatal: not a plain object, or no usable numeric score.
 */
export function normalizeReadiness(raw) {
  const warnings = [];
  if (!isPlainObject(raw)) {
    return { ok: false, warnings: ['readiness: not a plain object'] };
  }

  let score = toNumberOrNull(raw.score);
  if (score === null) {
    return { ok: false, warnings: [`readiness.score: no usable numeric value (${JSON.stringify(raw.score)})`] };
  }
  if (typeof raw.score !== 'number') {
    warnings.push(`readiness.score: coerced "${raw.score}" to a number`);
  }
  const clampedScore = clamp0to100(score);
  if (clampedScore !== score) warnings.push(`readiness.score: clamped ${score} to ${clampedScore}`);
  score = clampedScore;

  let baselineScore = toNumberOrNull(raw.baselineScore);
  if (baselineScore === null && raw.baselineScore != null) {
    warnings.push(`readiness.baselineScore: not a usable number (${JSON.stringify(raw.baselineScore)}) — defaulted to null`);
  }

  const recomputedDelta = baselineScore === null ? null : score - baselineScore;
  const storedDelta = toNumberOrNull(raw.delta);
  if (storedDelta !== recomputedDelta) {
    warnings.push(`readiness.delta: stored ${JSON.stringify(raw.delta)} did not match recomputed ${recomputedDelta} — recomputed value used`);
  }

  const dimensions = normalizeDimensions(raw.dimensions, warnings, 'readiness');

  let gaps;
  if (!Array.isArray(raw.gaps)) {
    gaps = [];
    warnings.push(`readiness.gaps: missing or not an array — defaulted to []`);
  } else {
    gaps = [];
    for (const g of raw.gaps) {
      if (typeof g === 'string') gaps.push(g);
      else if (g != null && typeof g !== 'object') gaps.push(String(g));
      else warnings.push(`readiness.gaps: dropped non-string entry (${JSON.stringify(g)})`);
    }
  }

  const knownKeys = new Set(['score', 'baselineScore', 'delta', 'dimensions', 'gaps']);
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) warnings.push(`readiness.${key}: unknown top-level field — dropped`);
  }

  return {
    ok: true,
    value: { score, baselineScore, delta: recomputedDelta, dimensions, gaps },
    warnings,
  };
}

function normalizeSkillCandidates(raw, warnings) {
  if (!Array.isArray(raw)) {
    warnings.push('graph.skillCandidates: missing or not an array — defaulted to []');
    return [];
  }
  const out = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) {
      warnings.push(`graph.skillCandidates: dropped non-object entry (${JSON.stringify(entry)})`);
      continue;
    }
    out.push({
      name: entry.name != null ? String(entry.name) : '',
      surface: entry.surface != null ? String(entry.surface) : '',
      footgun: entry.footgun != null ? String(entry.footgun) : '',
      whySkill: entry.whySkill != null ? String(entry.whySkill) : '',
      frequency: toNumberOrNull(entry.frequency),
      exampleFiles: Array.isArray(entry.exampleFiles) ? entry.exampleFiles.map(String) : [],
    });
  }
  return out;
}

function normalizePureUnits(raw, warnings) {
  if (!Array.isArray(raw)) {
    warnings.push('graph.pureUnits: missing or not an array — defaulted to []');
    return [];
  }
  const out = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) {
      warnings.push(`graph.pureUnits: dropped non-object entry (${JSON.stringify(entry)})`);
      continue;
    }
    out.push({
      file: entry.file != null ? String(entry.file) : '',
      symbol: entry.symbol != null ? String(entry.symbol) : '',
      why: entry.why != null ? String(entry.why) : '',
    });
  }
  return out;
}

/**
 * Normalize a graph-summary.json object.
 * Fatal: not a plain object.
 */
export function normalizeGraphSummary(raw) {
  const warnings = [];
  if (!isPlainObject(raw)) {
    return { ok: false, warnings: ['graph: not a plain object'] };
  }

  const value = { ...raw };

  value.skillCandidates = normalizeSkillCandidates(raw.skillCandidates, warnings);
  value.pureUnits = normalizePureUnits(raw.pureUnits, warnings);

  if ('baselineReadiness' in raw && raw.baselineReadiness != null) {
    const br = raw.baselineReadiness;
    if (isPlainObject(br)) {
      const brScore = toNumberOrNull(br.score);
      if (brScore === null && br.score != null) {
        warnings.push(`graph.baselineReadiness.score: not a usable number (${JSON.stringify(br.score)}) — defaulted to null`);
      }
      value.baselineReadiness = {
        score: brScore === null ? null : clamp0to100(brScore),
        dimensions: normalizeDimensions(br.dimensions, warnings, 'graph.baselineReadiness'),
        note: br.note != null ? String(br.note) : '',
      };
    } else {
      warnings.push(`graph.baselineReadiness: not an object (${JSON.stringify(br)}) — dropped`);
      delete value.baselineReadiness;
    }
  } else {
    delete value.baselineReadiness;
  }

  if (typeof raw.degraded !== 'boolean') {
    value.degraded = false;
    warnings.push(`graph.degraded: missing or not a boolean — defaulted to false`);
  } else {
    value.degraded = raw.degraded;
  }

  if (!isPlainObject(raw.stack)) {
    value.stack = {};
    warnings.push(`graph.stack: missing or not an object — defaulted to {}`);
  } else {
    value.stack = raw.stack;
  }

  return { ok: true, value, warnings };
}

const TOOL_SOURCES = new Set(['bundle', 'global', 'project', 'plugin', 'unknown']);
const SUGGESTION_SOURCES = new Set(['catalog', 'analyzer', 'stack-match']);

/** Normalize one {name, ...} entry array; entries without a usable name are dropped. */
function namedEntries(raw, warnings, label, shape) {
  if (!Array.isArray(raw)) {
    warnings.push(`${label}: missing or not an array — defaulted to []`);
    return [];
  }
  const out = [];
  for (const e of raw) {
    if (!isPlainObject(e) || typeof e.name !== 'string' || !e.name.trim()) {
      warnings.push(`${label}: dropped entry without a usable name (${JSON.stringify(e)})`);
      continue;
    }
    out.push(shape(e, e.name.trim()));
  }
  return out;
}

/**
 * Normalize a tools.json object (infra-gen's installed/skipped/suggested tool report).
 * Fatal: not a plain object. `mandatory` is DERIVED from CURATED_BASELINE membership
 * (always recomputed, mirroring readiness.delta); suggested entries already installed
 * are pruned.
 */
export function normalizeToolsReport(raw, { stackMatches = [] } = {}) {
  const warnings = [];
  if (!isPlainObject(raw)) {
    return { ok: false, warnings: ['tools: not a plain object'] };
  }
  const baseline = new Set(CURATED_BASELINE);

  const installed = namedEntries(raw.installed, warnings, 'tools.installed', (e, name) => {
    let source = typeof e.source === 'string' && TOOL_SOURCES.has(e.source) ? e.source : 'unknown';
    if (source === 'unknown' && e.source !== 'unknown') {
      warnings.push(`tools.installed.${name}.source: not a known source (${JSON.stringify(e.source)}) — defaulted to "unknown"`);
    }
    const mandatory = baseline.has(name);
    if (typeof e.mandatory === 'boolean' && e.mandatory !== mandatory) {
      warnings.push(`tools.installed.${name}.mandatory: stored ${e.mandatory} did not match the curated baseline — recomputed value used`);
    }
    return { name, source, mandatory };
  });

  const skipped = namedEntries(raw.skipped, warnings, 'tools.skipped', (e, name) => ({
    name, reason: e.reason != null ? String(e.reason) : '',
  }));

  const installedNames = new Set(installed.map((t) => t.name));
  const suggested = namedEntries(raw.suggested, warnings, 'tools.suggested', (e, name) => {
    let source = typeof e.source === 'string' && SUGGESTION_SOURCES.has(e.source) ? e.source : 'catalog';
    if (source === 'catalog' && e.source != null && e.source !== 'catalog') {
      warnings.push(`tools.suggested.${name}.source: not catalog|analyzer (${JSON.stringify(e.source)}) — defaulted to "catalog"`);
    }
    return { name, reason: e.reason != null ? String(e.reason) : '', source };
  }).filter((s) => {
    if (installedNames.has(s.name)) {
      warnings.push(`tools.suggested.${s.name}: already installed — dropped`);
      return false;
    }
    return true;
  });

  // Union deterministic stack matches into suggested. Installed and
  // agent-suggested names win — the matcher only ADDS, never overrides.
  // Each addition pushes a warning so the hook's existing warnings-triggered
  // rewrite persists the unioned file (clean files stay byte-identical).
  const suggestedNames = new Set(suggested.map((s) => s.name));
  for (const m of stackMatches) {
    for (const name of STACK_CATALOG[m.stack] || []) {
      if (installedNames.has(name) || suggestedNames.has(name)) continue;
      suggested.push({ name, reason: String(m.evidence || `${m.stack} detected`), source: 'stack-match' });
      suggestedNames.add(name);
      warnings.push(`tools.suggested.${name}: added from stack match (${m.stack})`);
    }
  }

  const knownKeys = new Set(['installed', 'skipped', 'suggested']);
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) warnings.push(`tools.${key}: unknown top-level field — dropped`);
  }

  return { ok: true, value: { installed, skipped, suggested }, warnings };
}
