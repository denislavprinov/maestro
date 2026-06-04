// test/ui-history-delete.test.mjs  (boot()/runs() copied from ui-history-pr.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));
const PROJECT = '/tmp/proj';

async function boot({ fetchHandler } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} addEventListener() {} };
  window.fetch = (url, opts) => {
    if (fetchHandler) { const r = fetchHandler(String(url), opts || {}); if (r) return r; }
    if (String(url).includes('/api/projects')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [{ name: 'proj', path: PROJECT, exists: true }] }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch { /* keep */ }
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(appPath + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  const selectProject = () => {
    const sel = window.document.querySelector('#projectSelect');
    sel.value = PROJECT; sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const showHistory = () => { window.location.hash = 'history'; window.dispatchEvent(new window.Event('hashchange')); };
  return { window, selectProject, showHistory };
}
const runs = (pipelines, ghAvailable) => Promise.resolve({ ok: true, status: 200, json: async () => ({ pipelines, live: [], ghAvailable }) });

const FIN = { id: 'p1', title: 'Feat', status: 'stopped', startedAt: '2026-06-02T00:00:00Z' };

test('finished entry shows an enabled Delete button under the stepper', async () => {
  const { window, selectProject, showHistory } = await boot({
    fetchHandler: (url) => (url.includes('/api/runs?') ? runs([FIN], false) : null),
  });
  selectProject(); showHistory();
  await new Promise((r) => setTimeout(r, 0));
  const card = window.document.querySelector('#history .hist-card');
  const btn = card.querySelector('.hist-detail .hist-delete');
  assert.ok(btn, 'delete button is inside hist-detail (under the stepper)');
  assert.equal(btn.hidden, false, 'visible for a finished entry');
});

test('running entry hides the Delete button', async () => {
  const { window, selectProject, showHistory } = await boot({
    fetchHandler: (url) => (url.includes('/api/runs?') ? runs([{ ...FIN, status: 'running' }], false) : null),
  });
  selectProject(); showHistory();
  await new Promise((r) => setTimeout(r, 0));
  const btn = window.document.querySelector('#history .hist-card .hist-delete');
  assert.equal(btn.hidden, true);
});

test('confirm + click issues DELETE with the id and removes the card', async () => {
  let deleted = null;
  const { window, selectProject, showHistory } = await boot({
    fetchHandler: (url, opts) => {
      if (url.includes('/api/runs?')) return runs([FIN], false);
      if (url.includes('/api/runs/p1') && opts.method === 'DELETE') {
        deleted = url;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      }
      return null;
    },
  });
  window.confirm = () => true; // stub the popup
  selectProject(); showHistory();
  await new Promise((r) => setTimeout(r, 0));
  const card = window.document.querySelector('#history .hist-card');
  card.querySelector('.hist-delete').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(deleted && deleted.includes('/api/runs/p1'), 'DELETE called for p1');
  assert.match(deleted, /projectDir=/, 'project-view delete passes projectDir');
  assert.equal(window.document.querySelector('#history .hist-card'), null, 'card removed from the list');
});

test('declining the confirm popup makes no request', async () => {
  let called = false;
  const { window, selectProject, showHistory } = await boot({
    fetchHandler: (url, opts) => {
      if (url.includes('/api/runs?')) return runs([FIN], false);
      if (opts.method === 'DELETE') { called = true; return Promise.resolve({ ok: true, status: 200, json: async () => ({}) }); }
      return null;
    },
  });
  window.confirm = () => false;
  selectProject(); showHistory();
  await new Promise((r) => setTimeout(r, 0));
  window.document.querySelector('.hist-delete').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(called, false, 'no DELETE when the user cancels');
});
