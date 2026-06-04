// test/config.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readConfig, setStep, addCustomModel, removeCustomModel,
  listModels, resolveStepModels, configFile,
} from '../src/core/config.mjs';
import { AGENT_STEPS } from '../src/core/config.mjs';
import { loadAgentRegistry, registryToSteps } from '../src/core/agent-registry.mjs';

const dirs = [];
async function freshProject() {
  const d = await mkdtemp(join(tmpdir(), 'maestro-proj-'));
  dirs.push(d);
  return d;
}
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

test('missing config yields the empty default', async () => {
  const p = await freshProject();
  assert.deepEqual(await readConfig(p), { steps: {}, customModels: [] });
});

test('setStep persists model + effort to <project>/.maestro/config.json', async () => {
  const p = await freshProject();
  const cfg = await setStep(p, 'planner', { model: 'claude-opus-4-8', effort: 'xhigh' });
  assert.deepEqual(cfg.steps.planner, { model: 'claude-opus-4-8', effort: 'xhigh' });
  const onDisk = JSON.parse(await readFile(configFile(p), 'utf8'));
  assert.equal(onDisk.steps.planner.effort, 'xhigh');
});

test('rejects an effort the model does not support', async () => {
  const p = await freshProject();
  await assert.rejects(
    () => setStep(p, 'reviewer', { model: 'claude-haiku-4-5', effort: 'xhigh' }),
    /does not support/,
  );
});

test('rejects an unknown step key', async () => {
  const p = await freshProject();
  await assert.rejects(() => setStep(p, 'preflight', { model: 'claude-opus-4-8' }), /unknown step/);
});

test('rejects an unknown model', async () => {
  const p = await freshProject();
  await assert.rejects(() => setStep(p, 'planner', { model: 'not-a-real-model' }), /unknown model/);
});

test('custom model becomes selectable, then removable (and clears referencing steps)', async () => {
  const p = await freshProject();
  await addCustomModel(p, { id: 'my-fork-4-9', label: 'My Fork' });
  let models = await listModels(p);
  assert.ok(models.some((m) => m.id === 'my-fork-4-9' && m.custom));

  await setStep(p, 'implementer', { model: 'my-fork-4-9', effort: 'max' });
  const cfg = await removeCustomModel(p, 'my-fork-4-9');
  models = await listModels(p);
  assert.ok(!models.some((m) => m.id === 'my-fork-4-9'));
  assert.equal(cfg.steps.implementer, undefined); // dangling reference removed
});

test('resolveStepModels falls back to the global model when a role is unset', async () => {
  const p = await freshProject();
  await setStep(p, 'refiner', { model: 'claude-sonnet-4-6', effort: 'high' });
  const r = await resolveStepModels(p, 'claude-opus-4-8');
  assert.deepEqual(r.refiner, { model: 'claude-sonnet-4-6', effort: 'high' });
  assert.deepEqual(r.planner, { model: 'claude-opus-4-8', effort: undefined });
});

test('resolveStepModels with no global model leaves model undefined (today\'s behavior)', async () => {
  const p = await freshProject();
  const r = await resolveStepModels(p, undefined);
  assert.deepEqual(r.implementer, { model: undefined, effort: undefined });
});

test('registry surfaces fanOut: planner true (default ON), others false', () => {
  const reg = loadAgentRegistry();
  assert.equal(reg.planner.fanOut, true, 'planner defaults to fan-out ON');
  assert.equal(reg.refiner.fanOut, false);
  assert.equal(reg.implementer.fanOut, false);
  assert.equal(reg.reviewer.fanOut, false);
});

test('registryToSteps / AGENT_STEPS carry the per-agent fanOut default', () => {
  const steps = registryToSteps(loadAgentRegistry());
  const planner = steps.find((s) => s.key === 'planner');
  const refiner = steps.find((s) => s.key === 'refiner');
  assert.equal(planner.fanOut, true);
  assert.equal(refiner.fanOut, false);
  // AGENT_STEPS (config.mjs) is derived from registryToSteps, so it carries it too.
  assert.equal(AGENT_STEPS.find((s) => s.key === 'planner').fanOut, true);
});
