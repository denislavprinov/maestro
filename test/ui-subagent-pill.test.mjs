// test/ui-subagent-pill.test.mjs — (copy bootLive from test/ui-run-graph-paint.test.mjs)
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

test('subsPillText: spawned/active wording + colour flag', async () => {
  const { window } = await bootLive();
  const { subsPillText } = window.__np;
  // byNode: { nodeId: Array<{status}> }
  assert.deepEqual(
    subsPillText({ a: [{ status: 'running' }, { status: 'finished' }], b: [{ status: 'finished' }] }),
    { text: '3 spawned · 1 active', active: true },
  );
  assert.deepEqual(
    subsPillText({ a: [{ status: 'finished' }, { status: 'finished' }] }),
    { text: '2 sub-agents', active: false },
  );
  assert.deepEqual(subsPillText({}), { text: '0 sub-agents', active: false });
  // error/stopped count as spawned but not active
  assert.deepEqual(
    subsPillText({ a: [{ status: 'error' }, { status: 'stopped' }] }),
    { text: '2 sub-agents', active: false },
  );
});

test('paintSubsBar fills the button text, sb-count colour, and toggles the panel', async () => {
  const { window } = await bootLive();
  // Build a card so the template's .subs-bar exists.
  const tpl = window.document.querySelector('#run-card-tpl');
  const card = tpl.content.firstElementChild.cloneNode(true);
  const bar = card.querySelector('.subs-bar');
  assert.ok(bar, '.subs-bar present in the run-card template');
  const btn = bar.querySelector('.btn-subs');
  const panel = bar.querySelector('.subs-panel');
  assert.equal(btn.getAttribute('aria-expanded'), 'false', 'panel starts collapsed');
  assert.ok(panel.hidden, 'panel hidden initially');

  window.__np.paintSubsBar(bar, { a: [{ status: 'running' }, { status: 'finished' }] });
  assert.match(btn.querySelector('.sb-count').textContent, /2 spawned · 1 active/);
  assert.ok(!btn.querySelector('.sb-count').classList.contains('grey'), 'active -> blue count');

  window.__np.paintSubsBar(bar, { a: [{ status: 'finished' }] });
  assert.match(btn.querySelector('.sb-count').textContent, /1 sub-agents/);
  assert.ok(btn.querySelector('.sb-count').classList.contains('grey'), 'no active -> grey count');

  // toggle wiring (disclosure pattern)
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  assert.ok(!panel.hidden, 'click opens the panel');
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.ok(panel.hidden, 'click again collapses');
});

test('paintSubsBar hides the whole bar when there are no sub-agents', async () => {
  const { window } = await bootLive();
  const tpl = window.document.querySelector('#run-card-tpl');
  const card = tpl.content.firstElementChild.cloneNode(true);
  const bar = card.querySelector('.subs-bar');
  window.__np.paintSubsBar(bar, {});
  assert.ok(bar.hidden, 'empty -> the pill row is hidden entirely');
});
