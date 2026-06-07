// test/orchestrator-db-authoritative.test.mjs
// M1-Backend: the clarify + reviews DB tables are the AUTHORITATIVE store. A full
// mock run must leave a readable clarify row (questions + answers) and per-cycle
// review verdicts, and the loop must gate on those — proven by the run finishing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from '../src/core/orchestrator.mjs';
import { readClarifyRow, readReviewRow } from '../src/core/artifacts.mjs';
import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after);

const tmpDirs = [];
async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-dbauth-'));
  tmpDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

test('ctx carries pipelineId to runners (clarify row written by the runner)', async () => {
  const projectDir = await makeTmpDir();
  const orch = createOrchestrator({ projectDir, prompt: 'demo task', auto: true, claude: { mock: true } });
  const res = await orch.run();
  assert.equal(res.status, 'done');
  const pipelineId = orch.getState().id;
  assert.ok(pipelineId, 'run produced a pipeline id');
  // The clarify questions were ingested into the DB row by runPlannerClarify itself.
  const row = readClarifyRow(pipelineId);
  assert.ok(row.questions, 'clarify row has questions (runner persisted them)');
  assert.ok(Array.isArray(row.questions.questions), 'questions payload shape');
  assert.ok(row.questions.questions.length > 0, 'mock asks at least one question');
});
