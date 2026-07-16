import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STACK_SKILLS } from '../src/core/skill-vendor.mjs';
import { resolveSkill } from '../src/core/skills.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('every STACK_CATALOG skill is mirrored: bundle-resolvable with SKILL.md, ATTRIBUTION.md, LICENSE', () => {
  for (const name of STACK_SKILLS) {
    const r = resolveSkill(name, { repoRoot, projectDir: repoRoot, homeDir: '/nonexistent-home' });
    assert.equal(r.source, 'bundle', `${name} must resolve from the repo bundle`);
    for (const f of ['SKILL.md', 'ATTRIBUTION.md', 'LICENSE']) {
      assert.ok(existsSync(join(r.path, f)), `${name}/${f} missing`);
    }
    const attribution = readFileSync(join(r.path, 'ATTRIBUTION.md'), 'utf8');
    assert.match(attribution, /https:\/\/github\.com\//, `${name} attribution names the upstream repo`);
    assert.match(attribution, /[0-9a-f]{40}/, `${name} attribution pins a full commit SHA`);
    const skill = readFileSync(join(r.path, 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\n[\s\S]*?\bname:/m, `${name} SKILL.md has frontmatter with a name`);
  }
});

test('mirrored skills contain no executable payloads', () => {
  for (const name of STACK_SKILLS) {
    const r = resolveSkill(name, { repoRoot, projectDir: repoRoot, homeDir: '/nonexistent-home' });
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else assert.ok(/\.(md|txt|json|ya?ml|toml|java|kt|swift|ts|tsx|js|py|xml|gradle|properties|sql|sh)$|^LICENSE$/.test(e.name),
          `${name}: unexpected file type ${p}`);
      }
    };
    walk(r.path);
  }
});
