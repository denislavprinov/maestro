// test/ui-all-history.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));

async function boot({ fetchHandler } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} addEventListener() {} };
  window.fetch = (url, opts) => {
    if (fetchHandler) { const r = fetchHandler(String(url), opts || {}); if (r) return r; }
    if (String(url).includes('/api/projects'))
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [] }) });
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

test('All-projects toggle lists pipelines from /api/history with project labels', async () => {
  let historyHit = false;
  const ctx = await boot({
    fetchHandler: (url) => {
      if (url.includes('/api/history')) {
        historyHit = true;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ pipelines: [
          { id: 'a1', title: 'Alpha run', status: 'done', startedAt: '2026-06-01T00:00:00Z', projectName: 'Alpha', projectKey: 'alpha-00000001' },
          { id: 'b1', title: 'Beta run', status: 'done', startedAt: '2026-06-02T00:00:00Z', projectName: 'Beta', projectKey: 'beta-00000002' },
        ] }) });
      }
      return null;
    },
  });
  const { window } = ctx;
  const toggle = window.document.querySelector('#allProjectsToggle');
  assert.ok(toggle, 'history view has an All-projects toggle');
  toggle.checked = true;
  toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(historyHit, 'toggling fetches /api/history');
  const cards = window.document.querySelectorAll('#history .hist-card');
  assert.equal(cards.length, 2);
  assert.match(window.document.querySelector('#history').textContent, /Alpha/);
  assert.match(window.document.querySelector('#history').textContent, /Beta/);

  // Refresh must STAY in all-projects mode (regression guard for v4 fix #2).
  historyHit = false;
  window.document.querySelector('#refresh-history').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(historyHit, 'Refresh re-fetches /api/history while All-projects is on');
});
