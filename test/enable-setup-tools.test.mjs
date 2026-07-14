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

const runPosts = [];

async function boot({ exists = true, hasHtml = true, hasReport = true } = {}) {
  runPosts.length = 0;
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4319/' });
  const { window } = dom;
  window.WebSocket = FakeWS;
  window.fetch = (url, opts) => {
    const u = String(url);
    if (opts && opts.method === 'POST' && u.includes('/api/enable/run')) {
      runPosts.push(opts.body);
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ runId: 'r1' }) });
    }
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

test('setup form: optionalTools + executeTasks fieldsets render with safe defaults', async () => {
  const document = await boot();
  assert.ok(document.querySelector('.opts[data-q="optionalTools"] input[value="writing-plans"]'));
  // no optional tool pre-checked
  assert.equal(document.querySelectorAll('input[name="optionalTools"]:checked').length, 0);
  // executeTasks defaults to up-to-3 (first option checked)
  assert.equal(document.querySelector('input[name="executeTasks"]:checked')?.value, 'up-to-3');
});

test('submitting the form sends joined optionalTools and the executeTasks choice', async () => {
  const document = await boot();
  await selectProject(document);
  document.querySelector('#go-setup').click();
  await tick();
  document.querySelector('input[name="optionalTools"][value="writing-plans"]').checked = true;
  document.querySelector('input[name="optionalTools"][value="executing-plans"]').checked = true;
  document.querySelector('input[name="executeTasks"][value="none"]').checked = true;
  document.querySelector('#setup-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  const body = JSON.parse(runPosts.at(-1));            // captured by the fetch stub
  assert.equal(body.answers.optionalTools, 'writing-plans, executing-plans');
  assert.equal(body.answers.executeTasks, 'none');
});

test('the journey renders the s_execute stage between review and test-drive', async () => {
  const document = await boot();
  await selectProject(document);
  document.querySelector('#go-setup').click();
  await tick();
  document.querySelector('#setup-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  const nodes = [...document.querySelectorAll('#journey .stage')].map((s) => s.dataset.node);
  assert.deepEqual(nodes.slice(-3), ['s_eval', 's_execute', 's_canary']);
});
