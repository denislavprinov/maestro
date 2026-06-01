// test/newpipeline-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));
const PROJECT = '/tmp/proj';

// Boot app.js in jsdom with a controllable fetch. Mirrors test/ui-cost.test.mjs.
async function boot({ fetchHandler } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4319/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.WebSocket = class {
    constructor() { this.readyState = 1; this._listeners = {}; }
    send() {} close() {}
    addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  };
  window.fetch = (url, opts) => {
    if (fetchHandler) { const r = fetchHandler(String(url), opts || {}); if (r) return r; }
    if (String(url).includes('/api/projects')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [{ name: 'proj', path: PROJECT, exists: true }] }) });
    }
    if (String(url).includes('/api/workflows')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ workflows: [] }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(appPath + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  return { window };
}

// A two-step workflow with one parallel member and one feedback loop.
const WF = {
  id: 'wf_x', name: 'Demo',
  steps: [
    [{ id: 's0_0', key: 'planner' }],
    [{ id: 's1_0', key: 'implementer' }, { id: 's1_1', key: 'manualTestsChecklist' }],
    [{ id: 's2_0', key: 'reviewer' }],
  ],
  feedbacks: [{ id: 'fb_0', from: 's2_0', to: 's1_0' }],
};
const REGISTRY = {
  planner: { key: 'planner', displayName: 'Plan', color: 'violet', order: 1 },
  implementer: { key: 'implementer', displayName: 'Implement', color: 'peach', order: 3 },
  manualTestsChecklist: { key: 'manualTestsChecklist', displayName: 'Manual Tests Checklist', color: 'blue', order: 5 },
  reviewer: { key: 'reviewer', displayName: 'Review', color: 'blue', order: 4 },
};

test('buildNodeConfigRows flattens steps in order, keyed by nodeId, with registry label+color', async () => {
  const { window } = await boot();
  const rows = window.__np.buildNodeConfigRows(WF, REGISTRY, { nodes: {}, feedbacks: {} });
  assert.deepEqual(rows.map((r) => r.nodeId), ['s0_0', 's1_0', 's1_1', 's2_0']);
  assert.deepEqual(rows.map((r) => r.key), ['planner', 'implementer', 'manualTestsChecklist', 'reviewer']);
  assert.deepEqual(rows.map((r) => r.label), ['Plan', 'Implement', 'Manual Tests Checklist', 'Review']);
  assert.deepEqual(rows.map((r) => r.color), ['violet', 'peach', 'blue', 'blue']); // C5: manualTestsChecklist is blue (two blue pills: checklist + reviewer)
  // step indices preserved (used for the "Step N · parallel" hint)
  assert.deepEqual(rows.map((r) => r.stepIndex), [0, 1, 1, 2]);
  // no run-config => empty model/effort
  assert.deepEqual(rows.map((r) => r.model), ['', '', '', '']);
  assert.deepEqual(rows.map((r) => r.effort), ['', '', '', '']);
});

test('buildNodeConfigRows overlays saved run-config model/effort per nodeId', async () => {
  const { window } = await boot();
  const rc = { nodes: { s1_0: { model: 'claude-opus-4-8', effort: 'high' }, s2_0: { model: 'claude-sonnet-4-6' } }, feedbacks: {} };
  const rows = window.__np.buildNodeConfigRows(WF, REGISTRY, rc);
  const byId = Object.fromEntries(rows.map((r) => [r.nodeId, r]));
  assert.equal(byId.s1_0.model, 'claude-opus-4-8');
  assert.equal(byId.s1_0.effort, 'high');
  assert.equal(byId.s2_0.model, 'claude-sonnet-4-6');
  assert.equal(byId.s2_0.effort, '');      // absent in run-config -> ''
  assert.equal(byId.s0_0.model, '');        // untouched node
});

test('buildNodeConfigRows tolerates a key missing from the registry (falls back to the key as label, no color)', async () => {
  const { window } = await boot();
  const wf = { id: 'w', steps: [[{ id: 'n0', key: 'ghost' }]], feedbacks: [] };
  const rows = window.__np.buildNodeConfigRows(wf, REGISTRY, { nodes: {}, feedbacks: {} });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'ghost');
  assert.equal(rows[0].color, '');
});

test('buildNodeConfigRows on the Default 4-step topology yields the original four rows in order', async () => {
  const { window } = await boot();
  const def = {
    id: 'wf_default', name: 'Default',
    steps: [
      [{ id: 's0_0', key: 'planner' }],
      [{ id: 's1_0', key: 'refiner' }],
      [{ id: 's2_0', key: 'implementer' }],
      [{ id: 's3_0', key: 'reviewer' }],
    ],
    feedbacks: [],
  };
  const reg = { ...REGISTRY, refiner: { key: 'refiner', displayName: 'Refine', color: 'green', order: 2 } };
  const rows = window.__np.buildNodeConfigRows(def, reg, { nodes: {}, feedbacks: {} });
  assert.deepEqual(rows.map((r) => r.key), ['planner', 'refiner', 'implementer', 'reviewer']);
  assert.deepEqual(rows.map((r) => r.label), ['Plan', 'Refine', 'Implement', 'Review']);
});
