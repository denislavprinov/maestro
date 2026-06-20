// test/ui-skill-pills.test.mjs — main-agent header pills + per-sub-agent row pills,
// escaped + kind-classed; and the run-model wiring (onStepSkills/onState/onSubagent).
// bootLive() copied from test/ui-subagent-pill.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));
const PROJECT = '/tmp/proj';

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
  return { window };
}

test('renderSubsTree renders main-agent header pills + per-sub-agent row pills, escaped, kind-classed', async () => {
  const { window } = await bootLive();
  const { renderSubsTree } = window.__np;
  const panel = window.document.createElement('div');
  const byNode = { 'n1|1': [
    { id: 'a1', label: 'AR sheet', status: 'finished', skills: ['skill:graphify'] },
    { id: 'a2', label: 'AR items', status: 'finished' }, // no skills -> no pill row
  ] };
  const stepSkills = { 'n1|1': ['skill:graphify', 'mcp:playwright', 'mcp:<x>'] };
  renderSubsTree(panel, byNode, (k) => 'Plan', stepSkills);

  const head = panel.querySelector('.subs-step .subs-skills'); // header pill row
  const headPills = [...head.querySelectorAll('.skill-pill')].map((e) => e.textContent);
  assert.deepEqual(headPills, ['graphify', 'playwright', '<x>']);          // names only, escaped
  assert.ok(head.querySelector('.skill-pill.is-mcp'), 'mcp pill carries is-mcp');
  assert.ok(head.querySelector('.skill-pill.is-skill'), 'skill pill carries is-skill');
  assert.equal(head.querySelector('.skill-pill').innerHTML, 'graphify');   // not raw "skill:graphify"

  const rows = panel.querySelectorAll('.subs-tree li');
  assert.ok(rows[0].querySelector('.subs-skills .skill-pill'), 'sub-agent with skills gets a pill row');
  assert.equal(rows[1].querySelector('.subs-skills'), null, 'sub-agent without skills gets no pill row');
});

test('onStepSkills + onState populate r.stepSkills; onSubagent merges skills', async () => {
  const { window } = await bootLive();
  const { makeRun, onState, onSubagent, onStepSkills } = window.__np;
  const r = makeRun({ runId: 'run1' });
  onState(r, { steps: [{ key: '2:n1', nodeId: 'n1', cycle: 1, skills: ['skill:graphify'] }], subAgents: [] });
  assert.deepEqual(r.stepSkills['n1|1'], ['skill:graphify']);              // composite nodeId|cycle key
  onStepSkills(r, { nodeId: 'n1', cycle: 1, skills: ['skill:graphify', 'mcp:playwright'] });
  assert.deepEqual(r.stepSkills['n1|1'], ['skill:graphify', 'mcp:playwright']);
  onSubagent(r, { id: 'a1', nodeId: 'n1', cycle: 1, status: 'running', skills: ['skill:brainstorming'] });
  assert.deepEqual(r.subAgents.find((s) => s.id === 'a1').skills, ['skill:brainstorming']);
});
