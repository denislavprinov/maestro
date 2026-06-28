import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSkillRefs, CURATED_BASELINE, resolveVendorTargets } from '../src/core/skill-vendor.mjs';

test('extractSkillRefs finds Skill(...) / /name / "use the X skill"', () => {
  const refs = extractSkillRefs('Run Skill({skill:"graphify"}); then /test-driven-development and use the systematic-debugging skill.');
  assert.deepEqual([...refs].sort(), ['graphify', 'systematic-debugging', 'test-driven-development']);
});

test('curated baseline is always vendored even with zero refs', () => {
  const { vendor } = resolveVendorTargets(new Set(), { allowlist: CURATED_BASELINE });
  assert.deepEqual(vendor.sort(), [...CURATED_BASELINE].sort());
});

test('a referenced skill NOT on the allowlist is skipped (never copies personal skills)', () => {
  const { vendor, skipped } = resolveVendorTargets(new Set(['my-private-thing']), { allowlist: CURATED_BASELINE });
  assert.ok(!vendor.includes('my-private-thing'));
  assert.deepEqual(skipped, ['my-private-thing']);
});
