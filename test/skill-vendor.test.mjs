import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSkillRefs, CURATED_BASELINE, CURATED_ALLOWLIST, OPTIONAL_CATALOG, STACK_CATALOG, STACK_SKILLS, vendorDestinations, resolveVendorTargets } from '../src/core/skill-vendor.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// --- stack catalog (stack-skills mirror) ---
test('STACK_CATALOG: subset of allowlist, disjoint from baseline and optional catalog', () => {
  assert.ok(STACK_SKILLS.length >= 10);
  for (const name of STACK_SKILLS) {
    assert.ok(CURATED_ALLOWLIST.includes(name), `${name} must be allowlisted`);
    assert.ok(!CURATED_BASELINE.includes(name), `${name} must not be in the baseline`);
    assert.ok(!OPTIONAL_CATALOG.includes(name), `${name} must not be in the optional catalog`);
  }
  assert.equal(new Set(STACK_SKILLS).size, STACK_SKILLS.length, 'no duplicate names across stacks');
});

test('vendorDestinations: presence-based per-tool dirs, .claude always first', () => {
  const bare = mkdtempSync(join(tmpdir(), 'vd-'));
  assert.deepEqual(vendorDestinations(bare), ['.claude/skills']);

  const cursor = mkdtempSync(join(tmpdir(), 'vd-'));
  mkdirSync(join(cursor, '.cursor', 'rules'), { recursive: true });
  assert.deepEqual(vendorDestinations(cursor), ['.claude/skills', '.cursor/skills']);

  const cursorLegacy = mkdtempSync(join(tmpdir(), 'vd-'));
  writeFileSync(join(cursorLegacy, '.cursorrules'), 'rules');
  assert.deepEqual(vendorDestinations(cursorLegacy), ['.claude/skills', '.cursor/skills']);

  const agents = mkdtempSync(join(tmpdir(), 'vd-'));
  writeFileSync(join(agents, 'AGENTS.md'), '# agents');
  assert.deepEqual(vendorDestinations(agents), ['.claude/skills', '.agents/skills']);

  const copilotOnly = mkdtempSync(join(tmpdir(), 'vd-'));
  mkdirSync(join(copilotOnly, '.github'), { recursive: true });
  writeFileSync(join(copilotOnly, '.github', 'copilot-instructions.md'), 'x');
  assert.deepEqual(vendorDestinations(copilotOnly), ['.claude/skills']);

  const all = mkdtempSync(join(tmpdir(), 'vd-'));
  mkdirSync(join(all, '.cursor', 'rules'), { recursive: true });
  writeFileSync(join(all, 'AGENTS.md'), '# agents');
  assert.deepEqual(vendorDestinations(all), ['.claude/skills', '.cursor/skills', '.agents/skills']);
});
