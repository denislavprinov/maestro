// test/skills-inject.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSkills, injectSkills } from '../src/core/skills.mjs';

const dirs = [];
const tmp = async () => { const d = await mkdtemp(join(tmpdir(), 'maestro-inject-')); dirs.push(d); return d; };
after(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

test('injectSkills copies a bundle skill into each worktree .claude/skills (creating parents)', async () => {
  const repoRoot = await tmp();
  const projectDir = await tmp();
  // seed bundle: repoRoot/skills/imagegen/{SKILL.md,scripts/generate_image.py}
  await mkdir(join(repoRoot, 'skills', 'imagegen', 'scripts'), { recursive: true });
  await writeFile(join(repoRoot, 'skills', 'imagegen', 'SKILL.md'), '# imagegen\n');
  await writeFile(join(repoRoot, 'skills', 'imagegen', 'scripts', 'generate_image.py'), 'print("x")\n');

  const wtA = await tmp(); // fresh dirs with NO .claude/ — cp recursive must create it
  const wtB = await tmp();
  const resolved = validateSkills(
    [{ skill: 'imagegen', requiredBy: ['artDirector'] }],
    { repoRoot, projectDir, homeDir: await tmp() },
  );
  const injected = await injectSkills(resolved, { worktrees: [wtA, wtB] });

  assert.deepEqual(injected, ['imagegen']);
  for (const wt of [wtA, wtB]) {
    await assert.doesNotReject(access(join(wt, '.claude', 'skills', 'imagegen', 'SKILL.md')));
    await assert.doesNotReject(access(join(wt, '.claude', 'skills', 'imagegen', 'scripts', 'generate_image.py')));
  }
});

test('injectSkills skips global/project sources (nothing to copy)', async () => {
  const repoRoot = await tmp();
  const projectDir = await tmp();
  const homeDir = await tmp();
  // seed ONLY a global skill
  await mkdir(join(homeDir, '.claude', 'skills', 'imagegen'), { recursive: true });
  await writeFile(join(homeDir, '.claude', 'skills', 'imagegen', 'SKILL.md'), '# imagegen\n');
  const resolved = validateSkills([{ skill: 'imagegen', requiredBy: ['artDirector'] }], { repoRoot, projectDir, homeDir });
  const wt = await tmp();
  const injected = await injectSkills(resolved, { worktrees: [wt] });
  assert.deepEqual(injected, []); // global already on scan path
  await assert.rejects(access(join(wt, '.claude', 'skills', 'imagegen'))); // nothing copied
});

test('injectSkills copies a plugin-cache skill into the worktree (not on the scan path)', async () => {
  const repoRoot = await tmp();
  const projectDir = await tmp();
  const homeDir = await tmp();
  // seed ONLY a plugin-cache skill
  const pluginSkill = join(homeDir, '.claude', 'plugins', 'cache', 'mp', 'caveman', 'v1', 'skills', 'caveman');
  await mkdir(pluginSkill, { recursive: true });
  await writeFile(join(pluginSkill, 'SKILL.md'), '# caveman\n');
  const resolved = validateSkills([{ skill: 'caveman', requiredBy: ['x'] }], { repoRoot, projectDir, homeDir });
  assert.equal(resolved.get('caveman').source, 'plugin');
  const wt = await tmp();
  const injected = await injectSkills(resolved, { worktrees: [wt] });
  assert.deepEqual(injected, ['caveman']);
  await assert.doesNotReject(access(join(wt, '.claude', 'skills', 'caveman', 'SKILL.md')));
});
