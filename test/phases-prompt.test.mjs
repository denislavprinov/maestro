import test from 'node:test';
import assert from 'node:assert/strict';
import { taskHeader } from '../src/core/phases.mjs'; // now exported

const base = { projectDir: '/p', pipelineDir: '/pipe', taskPrompt: 'BUILD THE THING' };

test('userPrompt consumer gets the raw request block', () => {
  const h = taskHeader({ ...base, node: { key: 'planner' }, inputs: { userPrompt: { text: 'BUILD THE THING' } } }, 'Plan');
  assert.match(h, /## Original request/);
  assert.match(h, /BUILD THE THING/);
});

test('refiner & reviewer keep the request block even though they do not consume userPrompt', () => {
  for (const key of ['refiner', 'reviewer']) {
    const h = taskHeader({ ...base, node: { key }, inputs: { plan: { path: '/x.md' } } }, key);
    assert.match(h, /## Original request/, `${key} keeps request`);
  }
});

test('implementer/checklist/web-ui omit the request block', () => {
  for (const key of ['implementer', 'manualTestsChecklist', 'manualWebUiTesting']) {
    const h = taskHeader({ ...base, node: { key }, inputs: { plan: { path: '/x.md' } } }, key);
    assert.doesNotMatch(h, /## Original request/, `${key} omits request`);
    assert.match(h, /## Upstream input/);
    assert.doesNotMatch(h, /BUILD THE THING/, `${key} must not leak the prompt`);
  }
});

test('clarify pre-step (no inputs) still gets the prompt', () => {
  const h = taskHeader({ ...base }, 'Clarify'); // ctx.inputs === undefined, ctx.node === undefined
  assert.match(h, /## Original request/);
});
