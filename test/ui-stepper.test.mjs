// test/ui-stepper.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));
const PROJECT = '/tmp/proj';

// Copied verbatim from test/ui-duration.test.mjs (the live Running-view harness):
// collects wsInstances and exposes emit/selectProject/showRunning. Task 5 needs
// it; the pure-helper tests below just read ctx.window.__np.
async function bootLive() {
  const wsInstances = [];
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.WebSocket = class {
    constructor() { this.readyState = 1; this._listeners = {}; wsInstances.push(this); }
    send() {} close() {}
    addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
    _fire(type, data) { for (const fn of (this._listeners[type] || [])) fn(data); }
  };
  window.fetch = (url) => {
    if (String(url).includes('/api/projects')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [{ name: 'proj', path: PROJECT, exists: true }] }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(appPath + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  const selectProject = () => { const s = window.document.querySelector('#projectSelect'); s.value = PROJECT; s.dispatchEvent(new window.Event('change', { bubbles: true })); };
  const showRunning = () => { window.location.hash = '#running'; window.dispatchEvent(new window.Event('hashchange')); };
  const emit = (msg) => wsInstances[0]._fire('message', { data: JSON.stringify(msg) });
  const chipText = () => window.document.querySelector('#run-list [data-run-id] .chip').textContent;
  return { window, selectProject, showRunning, emit, chipText };
}

test('buildStepper renders one numbered cell per manifest step with labels', async () => {
  const { window } = await bootLive();
  const host = window.document.createElement('div');
  host.className = 'stages compact';
  const manifest = {
    version: 1,
    steps: [
      { kind: 'preflight', nodes: [{ id: 'preflight', label: 'Preflight', sub: 'checks' }] },
      { kind: 'agents', nodes: [{ id: 's0_0', uiPhase: 'plan', label: 'Plan', color: 'violet', cycles: false }] },
      { kind: 'agents', nodes: [{ id: 's1_0', uiPhase: 'refine', label: 'Refine Plan', color: 'green', cycles: true }] },
      { kind: 'done', nodes: [{ id: 'done', label: 'Done', sub: 'complete' }] },
    ],
  };
  window.__np.buildStepper(host, manifest);
  const cells = host.querySelectorAll('.stage');
  assert.equal(cells.length, 4);
  assert.equal(cells[0].querySelector('.num').textContent, '1');
  assert.equal(cells[1].querySelector('.lbl b').textContent, 'Plan');
  assert.equal(cells[2].querySelector('.lbl b').textContent, 'Refine Plan');
  assert.equal(cells[3].querySelector('.num').textContent, '4');
  assert.ok(host.querySelector('.stage[data-node-id="s0_0"]'));
});

test('buildStepper stacks parallel nodes in one cell sharing a number', async () => {
  const { window } = await bootLive();
  const host = window.document.createElement('div');
  const manifest = {
    version: 1,
    steps: [
      { kind: 'preflight', nodes: [{ id: 'preflight', label: 'Preflight', sub: 'checks' }] },
      { kind: 'agents', nodes: [
        { id: 's1_0', uiPhase: 'implement', label: 'Implementation', color: 'amber', cycles: false },
        { id: 's1_1', uiPhase: 'manual-checklist', label: 'Manual Tests Checklist', color: 'blue', cycles: false },
      ] },
      { kind: 'done', nodes: [{ id: 'done', label: 'Done', sub: 'complete' }] },
    ],
  };
  window.__np.buildStepper(host, manifest);
  const cells = host.querySelectorAll('.stage');
  assert.equal(cells.length, 3);
  const parallel = cells[1];
  assert.ok(parallel.classList.contains('parallel'));
  assert.equal(parallel.querySelectorAll('.pnode').length, 2);
  assert.equal(parallel.querySelector('.num').textContent, '2'); // ONE number for the cell
  assert.ok(parallel.querySelector('.stage-node[data-node-id="s1_0"]'));
  assert.ok(parallel.querySelector('.stage-node[data-node-id="s1_1"]'));
});

test('manifestFor falls back to the legacy default when state has no stepper', async () => {
  const { window } = await bootLive();
  const m = window.__np.manifestFor(undefined);
  assert.equal(m.steps[0].kind, 'preflight');
  assert.equal(m.steps.at(-1).kind, 'done');
  assert.deepEqual(m.steps.map((s) => s.nodes[0].label),
    ['Preflight', 'Plan', 'Refine', 'Implement', 'Review', 'Done']);
});
