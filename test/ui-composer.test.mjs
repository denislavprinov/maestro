// test/ui-composer.test.mjs — jsdom boot test: the composer view is wired into
// the SPA router and its DOM shell renders. (Pure logic is in
// test/composer-ui.test.mjs; drag/drop + paintWires are manual-only.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));

const DEFAULT_WF = {
  id: 'wf_default', name: 'Default', version: 1,
  steps: [
    [{ id: 's0_0', key: 'planner' }],
    [{ id: 's1_0', key: 'refiner' }],
    [{ id: 's2_0', key: 'implementer' }],
    [{ id: 's3_0', key: 'reviewer' }],
  ],
  // CONV-7: mirror DEFAULT_WORKFLOW EXACTLY — refine self-loop + review->implement loop.
  feedbacks: [{ id: 'fb_refine', from: 's1_0', to: 's1_0' }, { id: 'fb_review', from: 's3_0', to: 's2_0' }],
  createdAt: 'x', updatedAt: 'x',
};

async function boot() {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  // jsdom has no layout: force offsetParent truthy so paintWires doesn't early-return on errors.
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', { get() { return window.document.body; }, configurable: true });
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} addEventListener() {} };
  window.fetch = (url) => {
    const u = String(url);
    if (u.includes('/api/workflows/wf_default')) return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_WF });
    if (u.includes('/api/workflows')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ workflows: [DEFAULT_WF] }) });
    if (u.includes('/api/agents')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ agents: [] }) });
    if (u.includes('/api/projects')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [] }) });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator', 'requestAnimationFrame']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(appPath + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  return window;
}

test('composer is a router view: hash #composer reveals the canvas section', async () => {
  const window = await boot();
  window.location.hash = 'composer';
  window.dispatchEvent(new window.Event('hashchange'));
  await new Promise((r) => setTimeout(r, 0));
  const view = window.document.querySelector('.view[data-view="composer"]');
  assert.ok(view, 'composer section exists');
  assert.equal(view.classList.contains('hidden'), false, 'composer view is shown');
  const others = [...window.document.querySelectorAll('.view')].filter((v) => v.dataset.view !== 'composer');
  assert.ok(others.every((v) => v.classList.contains('hidden')), 'other views hidden');
});

test('opening the composer builds the palette from the agents/embedded registry', async () => {
  const window = await boot();
  window.location.hash = 'composer';
  window.dispatchEvent(new window.Event('hashchange'));
  await new Promise((r) => setTimeout(r, 10));
  const pills = window.document.querySelectorAll('#composer-palette .agent-pill');
  assert.equal(pills.length, 6, 'six agent pills (embedded fallback)');
  assert.match(pills[0].textContent, /Plan/);
});

test('Save serializes the canvas to contract topology and POSTs {name,steps,feedbacks}', async () => {
  const posted = [];
  // Re-run boot but intercept POST /api/workflows.
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', { get() { return window.document.body; }, configurable: true });
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  window.prompt = () => 'My Flow';
  window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} addEventListener() {} };
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('/api/workflows/wf_default')) return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_WF });
    if (u.endsWith('/api/workflows') && opts && opts.method === 'POST') {
      posted.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ workflow: { id: 'wf_x', name: JSON.parse(opts.body).name, ...JSON.parse(opts.body), version: 1, createdAt: 'x', updatedAt: 'x' } }) });
    }
    if (u.includes('/api/workflows')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ workflows: [DEFAULT_WF] }) });
    if (u.includes('/api/agents')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ agents: [] }) });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [], config: { steps: {}, customModels: [] }, models: [], efforts: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator', 'requestAnimationFrame']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(appPath + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  window.location.hash = 'composer';
  window.dispatchEvent(new window.Event('hashchange'));
  await new Promise((r) => setTimeout(r, 20)); // initComposer awaits Reset -> wf_default

  // The default render must produce 4 columns (Plan/Refine/Implement/Review).
  const cols = window.document.querySelectorAll('#composer-flow > .col');
  assert.equal(cols.length, 4, 'default = 4 steps');

  window.document.getElementById('composer-save').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(posted.length, 1, 'one POST');
  assert.equal(posted[0].name, 'My Flow');
  assert.deepEqual(posted[0].steps.map((c) => c.map((x) => x.key)),
    [['planner'], ['refiner'], ['implementer'], ['reviewer']]);
  assert.equal(posted[0].steps[0][0].id, 's0_0', 'contract instance ids');
  assert.equal(posted[0].feedbacks.length, 2, 'two default feedback loops');
});
