import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { useTempHome } from './helpers/temp-home.mjs';
import {
  runOnboarding, ENABLE_WORKFLOW_ID, ENABLE_QUESTION_IDS,
  joinMultiToolTargets, readBaselineReadiness, readCycleScore, readFinalReadiness,
} from '../src/core/onboarding.mjs';
import { readWorkflow } from '../src/core/workflows.mjs';

useTempHome(after);

function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'enable-e2e-'));
  execSync('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: dir });
  return dir;
}
const ANSWERS = { testTier: 'scaffold', vendoringDepth: 'full',
  multiToolTargets: ['cursor', 'copilot'], canary: 'yes', scopeConstraints: '' };

// 1. seeded + pinned + idempotent
test('runOnboarding seeds wf_enable idempotently and pins the run to it', async () => {
  const { done } = await runOnboarding({ projectDir: freshRepo(), answers: ANSWERS, mock: true });
  const result = await done;
  assert.equal(result.status, 'done', JSON.stringify(result));
  const wf = await readWorkflow(ENABLE_WORKFLOW_ID);
  assert.ok(wf && wf.id === ENABLE_WORKFLOW_ID);
  // second run does not throw (upsert)
  const again = await runOnboarding({ projectDir: freshRepo(), answers: ANSWERS, mock: true });
  assert.equal((await again.done).status, 'done');
});

// 2. drift guard — prompt embeds EXACTLY the 5 fixed ids in its first json block
test('enableClarifier prompt declares exactly the 5 fixed question ids', () => {
  const md = readFileSync(fileURLToPath(new URL('../agents/maestro-enable-clarifier.md', import.meta.url)), 'utf8');
  const block = md.match(/```json\s*([\s\S]*?)```/);
  assert.ok(block, 'prompt must embed a json question block');
  const ids = JSON.parse(block[1]).questions.map((q) => q.id);
  assert.deepEqual(ids, [...ENABLE_QUESTION_IDS]);
});

// 3. multiToolTargets multi-select -> joined free-text file list (Claude locked, deduped)
test('joinMultiToolTargets maps labels to files, Claude locked', () => {
  assert.equal(joinMultiToolTargets(['cursor', 'copilot']),
    'CLAUDE.md, .cursor/rules, .github/copilot-instructions.md');
  assert.equal(joinMultiToolTargets('AGENTS.md, .cursor/rules'), 'AGENTS.md, .cursor/rules');
  assert.equal(joinMultiToolTargets(['claude', 'cursor']), 'CLAUDE.md, .cursor/rules'); // no dup CLAUDE.md
});

// 4a. readiness readers — exact shape + 9 keys (fixture pipelineDir; mock can't make these)
test('readiness readers return exact shapes from a fixture pipelineDir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'enable-fix-'));
  const dims = { docs: 40, skillsAgents: 0, rules: 10, tests: 0, featureSkillCoverage: 0,
    realTests: 0, vendoring: 0, multiTool: 20, codeHealth: 70 };
  writeFileSync(join(dir, 'graph-summary.json'), JSON.stringify({ baselineReadiness: { score: 28, dimensions: dims } }));
  writeFileSync(join(dir, 'onboardingEvaluator-review-cycle1.json'), JSON.stringify({ issues: [], summary: 'ok', score: 61 }));
  writeFileSync(join(dir, 'readiness.json'), JSON.stringify({ score: 93, baselineScore: 28, delta: 65, dimensions: dims, gaps: ['x'] }));
  assert.equal(readBaselineReadiness(dir).score, 28);
  assert.equal(readCycleScore(dir, 1), 61);
  const f = readFinalReadiness(dir);
  assert.equal(f.score, 93); assert.equal(f.delta, 65);
  assert.deepEqual(Object.keys(f.dimensions).sort(),
    ['codeHealth','docs','featureSkillCoverage','multiTool','realTests','rules','skillsAgents','tests','vendoring']);
});

// 4b. readiness events fire (kinds) during a mock run — fields may be null under mock
test('readiness events fire: baseline, >=1 cycle, final', async () => {
  const { events, done } = await runOnboarding({ projectDir: freshRepo(), answers: ANSWERS, mock: true });
  const kinds = [];
  events.on('readiness', (r) => kinds.push(r.kind));
  await done;
  assert.ok(kinds.includes('baseline'));
  assert.ok(kinds.includes('cycle'));
  assert.ok(kinds.includes('final'));
});

// 5. done resolves {status, branch, readiness}; branch matches the Enable slug.
//    A supplied title is slugified VERBATIM — the title path never strips
//    stopwords (worktree.mjs:91-94), so "for" is kept: enable-project-for-ai.
//    pipeline.id is 8 lowercase hex (artifacts.mjs shortId) and suggestBranchName
//    slices it -> maestro/enable-project-for-ai-<8hex>.
test('done resolves a summary with the Enable branch', async () => {
  const { done } = await runOnboarding({ projectDir: freshRepo(), answers: ANSWERS, mock: true });
  const r = await done;
  assert.equal(r.status, 'done');
  assert.match(r.branch, /^maestro\/enable-project-for-ai-[0-9a-f]{8}$/); // title verbatim; id is 8 hex
  assert.ok('readiness' in r);
});

// 6. omitted/unknown clarify ids -> engine default, no throw
test('empty answers complete without throwing (engine fills defaults)', async () => {
  const { done } = await runOnboarding({ projectDir: freshRepo(), answers: {}, mock: true });
  assert.equal((await done).status, 'done');
});
