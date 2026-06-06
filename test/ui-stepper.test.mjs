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

test('buildStepper renders per-node model·effort from the manifest into .me', async () => {
  const { window } = await bootLive();
  window.__np._setModels([{ id: 'opus', label: 'Opus 4.8', efforts: ['low', 'high'] }]);
  const host = window.document.createElement('div');
  host.className = 'stages compact';
  const manifest = {
    version: 1,
    steps: [
      { kind: 'preflight', nodes: [{ id: 'preflight', label: 'Preflight', sub: 'checks' }] },
      { kind: 'agents', nodes: [{ id: 's0_0', uiPhase: 'plan', label: 'Plan', color: 'violet',
                                  sub: 'architecture & breakdown', model: 'opus', effort: 'high', cycles: false }] },
      { kind: 'agents', nodes: [{ id: 's1_0', uiPhase: 'refine', label: 'Refine Plan', color: 'green',
                                  sub: 'tighten the plan', model: '', effort: '', cycles: true }] },
      { kind: 'done', nodes: [{ id: 'done', label: 'Done', sub: 'complete' }] },
    ],
  };
  window.__np.buildStepper(host, manifest);

  // Description preserved in .sub; model·effort in its own .me slot.
  const plan = host.querySelector('.stage[data-node-id="s0_0"]');
  assert.equal(plan.querySelector('.sub').textContent, 'architecture & breakdown');
  assert.equal(plan.querySelector('.me').textContent, 'Opus 4.8 · high');

  // Unset model -> "default"; description still shown.
  const refine = host.querySelector('.stage[data-node-id="s1_0"]');
  assert.equal(refine.querySelector('.sub').textContent, 'tighten the plan');
  assert.equal(refine.querySelector('.me').textContent, 'default');

  // Bookends (preflight/done) have no .me (gated on node.uiPhase).
  const pre = host.querySelector('.stage[data-node-id="preflight"]');
  assert.equal(pre.querySelector('.me'), null);
});

test('buildStepper renders .sub + .me on parallel-cell nodes', async () => {
  const { window } = await bootLive();
  window.__np._setModels([{ id: 'sonnet', label: 'Sonnet 4.6', efforts: [] }]);
  const host = window.document.createElement('div');
  host.className = 'stages compact';
  const manifest = {
    version: 1,
    steps: [
      { kind: 'agents', nodes: [
        { id: 's1_0', uiPhase: 'implement', label: 'Implementation', sub: 'write the code', model: 'sonnet', effort: '', cycles: false },
        { id: 's1_1', uiPhase: 'manual-checklist', label: 'Manual Tests Checklist', sub: 'draft manual test cases', model: '', effort: '', cycles: false },
      ] },
    ],
  };
  window.__np.buildStepper(host, manifest);
  const a = host.querySelector('.stage-node[data-node-id="s1_0"]');
  assert.equal(a.querySelector('.sub').textContent, 'write the code');
  assert.equal(a.querySelector('.me').textContent, 'Sonnet 4.6'); // no effort -> just the model label
  const b = host.querySelector('.stage-node[data-node-id="s1_1"]');
  assert.equal(b.querySelector('.me').textContent, 'default');
});

test('Running card renders the run\'s graph (run-flow, not stages.compact) and tints by nodeId', async () => {
  const ctx = await bootLive();
  ctx.selectProject();
  await new Promise((r) => setTimeout(r, 0));

  const manifest = {
    version: 1,
    steps: [
      { kind: 'preflight', nodes: [{ id: 'preflight', label: 'Preflight', sub: 'checks' }] },
      { kind: 'agents', nodes: [{ id: 's0_0', key: 'planner', uiPhase: 'plan', label: 'Plan', color: 'violet', cycles: false }] },
      { kind: 'agents', nodes: [{ id: 's1_0', key: 'refiner', uiPhase: 'refine', label: 'Refine Plan', color: 'green', cycles: true }] },
      { kind: 'agents', nodes: [{ id: 's4_0', key: 'manualTestsChecklist', uiPhase: 'manual-checklist', label: 'Manual Tests Checklist', color: 'blue', cycles: false }] },
      { kind: 'done', nodes: [{ id: 'done', label: 'Done', sub: 'complete' }] },
    ],
    feedbacks: [{ id: 'fb_refine', from: 's1_0', to: 's1_0' }],
  };
  const RID = 'run-1';
  ctx.emit({ type: 'state', runId: RID, status: 'running', phase: 'refine', stepper: manifest, steps: [] });
  ctx.emit({ type: 'phase', runId: RID, phase: 'refine', status: 'start', nodeId: 's1_0' });
  ctx.showRunning();
  await new Promise((r) => setTimeout(r, 0));

  const card = ctx.window.document.querySelector('#run-list [data-run-id="run-1"]');
  assert.ok(card, 'run card exists');
  assert.ok(card.querySelector('.run-flow'), 'graph host present');
  assert.equal(card.querySelector('.stages.compact'), null, 'old flat stepper gone');

  const labels = [...card.querySelectorAll('.run-node .nmeta b')].map((e) => e.textContent);
  assert.deepEqual(labels, ['Preflight', 'Plan', 'Refine Plan', 'Manual Tests Checklist', 'Done']);

  // s1_0 (Refine Plan) is the frontier -> is-active; earlier nodes is-done.
  assert.ok(card.querySelector('.run-node[data-id="s1_0"]').classList.contains('is-active'));
  assert.ok(card.querySelector('.run-node[data-id="s0_0"]').classList.contains('is-done'));
  assert.ok(card.querySelector('.run-node[data-id="preflight"]').classList.contains('is-done'));
  // Self-cycle target carries the iterates ring.
  assert.ok(card.querySelector('.run-node[data-id="s1_0"]').classList.contains('iterates'));
});

test('Running card frontier reflects pause/stop and tracks per-node cycle for the active loop', async () => {
  const ctx = await bootLive();
  ctx.selectProject();
  await new Promise((r) => setTimeout(r, 0));
  const manifest = {
    version: 1,
    steps: [
      { kind: 'preflight', nodes: [{ id: 'preflight', label: 'Preflight', sub: 'checks' }] },
      { kind: 'agents', nodes: [{ id: 's1_0', key: 'refiner', uiPhase: 'refine', label: 'Refine Plan', color: 'green', cycles: true }] },
      { kind: 'done', nodes: [{ id: 'done', label: 'Done', sub: 'complete' }] },
    ],
    feedbacks: [{ id: 'fb_refine', from: 's1_0', to: 's1_0' }],
  };
  const RID = 'run-2';
  ctx.emit({ type: 'state', runId: RID, status: 'running', phase: 'refine', stepper: manifest, steps: [] });
  ctx.emit({ type: 'phase', runId: RID, phase: 'refine', status: 'start', nodeId: 's1_0', cycle: 1 });
  ctx.emit({ type: 'phase', runId: RID, phase: 'refine', status: 'start', nodeId: 's1_0', cycle: 2 });
  ctx.showRunning();
  await new Promise((r) => setTimeout(r, 0));
  const card = ctx.window.document.querySelector('#run-list [data-run-id="run-2"]');
  assert.ok(card.querySelector('.run-node[data-id="s1_0"]').classList.contains('is-active'));

  // A stop status forces the frontier node to is-stopped.
  ctx.emit({ type: 'state', runId: RID, status: 'stopped' });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(card.querySelector('.run-node[data-id="s1_0"]').classList.contains('is-stopped'));
});
