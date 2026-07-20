// test/ui-assets-panel.test.mjs — (bootLive copied from test/ui-subagent-pill.test.mjs)
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

test('assetRollup dedups by (kind,name) with counts and items', async () => {
  const { window } = await bootLive();
  const { assetRollup } = window.__np;
  const rows = [
    { id: '1', kind: 'skill', name: 'browse', detail: 'a' },
    { id: '2', kind: 'skill', name: 'browse', detail: 'b' },
    { id: '3', kind: 'agent', name: 'Explore', detail: 'map' },
    { id: '4', kind: 'graphify', name: 'graphify', detail: 'graphify query' },
  ];
  assert.deepEqual(assetRollup(rows), [
    { kind: 'skill',    name: 'browse',   count: 2, items: [rows[0], rows[1]] },
    { kind: 'agent',    name: 'Explore',  count: 1, items: [rows[2]] },
    { kind: 'graphify', name: 'graphify', count: 1, items: [rows[3]] },
  ]);
});

test('assetsPillText summarises total + distinct', async () => {
  const { window } = await bootLive();
  const { assetsPillText } = window.__np;
  assert.deepEqual(assetsPillText([]), { text: 'No assets used', empty: true });
  assert.deepEqual(
    assetsPillText([{ kind: 'skill', name: 'a' }, { kind: 'skill', name: 'a' }, { kind: 'agent', name: 'b' }]),
    { text: '3 invocations · 2 assets', empty: false });
});

test('paintAssetsPanel fills the button + toggles the drill-down', async () => {
  const { window } = await bootLive();
  const tpl = window.document.querySelector('#run-card-tpl');
  const card = tpl.content.firstElementChild.cloneNode(true);
  const bar = card.querySelector('.assets-bar');
  assert.ok(bar, '.assets-bar present in the run-card template');
  window.__np.paintAssetsPanel(bar, [
    { id: '1', kind: 'skill', name: 'browse', detail: 'open' },
    { id: '2', kind: 'graphify', name: 'graphify', detail: 'graphify query' },
  ]);
  const btn = bar.querySelector('.btn-assets');
  assert.match(btn.textContent, /2 invocations · 2 assets/);
  btn.dispatchEvent(new window.Event('click'));
  assert.equal(bar.querySelector('.assets-panel').hidden, false, 'panel expands on click');
  assert.equal(bar.querySelectorAll('.assets-row').length, 2, 'one row per deduped asset');
});
