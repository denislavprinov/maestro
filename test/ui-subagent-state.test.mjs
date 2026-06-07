import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));
const PROJECT = '/tmp/proj';

async function boot() {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  let lastWs = null;
  window.WebSocket = class {
    constructor() { this.readyState = 1; this._l = {}; lastWs = this; }
    send() {} close() {}
    addEventListener(t, fn) { (this._l[t] ||= []).push(fn); }
  };
  window.fetch = (url) => String(url).includes('/api/projects')
    ? Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [{ name: 'proj', path: PROJECT, exists: true }] }) })
    : Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [] }) });
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(appPath + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  const selectProject = () => { const s = window.document.querySelector('#projectSelect'); s.value = PROJECT; s.dispatchEvent(new window.Event('change', { bubbles: true })); };
  const recv = (obj) => lastWs._l.message.forEach((fn) => fn({ data: JSON.stringify(obj) }));
  return { window, selectProject, recv };
}

test('makeRun seeds an empty r.subAgents array (read via __np.makeRun)', async () => {
  const ctx = await boot();
  const r = ctx.window.__np.makeRun({ runId: 'p1' });
  assert.ok(Array.isArray(r.subAgents), 'subAgents is an array');
  assert.equal(r.subAgents.length, 0, 'starts empty');
});

test('onSubagent: spawn inserts a running record keyed by id', async () => {
  const ctx = await boot();
  const r = ctx.window.__np.makeRun({ runId: 'p1' });
  ctx.window.__np.onSubagent(r, {
    type: 'subagent', runId: 'p1', transition: 'spawn',
    id: 'tool_1', label: 'research auth', nodeId: 's0_0',
    stepKey: '0:s0_0', stepIndex: 0, cycle: 0, status: 'running', ts: 1,
  });
  assert.equal(r.subAgents.length, 1);
  const rec = r.subAgents[0];
  assert.equal(rec.id, 'tool_1');
  assert.equal(rec.status, 'running');
  assert.equal(rec.label, 'research auth');
  assert.equal(rec.nodeId, 's0_0');
  assert.equal(rec.stepKey, '0:s0_0');
});

test('onSubagent: a second spawn for the same id updates in place (no duplicate)', async () => {
  const ctx = await boot();
  const r = ctx.window.__np.makeRun({ runId: 'p1' });
  ctx.window.__np.onSubagent(r, { transition: 'spawn', id: 'tool_1', label: 'first', nodeId: 's0_0', status: 'running' });
  ctx.window.__np.onSubagent(r, { transition: 'spawn', id: 'tool_1', label: 'second', nodeId: 's0_0', status: 'running' });
  assert.equal(r.subAgents.length, 1, 'still one record for tool_1');
  assert.equal(r.subAgents[0].label, 'second', 'label updated in place');
});

test('onSubagent: finish updates status + finishedAt + telemetry by id', async () => {
  const ctx = await boot();
  const r = ctx.window.__np.makeRun({ runId: 'p1' });
  ctx.window.__np.onSubagent(r, { transition: 'spawn', id: 'tool_1', label: 'x', nodeId: 's0_0', status: 'running', ts: 1 });
  ctx.window.__np.onSubagent(r, {
    transition: 'finish', id: 'tool_1', status: 'finished', ts: 2,
    durationMs: 4200, tokens: 1500, costUsd: 0.02,
  });
  assert.equal(r.subAgents.length, 1, 'finish does not add a row');
  const rec = r.subAgents[0];
  assert.equal(rec.status, 'finished');
  assert.equal(rec.durationMs, 4200);
  assert.equal(rec.tokens, 1500);
  assert.equal(rec.costUsd, 0.02);
  assert.ok(rec.finishedAt != null, 'finishedAt stamped');
  assert.equal(rec.label, 'x', 'spawn label preserved when finish omits it');
});

test('onSubagent: a finish for an unknown id inserts a terminal record', async () => {
  const ctx = await boot();
  const r = ctx.window.__np.makeRun({ runId: 'p1' });
  ctx.window.__np.onSubagent(r, { transition: 'finish', id: 'late_1', status: 'error', nodeId: 's1_0', ts: 9 });
  assert.equal(r.subAgents.length, 1);
  assert.equal(r.subAgents[0].id, 'late_1');
  assert.equal(r.subAgents[0].status, 'error');
});

test('switch routes a subagent frame through onSubagent onto the live run model', async () => {
  const ctx = await boot();
  ctx.selectProject();
  ctx.window.location.hash = 'running';
  ctx.window.dispatchEvent(new ctx.window.Event('hashchange'));
  ctx.recv({ type: 'phase', runId: 'p1', phase: 'plan', cycle: 0 }); // mounts the card + run model
  ctx.recv({
    type: 'subagent', runId: 'p1', transition: 'spawn',
    id: 'tool_1', label: 'sub one', nodeId: 's0_0', stepKey: '0:s0_0',
    stepIndex: 0, cycle: 0, status: 'running', ts: 1,
  });
  await new Promise((r) => setTimeout(r, 0));
  const r = ctx.window.__np.getRun('p1');
  assert.ok(r, 'run model exists');
  assert.equal(r.subAgents.length, 1, 'subagent frame reached the model via the switch');
  assert.equal(r.subAgents[0].id, 'tool_1');
});
