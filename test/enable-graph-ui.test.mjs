import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, '../apps/enable/public/index.html');
const appPath = join(here, '../apps/enable/public/app.js');

const REPORT_MD = '# Graph Report\n\n## God Nodes\n\n- `AuthModule` — core\n- **Database**\n';

class FakeWS { constructor(url) { this.url = url; } close() {} send() {} }

async function boot({ exists = true, hasHtml = true, hasReport = true } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4319/' });
  const { window } = dom;
  window.WebSocket = FakeWS;
  window.fetch = (url) => {
    const u = String(url);
    if (u.includes('/api/enable/graph/exists')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ exists, hasHtml, hasReport, nodes: 3 }) });
    }
    if (u.includes('/api/enable/graph/report')) {
      return Promise.resolve({ ok: true, status: 200, text: async () => REPORT_MD });
    }
    if (u.includes('/api/enable/projects')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ root: '/root', projects: [{ name: 'myproj', path: '/root/myproj' }] }) });
    }
    if (u.includes('/api/enable/branches')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ branches: ['main'], current: 'main' }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(appPath + `?b=${Date.now()}_${Math.random()}`);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  return window.document;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function selectProject(document) {
  const sel = document.querySelector('#project-select');
  sel.value = '/root/myproj';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(); await tick();
}

test('graph button is enabled once a project with a graph is selected', async () => {
  const document = await boot({ exists: true, hasHtml: true });
  await selectProject(document);
  const btn = document.querySelector('#home-graph-btn');
  assert.equal(btn.hidden, false, 'button shown for a chosen project');
  assert.equal(btn.disabled, false, 'button enabled when a graph exists');
  assert.equal(document.querySelector('#home-graph-hint').hidden, true, 'no hint when graph exists');
});

test('graph button is disabled with a hint when no graph exists', async () => {
  const document = await boot({ exists: false, hasHtml: false, hasReport: false });
  await selectProject(document);
  const btn = document.querySelector('#home-graph-btn');
  assert.equal(btn.disabled, true);
  assert.equal(document.querySelector('#home-graph-hint').hidden, false, 'hint shown when no graph');
});

test('clicking the button opens the graph screen with iframe + rendered report', async () => {
  const document = await boot({ exists: true, hasHtml: true, hasReport: true });
  await selectProject(document);
  document.querySelector('#home-graph-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(); await tick(); await tick();

  assert.ok(document.querySelector('#graph').classList.contains('active'), 'graph screen is active');
  const frame = document.querySelector('#graph-frame');
  assert.equal(frame.hidden, false);
  assert.match(frame.getAttribute('src') || '', /\/api\/enable\/graph\/view\?project=myproj/);

  const report = document.querySelector('#graph-report').innerHTML;
  assert.match(report, /<h2>God Nodes<\/h2>/);
  assert.match(report, /<code>AuthModule<\/code>/);
  assert.match(report, /<strong>Database<\/strong>/);
});

test('back button returns to the screen the graph was opened from', async () => {
  const document = await boot();
  await selectProject(document);
  document.querySelector('#home-graph-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(); await tick();
  document.querySelector('#graph-back').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick();
  assert.ok(document.querySelector('#home').classList.contains('active'), 'returned to home');
});
