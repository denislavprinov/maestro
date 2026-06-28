// test/orchestrator-title.test.mjs
// The orchestrator fires a non-blocking LLM title generation right after
// createPipeline and, when it settles, emits a 'title' event carrying the
// pipeline id (the client run model has no pipeline id of its own).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from '../src/core/orchestrator.mjs';
import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after);

const tmpDirs = [];
async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-title-'));
  tmpDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

test('emits a title event with the LLM title after createPipeline', async () => {
  process.env.MAESTRO_MOCK = '1';
  const projectDir = await makeTmpDir();
  const orch = createOrchestrator({ projectDir, prompt: 'Add a settings page with dark mode', auto: true, claude: { mock: true } });
  const seen = [];
  orch.on('title', (p) => seen.push(p));
  await orch.run();
  await orch._titlePromise;                 // ensure the detached kickoff has settled
  assert.equal(seen.length, 1, 'exactly one title event');
  assert.equal(seen[0].provisional, false);
  assert.ok(seen[0].pipelineId, 'payload carries the pipeline id');
  assert.ok(seen[0].title && seen[0].title.length <= 70);
  delete process.env.MAESTRO_MOCK;
});
