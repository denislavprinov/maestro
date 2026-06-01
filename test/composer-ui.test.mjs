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

test('topology() preserves a same-node self-loop (from===to) — the self-cycle toggle', () => {
  const steps = [[{ id: 'n1', key: 'refiner' }]];
  const out = topology(steps, [{ from: 'n1', to: 'n1' }]);
  assert.deepEqual(out.feedbacks, [{ id: 'fb_0', from: 's0_0', to: 's0_0' }]);
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

test('EMBEDDED_AGENTS covers the six canonical keys with color + icon', () => {
  const keys = ['planner', 'refiner', 'implementer', 'reviewer', 'manualTestsChecklist', 'manualWebUiTesting'];
  for (const k of keys) {
    assert.ok(EMBEDDED_AGENTS[k], `missing embedded agent ${k}`);
    assert.equal(typeof EMBEDDED_AGENTS[k].displayName, 'string');
    assert.equal(typeof EMBEDDED_AGENTS[k].color, 'string');
    assert.equal(typeof EMBEDDED_AGENTS[k].icon, 'string');
  }
});

test('mergePalette() falls back to the embedded registry, ordered by .order', () => {
  const pal = mergePalette(null);
  assert.equal(pal.length, 6);
  assert.deepEqual(pal.map((a) => a.key), [
    'planner', 'refiner', 'implementer', 'reviewer', 'manualTestsChecklist', 'manualWebUiTesting',
  ]);
  assert.equal(pal[0].displayName, 'Plan');
});

test('mergePalette() prefers the server agents array and sorts by order', () => {
  const agents = [
    { key: 'reviewer', displayName: 'Review', color: 'blue', icon: '<path/>', order: 4 },
    { key: 'planner', displayName: 'Plan', color: 'violet', icon: '<path/>', order: 1 },
  ];
  const pal = mergePalette({ agents });
  assert.deepEqual(pal.map((a) => a.key), ['planner', 'reviewer']);
  assert.equal(pal[0].color, 'violet');
});

test('defaultTopologyFromTemplate() converts a server template to a canvas model with fresh local ids', () => {
  const tpl = {
    id: 'wf_default',
    name: 'Default',
    steps: [
      [{ id: 's0_0', key: 'planner' }],
      [{ id: 's1_0', key: 'refiner' }],
      [{ id: 's2_0', key: 'implementer' }],
      [{ id: 's3_0', key: 'reviewer' }],
    ],
    feedbacks: [
      { id: 'fb_0', from: 's1_0', to: 's0_0' },
      { id: 'fb_1', from: 's3_0', to: 's2_0' },
    ],
  };
  let n = 0;
  const mk = (key) => ({ id: `L${n++}`, key }); // deterministic local-id factory
  const model = defaultTopologyFromTemplate(tpl, mk);
  assert.deepEqual(model.steps.map((c) => c.map((x) => x.key)),
    [['planner'], ['refiner'], ['implementer'], ['reviewer']]);
  // local ids are fresh (from mk), NOT the server s*_* ids
  assert.equal(model.steps[0][0].id, 'L0');
  assert.equal(model.steps[3][0].id, 'L3');
  // feedbacks reference the fresh local ids (refine->plan, review->implement)
  assert.deepEqual(model.feedbacks, [
    { from: 'L1', to: 'L0' },
    { from: 'L3', to: 'L2' },
  ]);
});

test('defaultTopologyFromTemplate() keeps a same-node self-loop and rewires it to the fresh local id', () => {
  const tpl = {
    id: 'wf_default', name: 'Default',
    steps: [[{ id: 's1_0', key: 'refiner' }]],
    feedbacks: [{ id: 'fb_refine', from: 's1_0', to: 's1_0' }],
  };
  let n = 0;
  const model = defaultTopologyFromTemplate(tpl, (key) => ({ id: `L${n++}`, key }));
  assert.deepEqual(model.feedbacks, [{ from: 'L0', to: 'L0' }]);
});

test('defaultTopologyFromTemplate() tolerates a missing/empty template', () => {
  const model = defaultTopologyFromTemplate(null, (key) => ({ id: 'x', key }));
  assert.deepEqual(model, { steps: [], feedbacks: [] });
});
