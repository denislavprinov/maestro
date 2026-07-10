// hasResumePoint on history entries: true iff the pipelines row carries a
// resume_point. Backs the Enable UI's `resumable` flag.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';
import { listAllPipelines, listPipelines } from '../src/core/artifacts.mjs';

useTempHome(after);

test('listAllPipelines + listPipelines expose hasResumePoint', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'maestro-hrp-'));
  const { id: pausedId } = await seedPipeline(proj, {
    title: 'paused run', status: 'paused',
    resumePoint: { version: 1, kind: 'boundary', stepIndex: 0, stepCycle: [], loopState: {},
      bus: null, stepModels: null, workflowId: 'wf_default', plan: null, nodes: [], gate: null,
      pipelineDir: proj, pausedAt: '2026-07-10T00:00:00Z' },
  });
  const { id: doneId } = await seedPipeline(proj, { title: 'done run', status: 'done' });

  const all = await listAllPipelines();
  assert.equal(all.find((p) => p.id === pausedId).hasResumePoint, true);
  assert.equal(all.find((p) => p.id === doneId).hasResumePoint, false);

  const perProject = await listPipelines(proj);
  assert.equal(perProject.find((p) => p.id === pausedId).hasResumePoint, true);
  assert.equal(perProject.find((p) => p.id === doneId).hasResumePoint, false);
});
