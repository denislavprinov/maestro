// test/ui-source-branch-search.test.mjs — single-project source-branch search
// (native <input list> + <datalist>). Mirrors the JSDOM boot used by
// test/ui-workspace-source-branches.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));

const PROJECTS = [{ name: 'svc-iam', path: '/a/svc-iam', exists: true }];
const BRANCHES = { '/a/svc-iam': { branches: ['main', 'develop', 'feature/x'], current: 'develop' } };

async function boot({ posted } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} addEventListener() {} };
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('/api/projects')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: PROJECTS }) });
    if (u.includes('/api/workspaces')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ workspaces: [] }) });
    if (u.includes('/api/branches')) {
      const dir = decodeURIComponent(new URL(u, 'http://x').searchParams.get('projectDir') || '');
      return Promise.resolve({ ok: true, status: 200, json: async () => (BRANCHES[dir] || { branches: [], current: '' }) });
    }
    if (u.endsWith('/api/run') && opts && opts.method === 'POST') {
      if (posted) posted.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ runId: 'run-1' }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(appPath + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  // Select the project so branches load. projectSelect option values are PATHS.
  const sel = window.document.querySelector('#projectSelect');
  if (sel) { sel.value = '/a/svc-iam'; sel.dispatchEvent(new window.Event('change', { bubbles: true })); }
  await new Promise((r) => setTimeout(r, 0));
  return window;
}

test('single source-branch control is an <input list> backed by a <datalist>', async () => {
  const window = await boot();
  const doc = window.document;
  const input = doc.querySelector('#sourceBranch');
  assert.equal(input.tagName, 'INPUT', 'control is now an <input>');
  const listId = input.getAttribute('list');
  assert.ok(listId, 'input has a list= attribute');
  const list = doc.getElementById(listId);
  assert.ok(list && list.tagName === 'DATALIST', 'list points at a <datalist>');
  const values = [...list.querySelectorAll('option')].map((o) => o.value);
  assert.deepEqual(values, ['main', 'develop', 'feature/x'], 'datalist holds every local branch (searchable)');
});

test('input defaults to HEAD (current) and placeholder advertises auto', async () => {
  const window = await boot();
  const input = window.document.querySelector('#sourceBranch');
  assert.equal(input.value, 'develop', 'pre-filled with the current branch (HEAD), matching old select');
  assert.equal(input.placeholder, 'current branch (auto)');
});

test('typing a branch and submitting posts that sourceBranch; clearing posts none', async () => {
  const posted = [];
  const window = await boot({ posted });
  const doc = window.document;
  const input = doc.querySelector('#sourceBranch');

  // Typed/selected value flows straight through .value.
  input.value = 'feature/x';
  doc.querySelector('#prompt').value = 'do work';
  doc.querySelector('#run-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(posted[0].sourceBranch, 'feature/x');

  // Cleared field → omitted (server falls back to HEAD). `|| undefined` + JSON.stringify drops the key.
  input.value = '';
  doc.querySelector('#run-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal('sourceBranch' in posted[1], false, 'empty input → no sourceBranch key');
});
