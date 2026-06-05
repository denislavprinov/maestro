// test/clarify.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClarifyPrompt, runPlannerClarify } from '../src/core/phases.mjs';
import { createOrchestrator } from '../src/core/orchestrator.mjs';
import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after); // store writes -> isolated temp home, not real ~/.maestro

const tmpDirs = [];
async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-clarify-'));
  tmpDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

function fakeCtx(dir) {
  return {
    projectDir: dir,
    pipelineDir: dir,
    taskPrompt: 'demo task',
    toolInstruction: '',
    agentPrompts: { planner: '' },
    claudeOpts: { mock: true },
    signal: undefined,
    onEvent: () => {},
  };
}

test('buildClarifyPrompt re-injects prior answers and forbids re-asking', () => {
  const prompt = buildClarifyPrompt(fakeCtx('/p'), {
    round: 2,
    priorAnswers: [{ id: 'sess', question: 'Where to store sessions?', choice: 'Redis' }],
  });
  assert.match(prompt, /DO NOT ask these again/);
  assert.match(prompt, /Where to store sessions\?/);
  assert.match(prompt, /Redis/);
  assert.match(prompt, /MOCK_PRIOR: 1/);
});

test('buildClarifyPrompt omits the answered section on the first round', () => {
  const prompt = buildClarifyPrompt(fakeCtx('/p'), { round: 1, priorAnswers: [] });
  assert.doesNotMatch(prompt, /DO NOT ask these again/);
  assert.match(prompt, /MOCK_PRIOR: 0/);
});

test('clarify converges once answers are fed back (mock)', async () => {
  const ctx = fakeCtx(await makeTmpDir());
  const r1 = await runPlannerClarify(ctx, { round: 1, priorAnswers: [] });
  assert.ok(r1.questions.length > 0, 'round 1 asks at least one question');
  const r2 = await runPlannerClarify(ctx, {
    round: 2,
    priorAnswers: [{ id: 'q1', question: 'How handle invalid input?', choice: 'Fail fast' }],
  });
  assert.equal(r2.questions.length, 0, 'round 2 with answers asks nothing');
});

test('orchestrator no longer exposes a clarify round cap', () => {
  const orch = createOrchestrator({});
  assert.equal(orch.maxClarifyCycles, undefined, 'maxClarifyCycles field should be gone');
});

test('clarify runs exactly one round (no clarify phase past cycle 1)', async () => {
  const projectDir = await makeTmpDir();
  const orch = createOrchestrator({
    projectDir,
    prompt: 'demo task',
    auto: true,
    claude: { mock: true },
  });
  const clarifyCycles = [];
  let clarifyQuestions = 0;
  orch.on('phase', ({ phase, cycle }) => {
    if (phase === 'clarify') clarifyCycles.push(cycle);
  });
  // In mock mode the planner always returns questions on the first call
  // (MOCK_PRIOR === 0), so a single clarify round must fire this exactly once.
  orch.on('question', ({ kind }) => {
    if (kind === 'clarify') clarifyQuestions += 1;
  });
  const res = await orch.run();
  assert.equal(res.status, 'done', 'mock pipeline should finish');
  assert.ok(clarifyCycles.length > 0, 'clarify phase should run');
  assert.ok(
    clarifyCycles.every((c) => c === 1),
    `clarify must stay on cycle 1, saw cycles ${clarifyCycles.join(',')}`,
  );
  assert.equal(clarifyQuestions, 1, 'clarify must be asked exactly once');
});

import { normalizeClarify } from '../src/core/protocol.mjs';

test('normalizeClarify caps questions at MAX_CLARIFY_QUESTIONS (4)', () => {
  const many = {
    questions: Array.from({ length: 9 }, (_, i) => ({
      id: `q${i}`,
      question: `Question ${i}?`,
      options: ['a', 'b', 'c'],
    })),
  };
  const out = normalizeClarify(many);
  assert.equal(out.questions.length, 4);
});

import { spawnSync } from 'node:child_process';

test('CLI no longer advertises --max-clarify in help', () => {
  const r = spawnSync(process.execPath, ['src/cli/maestro.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /--max-clarify/);
});
