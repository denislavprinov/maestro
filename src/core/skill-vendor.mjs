// src/core/skill-vendor.mjs
// Vendoring-policy contract for the onboarding infra-gen agent (pure) + presence-based destination probes (read-only fs).
// Decides WHICH skill names may be vendored into a target repo; the agent does the physical copy.
// SECURITY (clarify #2): only allowlisted/bundled names are ever vendored — an
// arbitrary personal ~/.claude/skills reference is reported, never copied.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Always-vendored known-good floor (run-config overridable). */
export const CURATED_BASELINE = Object.freeze([
  'graphify', 'caveman', 'test-driven-development', 'systematic-debugging', 'verification-before-completion',
]);

/** Optional add-ons: offered at clarify (Q6) and suggested on the results screen.
 *  Invariant (tested): subset of the allowlist, disjoint from the baseline. */
export const OPTIONAL_CATALOG = Object.freeze([
  'writing-plans', 'executing-plans', 'requesting-code-review',
]);

/** Stack-matched add-ons from the vetted mirror (skills/<name>/, see each dir's
 *  ATTRIBUTION.md). Suggested on the results screen when detectStacks() finds the
 *  stack in the target repo. Invariants (tested): subset of the allowlist,
 *  disjoint from the baseline AND the optional catalog. */
export const STACK_CATALOG = Object.freeze({
  'spring-boot':    Object.freeze(['rest-api-conventions', 'spring-data-jpa', 'spring-security-jwt', 'flyway-migrations', 'testing-pyramid']),
  swift:            Object.freeze(['swift', 'swiftui']),
  docker:           Object.freeze(['docker']),
  kubernetes:       Object.freeze(['kubernetes']),
  terraform:        Object.freeze(['terraform']),
  'github-actions': Object.freeze(['github-actions']),
  react:            Object.freeze(['react']),
  nextjs:           Object.freeze(['nextjs']),
  django:           Object.freeze(['django']),
  fastapi:          Object.freeze(['fastapi']),
  express:          Object.freeze(['express']),
});

/** Flat unique union of every STACK_CATALOG skill name. */
export const STACK_SKILLS = Object.freeze([...new Set(Object.values(STACK_CATALOG).flat())]);

/** Vetted allowlist the pipeline is permitted to vendor (superset of the baseline).
 *  Extend deliberately; membership — not physical location — is the gate. */
export const CURATED_ALLOWLIST = Object.freeze([...CURATED_BASELINE, ...OPTIONAL_CATALOG, ...STACK_SKILLS]);

const SKILL_REF_PATTERNS = [
  /Skill\(\s*{[^}]*skill\s*:\s*['"]([a-z0-9][a-z0-9-]*)['"]/gi, // Skill({skill:'x'})
  /(?:^|\s)\/([a-z0-9][a-z0-9-]*)\b/g,                          // /skill-name
  /use the ([a-z0-9][a-z0-9-]*) skill/gi,                       // "use the X skill"
];

/** Extract referenced skill names from an artifact's text → Set<string>. */
export function extractSkillRefs(text) {
  const out = new Set();
  const s = String(text || '');
  for (const re of SKILL_REF_PATTERNS) {
    for (const m of s.matchAll(re)) if (m[1]) out.add(m[1].toLowerCase());
  }
  return out;
}

/** Split referenced names into {vendor, skipped} by allowlist membership, then
 *  always union the curated baseline into `vendor`. Pure. */
export function resolveVendorTargets(refs, { allowlist = CURATED_ALLOWLIST, baseline = CURATED_BASELINE } = {}) {
  const allow = new Set(allowlist);
  const vendor = new Set(baseline);
  const skipped = [];
  for (const name of refs || []) {
    if (allow.has(name)) vendor.add(name);
    else skipped.push(name);
  }
  return { vendor: [...vendor], skipped };
}

/** Where vendored skills go in `projectDir`, presence-based: which AI-tool
 *  footprints does the repo actually have? (Infra-gen writes those footprints
 *  from the multiToolTargets answer during the run, so the user's choice is
 *  reflected on disk; also correct for old runs and hand-configured repos.)
 *  `.claude/skills` always and first; Copilot has no skills support. */
export function vendorDestinations(projectDir) {
  const dests = ['.claude/skills'];
  if (existsSync(join(projectDir, '.cursor', 'rules')) || existsSync(join(projectDir, '.cursorrules'))) {
    dests.push('.cursor/skills');
  }
  if (existsSync(join(projectDir, 'AGENTS.md'))) dests.push('.agents/skills');
  return dests;
}
