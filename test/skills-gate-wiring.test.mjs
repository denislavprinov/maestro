// test/skills-gate-wiring.test.mjs
// Proves the orchestrator's gate composition (collect -> validate) throws loudly
// on a missing skill, using the same calls run() makes, without spawning claude.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRequiredSkills, validateSkills } from '../src/core/skills.mjs';

const dirs = [];
const tmp = async () => { const d = await mkdtemp(join(tmpdir(), 'maestro-gate-')); dirs.push(d); return d; };
after(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

test('gate: a plan whose agent requires a missing skill throws before any node', async () => {
  const registry = { artDirector: { requiresSkills: ['imagegen'] } };
  const plan = { steps: [[{ key: 'artDirector' }]] };
  const required = collectRequiredSkills(registry, plan);
  assert.deepEqual(required, [{ skill: 'imagegen', requiredBy: ['artDirector'] }]);
  // repoRoot/projectDir/homeDir all empty => unresolvable => throw
  const ctx = { repoRoot: await tmp(), projectDir: await tmp(), homeDir: await tmp() };
  assert.throws(() => validateSkills(required, ctx), /imagegen/);
});

test('gate: a plan that requires no skills produces an empty set (no gate, no inject)', () => {
  const registry = { planner: {}, implementer: {} };
  const plan = { steps: [[{ key: 'planner' }], [{ key: 'implementer' }]] };
  assert.deepEqual(collectRequiredSkills(registry, plan), []);
});
