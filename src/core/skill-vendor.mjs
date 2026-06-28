// src/core/skill-vendor.mjs
// Pure vendoring-policy contract for the onboarding infra-gen agent. Decides WHICH
// skill names may be vendored into a target repo; the agent does the physical copy.
// SECURITY (clarify #2): only allowlisted/bundled names are ever vendored — an
// arbitrary personal ~/.claude/skills reference is reported, never copied.

/** Always-vendored known-good floor (run-config overridable). */
export const CURATED_BASELINE = Object.freeze([
  'graphify', 'test-driven-development', 'systematic-debugging', 'verification-before-completion',
]);

/** Vetted allowlist the pipeline is permitted to vendor (superset of the baseline).
 *  Extend deliberately; membership — not physical location — is the gate. */
export const CURATED_ALLOWLIST = Object.freeze([
  ...CURATED_BASELINE, 'writing-plans', 'executing-plans', 'requesting-code-review',
]);

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
