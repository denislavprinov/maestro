// test/projects-ui-behavior.test.mjs  (new file)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));

// Same shape as boot() in test/ui-history-delete.test.mjs (stubs fetch + WebSocket,
// cache-busts app.js). fetchHandler runs first; falls through to safe defaults so
// app.js boots even when this test only cares about /api/projects.
async function boot({ fetchHandler } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} addEventListener() {} };
  window.fetch = (url, opts) => {
    if (fetchHandler) { const r = fetchHandler(String(url), opts || {}); if (r) return r; }
    if (String(url).includes('/api/projects')) {
      return Promise.resolve({ ok: true, status: 200,
        json: async () => ({ projects: [{ name: 'demo', path: '/p/demo', exists: true }] }) });
    }
    return Promise.resolve({ ok: true, status: 200,
      json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch { /* keep */ }
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(appPath + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  return { window };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('renaming a project on the Projects page PATCHes /api/projects with path+name', async () => {
  const calls = [];
  const { window } = await boot({
    fetchHandler: (url, opts) => {
      if (url.includes('/api/projects') && opts.method === 'PATCH') {
        calls.push(JSON.parse(opts.body));
        return Promise.resolve({ ok: true, status: 200,
          json: async () => ({ projects: [{ name: 'renamed', path: '/p/demo', exists: true }] }) });
      }
      if (url.includes('/api/projects')) // GET list
        return Promise.resolve({ ok: true, status: 200,
          json: async () => ({ projects: [{ name: 'demo', path: '/p/demo', exists: true }] }) });
      return null;
    },
  });

  // Drive the router exactly like the real boot().showHistory helper does.
  window.location.hash = 'projects';
  window.dispatchEvent(new window.Event('hashchange'));
  await tick(); await tick();   // let loadProjectsView()'s fetch+render settle

  const card = window.document.querySelector('#projects-list .proj-card');
  assert.ok(card, 'project card rendered on the Projects view');
  card.querySelector('.proj-rename').dispatchEvent(new window.Event('click', { bubbles: true }));
  card.querySelector('.proj-name-input').value = 'renamed';
  card.querySelector('.proj-rename-save').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(); await tick();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { path: '/p/demo', name: 'renamed' });
});
