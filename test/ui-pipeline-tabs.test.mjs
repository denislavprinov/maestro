// test/ui-pipeline-tabs.test.mjs — per-pipeline child tabs under Running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..', 'ui', 'public');
const htmlPath = join(root, 'index.html');
const appPath = join(root, 'app.js');
const PROJECT = '/tmp/proj';

async function boot() {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  let lastWs = null;
  window.WebSocket = class { constructor() { this.readyState = 1; this._l = {}; lastWs = this; }
    send() {} close() {} addEventListener(t, fn) { (this._l[t] ||= []).push(fn); } };
  window.fetch = (url) => String(url).includes('/api/projects')
    ? Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [{ name: 'proj', path: PROJECT, exists: true }] }) })
    : Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [], pipelines: 0, projects: 0, workspaces: 0 }) });
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  window.localStorage.clear();
  await import(appPath + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  const open = () => lastWs._l.open?.forEach((fn) => fn());
  const recv = (obj) => lastWs._l.message.forEach((fn) => fn({ data: JSON.stringify(obj) }));
  open();
  return { window, recv };
}

const live = (runId, extra = {}) => ({
  runId, title: runId, projectDir: PROJECT, status: 'running', kind: 'run',
  startedAt: '10:00:00', pendingQuestion: null, ...extra,
});

test('hello with two live pipelines renders two child rows + live badge', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [live('auth-fix'), live('seo-pSEO')] });
  const rows = window.document.querySelectorAll('#nav-running-children .nav-child');
  assert.equal(rows.length, 2);
  assert.equal(window.document.querySelector('#nav-running-count').textContent, '2');
});

test('a pending question shows amber dot + parent roll-up', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [live('auth-fix', { pendingQuestion: { id: 'q1', kind: 'clarify', questions: [{ question: 'x?', options: ['a'] }] } })] });
  const dot = window.document.querySelector('#nav-running-children .nav-child .child-dot');
  assert.ok(dot.classList.contains('amber'));
  assert.equal(window.document.querySelector('#nav-running-rollup').hidden, false);
});

test('focus route shows only the selected card', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [live('auth-fix'), live('seo-pSEO')] });
  window.location.hash = 'running/auth-fix';
  window.dispatchEvent(new window.Event('hashchange'));
  const cards = window.document.querySelectorAll('#run-list .run-card');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].dataset.runId, 'auth-fix');
});

test('a run finishing live lingers as a greyed child row, then drops once opened', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [live('auth-fix')] });
  recv({ type: 'done', runId: 'auth-fix', status: 'done' });        // finishes LIVE
  let row = window.document.querySelector('#nav-running-children .nav-child[data-child-run-id="auth-fix"]');
  assert.ok(row, 'lingerer still present');
  assert.ok(row.classList.contains('lingering'));
  window.location.hash = 'running/auth-fix';                        // open → acknowledge
  window.dispatchEvent(new window.Event('hashchange'));
  row = window.document.querySelector('#nav-running-children .nav-child[data-child-run-id="auth-fix"]');
  assert.equal(row, null, 'acknowledged run drops from tabs');
});

test('seed-on-first-hello: a pre-existing terminal run is NOT a lingerer', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [live('old-done', { status: 'done' })] });
  const rows = window.document.querySelectorAll('#nav-running-children .nav-child');
  assert.equal(rows.length, 0);
});

// v2: a live NON-pipeline run (e.g. a scan) still renders on the Overview (no
// regression), but gets NO child tab (Q&A #1, pipeline-only tabs).
test('a live non-pipeline run shows on Overview but has no child tab', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [live('scan-1', { kind: 'scan' })] });
  const tabs = window.document.querySelectorAll('#nav-running-children .nav-child');
  assert.equal(tabs.length, 0, 'scan gets no pipeline tab');
  window.location.hash = 'running';   // Overview only paints #run-list while on the Running view
  window.dispatchEvent(new window.Event('hashchange'));
  const cards = window.document.querySelectorAll('#run-list .run-card');
  assert.equal(cards.length, 1, 'scan still renders as an Overview card');
  assert.equal(cards[0].dataset.runId, 'scan-1');
});

// v3: finishing the FOCUSED run falls back to the Overview (Q&A #5).
test('finishing the focused run falls back to Overview', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [live('auth-fix'), live('seo-pSEO')] });
  window.location.hash = 'running/auth-fix';
  window.dispatchEvent(new window.Event('hashchange'));
  recv({ type: 'done', runId: 'auth-fix', status: 'done' });        // focused run finishes
  assert.equal(window.location.hash.replace(/^#/, ''), 'running', 'hash dropped to Overview');
});
