// test/composer-ui.test.mjs — pure-helper unit tests for the Pipeline Composer.
// No jsdom / no network: composer-core.mjs is DOM-free by construction, so these
// run as plain ESM under `node --test`. DOM wiring (drag/drop, paintWires SVG,
// link-mode) is verified manually + by `MAESTRO_MOCK=1 npm run smoke`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  topology,
  metaLine,
  distinctAgents,
  defaultTopologyFromTemplate,
  mergePalette,
  EMBEDDED_AGENTS,
} from '../ui/public/composer-core.mjs';

test('topology() reindexes node ids to s{step}_{member} and remaps feedbacks', () => {
  const steps = [
    [{ id: 'n1', key: 'planner' }],
    [{ id: 'n2', key: 'implementer' }, { id: 'n3', key: 'manualTestsChecklist' }],
    [{ id: 'n4', key: 'reviewer' }],
  ];
  const feedbacks = [{ from: 'n4', to: 'n2' }];
  const out = topology(steps, feedbacks);
  assert.deepEqual(
    out.steps,
    [
      [{ id: 's0_0', key: 'planner' }],
      [{ id: 's1_0', key: 'implementer' }, { id: 's1_1', key: 'manualTestsChecklist' }],
      [{ id: 's2_0', key: 'reviewer' }],
    ],
  );
  assert.deepEqual(out.feedbacks, [{ id: 'fb_0', from: 's2_0', to: 's1_0' }]);
});

test('topology() drops a feedback whose endpoint no longer exists', () => {
  const steps = [[{ id: 'a', key: 'planner' }], [{ id: 'b', key: 'reviewer' }]];
  const feedbacks = [{ from: 'b', to: 'a' }, { from: 'b', to: 'ghost' }];
  const out = topology(steps, feedbacks);
  assert.equal(out.feedbacks.length, 1);
  assert.deepEqual(out.feedbacks[0], { id: 'fb_0', from: 's1_0', to: 's0_0' });
});

test('topology() returns empty arrays for an empty canvas', () => {
  assert.deepEqual(topology([], []), { steps: [], feedbacks: [] });
});

test('metaLine() formats "N steps · M agents" with no loops', () => {
  const steps = [[{ id: 's0_0', key: 'planner' }], [{ id: 's1_0', key: 'reviewer' }]];
  assert.equal(metaLine(steps, []), '2 steps · 2 agents');
});

test('metaLine() singularises one feedback loop', () => {
  const steps = [[{ id: 's0_0', key: 'planner' }], [{ id: 's1_0', key: 'reviewer' }]];
  assert.equal(metaLine(steps, [{ id: 'fb_0', from: 's1_0', to: 's0_0' }]), '2 steps · 2 agents · 1 feedback loop');
});

test('metaLine() pluralises multiple feedback loops and counts parallel members as agents', () => {
  const steps = [
    [{ id: 's0_0', key: 'planner' }],
    [{ id: 's1_0', key: 'implementer' }, { id: 's1_1', key: 'manualTestsChecklist' }],
    [{ id: 's2_0', key: 'reviewer' }],
  ];
  const fbs = [{ id: 'fb_0', from: 's2_0', to: 's1_0' }, { id: 'fb_1', from: 's2_0', to: 's0_0' }];
  assert.equal(metaLine(steps, fbs), '3 steps · 4 agents · 2 feedback loops');
});

test('distinctAgents() returns first-seen-ordered unique keys', () => {
  const steps = [
    [{ id: 's0_0', key: 'planner' }],
    [{ id: 's1_0', key: 'implementer' }, { id: 's1_1', key: 'implementer' }],
    [{ id: 's2_0', key: 'reviewer' }],
    [{ id: 's3_0', key: 'planner' }],
  ];
  assert.deepEqual(distinctAgents(steps), ['planner', 'implementer', 'reviewer']);
});
