// resumeOnboarding: validation guards + full mock pause->resume e2e over wf_enable.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { useTempHome } from './helpers/temp-home.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';
import { runOnboarding, resumeOnboarding, ENABLE_TITLE } from '../src/core/onboarding.mjs';
import { readPipelineForResume } from '../src/core/artifacts.mjs';

useTempHome(after);

const RP = (dir) => ({ version: 1, kind: 'boundary', stepIndex: 0, stepCycle: [], loopState: {},
  bus: null, stepModels: null, workflowId: 'wf_enable', plan: null, nodes: [], gate: null,
  pipelineDir: dir, pausedAt: '2026-07-10T00:00:00Z' });

test('resumeOnboarding: unknown pipeline id -> NOT_FOUND', async () => {
  await assert.rejects(resumeOnboarding({ pipelineId: 'nope1234' }),
    (e) => e.code === 'NOT_FOUND' && /not found/i.test(e.message));
});

test('resumeOnboarding: refuses non-Enable pipelines', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'maestro-or-'));
  const { id } = await seedPipeline(proj, { title: 'some other run', status: 'paused', resumePoint: RP(proj) });
  await assert.rejects(resumeOnboarding({ pipelineId: id }), /not an Enable run/i);
});

test('resumeOnboarding: refuses non-resumable status', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'maestro-or-'));
  const { id } = await seedPipeline(proj, { title: ENABLE_TITLE, status: 'done' });
  await assert.rejects(resumeOnboarding({ pipelineId: id }), /not resumable/i);
});

test('resumeOnboarding: refuses when the resume point is missing', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'maestro-or-'));
  const { id } = await seedPipeline(proj, { title: ENABLE_TITLE, status: 'paused' });
  await assert.rejects(resumeOnboarding({ pipelineId: id }), /no resume point/i);
});

test('resumeOnboarding: refuses when the worktree is gone', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'maestro-or-'));
  const goneWt = await mkdtemp(join(tmpdir(), 'maestro-or-wt-'));
  await rm(goneWt, { recursive: true, force: true });
  const { id } = await seedPipeline(proj, { title: ENABLE_TITLE, status: 'paused',
    branch: { source: 'main', feature: 'f', worktreeDir: goneWt, reusedExisting: false },
    resumePoint: RP(proj) });
  await assert.rejects(resumeOnboarding({ pipelineId: id }), /worktree missing/i);
});

test('mock Enable run pauses and resumeOnboarding drives it to done', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-or-e2e-'));
  execSync('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: dir });

  const fresh = await runOnboarding({ projectDir: dir, answers: { canary: 'no' }, mock: true });
  // pause right after the FIRST node completes (same idiom as pause-resume-e2e).
  let pausedOnce = false;
  fresh.orch.on('phase', ({ status, nodeId }) => {
    if (!pausedOnce && status === 'done' && nodeId && fresh.orch.state.status === 'running') {
      pausedOnce = true;
      fresh.orch.pause();
    }
  });
  const r1 = await fresh.done;
  assert.equal(r1.status, 'paused');
  const pipelineId = fresh.orch.getState().id;
  assert.ok(readPipelineForResume(pipelineId).resumePoint, 'resume point persisted');

  const resumed = await resumeOnboarding({ pipelineId, mock: true });
  assert.equal(resumed.pipelineId, pipelineId);
  const readiness = [];
  resumed.events.on('readiness', (r) => readiness.push(r));
  const r2 = await resumed.done;
  assert.equal(r2.status, 'done');
  assert.equal(readPipelineForResume(pipelineId).row.status, 'done');
  assert.ok(readiness.some((r) => r.kind === 'final'), 'final readiness emitted on the resumed lifetime');
});
