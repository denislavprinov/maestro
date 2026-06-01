// test/run-config.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readConfig, setStep, configFile,
  readRunConfig, setNodeModel, setFeedbackCycles, setActiveWorkflow, resolveRunConfig,
} from '../src/core/config.mjs';

const dirs = [];
async function freshProject() {
  const d = await mkdtemp(join(tmpdir(), 'maestro-proj-'));
  dirs.push(d);
  return d;
}
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

test('readRunConfig on a fresh project returns empty workflows and no active id', async () => {
  const p = await freshProject();
  const rc = await readRunConfig(p);
  assert.deepEqual(rc.workflows, {});
  assert.equal(rc.activeWorkflowId, undefined);
  // Legacy keys still present and empty.
  assert.deepEqual(rc.steps, {});
  assert.deepEqual(rc.customModels, []);
});

test('setNodeModel persists model+effort keyed by workflowId -> nodeId', async () => {
  const p = await freshProject();
  await setNodeModel(p, 'wf_quickfix', 's1_0', { model: 'claude-opus-4-8', effort: 'high' });
  const rc = await readRunConfig(p);
  assert.deepEqual(rc.workflows.wf_quickfix.nodes.s1_0, { model: 'claude-opus-4-8', effort: 'high' });
  // Written to the SAME file as legacy config.
  const onDisk = JSON.parse(await readFile(configFile(p), 'utf8'));
  assert.equal(onDisk.workflows.wf_quickfix.nodes.s1_0.effort, 'high');
});

test('setFeedbackCycles persists maxCycles keyed by workflowId -> fbId', async () => {
  const p = await freshProject();
  await setFeedbackCycles(p, 'wf_quickfix', 'fb_0', 4);
  const rc = await readRunConfig(p);
  assert.deepEqual(rc.workflows.wf_quickfix.feedbacks.fb_0, { maxCycles: 4 });
});

test('setActiveWorkflow records the last-selected workflow id', async () => {
  const p = await freshProject();
  await setActiveWorkflow(p, 'wf_quickfix');
  assert.equal((await readRunConfig(p)).activeWorkflowId, 'wf_quickfix');
});

test('run-config writes do NOT clobber legacy steps/customModels', async () => {
  const p = await freshProject();
  await setStep(p, 'planner', { model: 'claude-opus-4-8', effort: 'xhigh' });
  await setNodeModel(p, 'wf_x', 's0_0', { model: 'claude-sonnet-4-6', effort: 'high' });
  const cfg = await readConfig(p); // legacy reader is unchanged
  assert.deepEqual(cfg.steps.planner, { model: 'claude-opus-4-8', effort: 'xhigh' });
  const rc = await readRunConfig(p);
  assert.deepEqual(rc.steps.planner, { model: 'claude-opus-4-8', effort: 'xhigh' });
  assert.equal(rc.workflows.wf_x.nodes.s0_0.model, 'claude-sonnet-4-6');
});

test('resolveRunConfig returns the per-workflow nodes+feedbacks maps', async () => {
  const p = await freshProject();
  await setNodeModel(p, 'wf_x', 's0_0', { model: 'claude-opus-4-8', effort: 'max' });
  await setFeedbackCycles(p, 'wf_x', 'fb_0', 2);
  const resolved = await resolveRunConfig(p, 'wf_x');
  assert.deepEqual(resolved.nodes.s0_0, { model: 'claude-opus-4-8', effort: 'max' });
  assert.deepEqual(resolved.feedbacks.fb_0, { maxCycles: 2 });
});

test('resolveRunConfig for an unconfigured workflow yields empty maps', async () => {
  const p = await freshProject();
  const resolved = await resolveRunConfig(p, 'wf_never');
  assert.deepEqual(resolved, { nodes: {}, feedbacks: {} });
});

test('setNodeModel clears a node when model and effort are both blank', async () => {
  const p = await freshProject();
  await setNodeModel(p, 'wf_x', 's0_0', { model: 'claude-opus-4-8', effort: 'high' });
  await setNodeModel(p, 'wf_x', 's0_0', { model: '', effort: '' });
  const rc = await readRunConfig(p);
  assert.equal(rc.workflows.wf_x?.nodes?.s0_0, undefined);
});

test('setFeedbackCycles coerces to an integer >= 1 (spec §6.6 maxCycles rule)', async () => {
  const p = await freshProject();
  const cyc = async (v) => {
    await setFeedbackCycles(p, 'wf_x', 'fb_0', v);
    return (await readRunConfig(p)).workflows.wf_x.feedbacks.fb_0.maxCycles;
  };
  assert.equal(await cyc(0), 1, '0 -> 1');
  assert.equal(await cyc(-3), 1, 'negative -> 1');
  assert.equal(await cyc(2.7), 2, 'non-integer floored');
  assert.equal(await cyc(5), 5, 'a valid count is kept');
});

test('a legacy setStep does NOT wipe the run-config layer or webUiTesting (integrity)', async () => {
  const p = await mkdtemp(join(tmpdir(), 'maestro-rcint-'));
  await setNodeModel(p, 'wf_x', 's1_0', { model: 'claude-opus-4-8', effort: 'high' });
  const file = join(p, '.maestro', 'config.json');
  const whole = JSON.parse(await readFile(file, 'utf8'));
  whole.webUiTesting = { startCommand: 'npm run dev', baseUrl: 'http://localhost:5173' };
  await writeFile(file, JSON.stringify(whole), 'utf8');
  await setStep(p, 'reviewer', { model: 'claude-sonnet-4-6', effort: 'high' }); // LEGACY write

  const rc = await readRunConfig(p);
  assert.deepEqual(rc.workflows.wf_x.nodes.s1_0, { model: 'claude-opus-4-8', effort: 'high' }, 'run-config survived setStep');
  assert.equal(rc.webUiTesting.startCommand, 'npm run dev', 'webUiTesting survived setStep + is surfaced by readRunConfig');
  assert.deepEqual(rc.steps.reviewer, { model: 'claude-sonnet-4-6', effort: 'high' }, 'the legacy step itself was written');
});
