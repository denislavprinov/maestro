// Results screen: installed tools, suggested tools (one-click Add), executed-tasks note.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, '../apps/enable/public/index.html');
const appPath = join(here, '../apps/enable/public/app.js');
const html = readFileSync(htmlPath, 'utf8');

class FakeWS { constructor(url) { this.url = url; } close() {} send() {} }

// close every JSDOM window this file opens so the process can exit cleanly
const openDoms = [];
after(() => { for (const dom of openDoms) { try { dom.window.close(); } catch {} } });

let vendorPosts = [];
let window;

async function boot() {
  vendorPosts = [];
  const dom = new JSDOM(html, { url: 'http://localhost:4319/' });
  openDoms.push(dom);
  window = dom.window;
  window.WebSocket = FakeWS;
  window.fetch = (url, opts) => {
    const u = String(url);
    if (opts && opts.method === 'POST' && u.includes('/api/enable/vendor')) {
      vendorPosts.push(opts.body);
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, already: false }) });
    }
    if (opts && opts.method === 'POST' && u.includes('/api/enable/run')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ runId: 'r1' }) });
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

const TOOLS = {
  installed: [{ name: 'graphify', source: 'global', mandatory: true },
              { name: 'caveman', source: 'plugin', mandatory: true },
              { name: 'writing-plans', source: 'global', mandatory: false }],
  skipped: [],
  suggested: [{ name: 'executing-plans', reason: 'pairs with writing-plans', source: 'catalog' }],
};
const TASKS = { attempted: [{ gap: 'Add smoke test', status: 'completed', notes: '' }], completed: 1, skipped: 0, failed: 0 };

function finalFrame(extra = {}) {
  return { type: 'readiness', kind: 'final', score: 90, baselineScore: 40, delta: 50,
    dimensions: {}, gaps: ['Document release flow'], branch: 'maestro/enable-x', ...extra };
}

test('results: installed tools render with mandatory badges; suggested rows carry Add buttons', async () => {
  const document = await boot();
  window.__enableTest.setRun('r1', 'p1');
  window.__enableTest.handle(finalFrame({ tools: TOOLS, tasks: TASKS }));
  await tick();
  assert.equal(document.querySelector('#tools-wrap').hidden, false);
  const installed = [...document.querySelectorAll('#tools-installed .tool-row')];
  assert.equal(installed.length, 3);
  assert.equal(installed.filter((li) => li.querySelector('.tool-badge')).length, 2);
  const btn = document.querySelector('#tools-suggested .vendor-btn');
  assert.equal(btn.dataset.name, 'executing-plans');
  assert.equal(document.querySelector('#tasks-note').hidden, false);
  assert.match(document.querySelector('#tasks-note').textContent, /1 task/);
});

test('results: an old run (no tools/tasks) hides the new sections entirely', async () => {
  const document = await boot();
  window.__enableTest.setRun('r1', 'p1');
  window.__enableTest.handle(finalFrame());
  await tick();
  assert.equal(document.querySelector('#tools-wrap').hidden, true);
  assert.equal(document.querySelector('#tasks-note').hidden, true);
});

test('clicking Add POSTs /api/enable/vendor and flips the button', async () => {
  const document = await boot();          // fetch stub: /api/enable/vendor -> { ok:true, already:false }
  // lastProjectDir must be set: boot -> selectProject -> submit run first (as in Task 9's submit test)
  await selectProject(document);
  document.querySelector('#go-setup').click();
  await tick();
  document.querySelector('#setup-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  window.__enableTest.setRun('r1', 'p1');
  window.__enableTest.handle(finalFrame({ tools: TOOLS, tasks: null }));
  await tick();
  const btn = document.querySelector('#tools-suggested .vendor-btn');
  btn.click();
  await tick(); await tick();
  assert.ok(vendorPosts.length === 1);                       // captured by the fetch stub
  assert.equal(JSON.parse(vendorPosts[0]).name, 'executing-plans');
  assert.match(btn.textContent, /Added/);
});
