// test/clarify.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClarifyPrompt, runPlannerClarify } from '../src/core/phases.mjs';
import { createOrchestrator } from '../src/core/orchestrator.mjs';

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

test('maxClarifyCycles defaults to 3 and is overridable', () => {
  assert.equal(createOrchestrator({}).maxClarifyCycles, 3);
  assert.equal(createOrchestrator({ maxClarifyCycles: 2 }).maxClarifyCycles, 2);
});
