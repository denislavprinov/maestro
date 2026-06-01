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

import { readFileSync as _rf } from 'node:fs';
const indexHtml = _rf(fileURLToPath(new URL('../ui/public/index.html', import.meta.url)), 'utf8');

test('index.html exposes the workflow select + dynamic node/feedback containers', () => {
  assert.ok(indexHtml.includes('id="workflowSelect"'), 'missing #workflowSelect');
  assert.ok(indexHtml.includes('id="wf-default-stages"'), 'missing #wf-default-stages wrapper');
  assert.ok(indexHtml.includes('id="wf-node-config"'), 'missing #wf-node-config container');
  assert.ok(indexHtml.includes('id="wf-feedback-config"'), 'missing #wf-feedback-config container');
  // the original four hardcoded stage rows must remain (Default backward-compat)
  for (const role of ['planner', 'refiner', 'implementer', 'reviewer']) {
    assert.ok(indexHtml.includes(`data-role="${role}"`), `lost default stage row for ${role}`);
  }
});

test('renderModelEffortPair fills a model dropdown (default + models + add) and filters efforts by model', async () => {
  const { window } = await boot();
  const doc = window.document;
  // build a bare pair of selects + caption
  const modelSel = doc.createElement('select');
  const effortSel = doc.createElement('select');
  const caption = doc.createElement('small');
  // seed app state with two models
  window.__np._setModels([
    { id: 'claude-opus-4-8', label: 'Opus 4.8', efforts: ['medium', 'high', 'max'] },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: ['medium', 'high'] },
  ]);
  window.__np.renderModelEffortPair(modelSel, effortSel, caption, { model: 'claude-haiku-4-5', effort: 'high' });
  // model dropdown: '(default model)' + 2 models + '+ Add model…' = 4 options
  assert.equal(modelSel.options.length, 4);
  assert.equal(modelSel.value, 'claude-haiku-4-5');
  // effort dropdown filtered to Haiku's two efforts + the '(default effort)' row
  assert.deepEqual([...effortSel.options].map((o) => o.value), ['', 'medium', 'high']);
  assert.equal(effortSel.value, 'high');
  assert.match(caption.textContent, /Haiku 4\.5 · high/);
});

// A saved workflow served by the mocked API for the selector tests below.
const SAVED_WF = {
  id: 'wf_x', name: 'Demo',
  steps: [
    [{ id: 's0_0', key: 'planner' }],
    [{ id: 's1_0', key: 'implementer' }],
    [{ id: 's2_0', key: 'reviewer' }],
  ],
  feedbacks: [{ id: 'fb_0', from: 's2_0', to: 's1_0' }],
};
const AGENTS = [
  { key: 'planner', displayName: 'Plan', color: 'violet', order: 1 },
  { key: 'implementer', displayName: 'Implement', color: 'peach', order: 3 },
  { key: 'reviewer', displayName: 'Review', color: 'blue', order: 4 },
];
const MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', efforts: ['medium', 'high', 'max'] },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', efforts: ['medium', 'high', 'max'] },
];

function workflowFetch(extraConfig = {}) {
  return (url) => {
    if (url.includes('/api/projects')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [{ name: 'proj', path: PROJECT, exists: true }] }) });
    }
    if (url.includes('/api/workflows/wf_x')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => SAVED_WF });
    }
    if (url.includes('/api/workflows')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ workflows: [{ id: 'wf_default', name: 'Default' }, SAVED_WF] }) });
    }
    if (url.includes('/api/agents')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ agents: AGENTS }) });
    }
    if (url.includes('/api/config')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [], ...extraConfig }, models: MODELS, efforts: ['medium', 'high', 'max'] }) });
    }
    return null;
  };
}

const selectProjectAnd = (window) => {
  const s = window.document.querySelector('#projectSelect');
  s.value = PROJECT; s.dispatchEvent(new window.Event('change', { bubbles: true }));
};
const pickWorkflow = (window, id) => {
  const s = window.document.querySelector('#workflowSelect');
  s.value = id; s.dispatchEvent(new window.Event('change', { bubbles: true }));
};

test('the workflow select is populated with Default + saved names from GET /api/workflows', async () => {
  const { window } = await boot({ fetchHandler: workflowFetch() });
  selectProjectAnd(window);
  await new Promise((r) => setTimeout(r, 0));
  const opts = [...window.document.querySelectorAll('#workflowSelect option')].map((o) => o.textContent);
  assert.deepEqual(opts, ['Default', 'Demo']);
});

test('selecting a saved workflow renders one node row per node (keyed by node id) + one cycle input per feedback', async () => {
  const { window } = await boot({ fetchHandler: workflowFetch() });
  selectProjectAnd(window);
  await new Promise((r) => setTimeout(r, 0));
  pickWorkflow(window, 'wf_x');
  await new Promise((r) => setTimeout(r, 0));
  const doc = window.document;
  // default stages hidden, dynamic containers shown
  assert.ok(doc.querySelector('#wf-default-stages').classList.contains('hidden'));
  assert.ok(!doc.querySelector('#wf-node-config').classList.contains('hidden'));
  // one model select per node, keyed by data-node-id
  const ids = [...doc.querySelectorAll('#wf-node-config .step-model')].map((s) => s.dataset.nodeId);
  assert.deepEqual(ids, ['s0_0', 's1_0', 's2_0']);
  // model dropdown is populated (default + 2 models + add)
  assert.equal(doc.querySelector('#wf-node-config .step-model[data-node-id="s1_0"]').options.length, 4);
  // one cycle input per feedback, keyed by data-fb-id, default 3
  const cyc = doc.querySelector('#wf-feedback-config input[data-fb-id="fb_0"]');
  assert.ok(cyc, 'missing cycle input for fb_0');
  assert.equal(cyc.value, '3');
});

test('selecting Default again restores the original four stage rows and hides the dynamic containers', async () => {
  const { window } = await boot({ fetchHandler: workflowFetch() });
  selectProjectAnd(window);
  await new Promise((r) => setTimeout(r, 0));
  pickWorkflow(window, 'wf_x');
  await new Promise((r) => setTimeout(r, 0));
  pickWorkflow(window, 'wf_default');
  await new Promise((r) => setTimeout(r, 0));
  const doc = window.document;
  assert.ok(!doc.querySelector('#wf-default-stages').classList.contains('hidden'), 'default stages shown');
  assert.ok(doc.querySelector('#wf-node-config').classList.contains('hidden'), 'node config hidden');
  assert.ok(doc.querySelector('#wf-feedback-config').classList.contains('hidden'), 'feedback config hidden');
  // the original four role rows still render their model dropdowns
  assert.equal(doc.querySelector('.step-model[data-role="planner"]').options.length, 4);
});

test('saved run-config preselects a node\'s model+effort when the workflow is opened', async () => {
  const extra = { workflows: { wf_x: { nodes: { s1_0: { model: 'claude-opus-4-8', effort: 'high' } }, feedbacks: { fb_0: { maxCycles: 7 } } } } };
  const { window } = await boot({ fetchHandler: workflowFetch(extra) });
  selectProjectAnd(window);
  await new Promise((r) => setTimeout(r, 0));
  pickWorkflow(window, 'wf_x');
  await new Promise((r) => setTimeout(r, 0));
  const doc = window.document;
  assert.equal(doc.querySelector('#wf-node-config .step-model[data-node-id="s1_0"]').value, 'claude-opus-4-8');
  assert.equal(doc.querySelector('#wf-node-config .step-effort[data-node-id="s1_0"]').value, 'high');
  assert.equal(doc.querySelector('#wf-feedback-config input[data-fb-id="fb_0"]').value, '7');
});
