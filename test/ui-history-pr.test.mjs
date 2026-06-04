// test/ui-history-pr.test.mjs
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

const SURVIVED = {
  id: 'p1', title: 'Feat', status: 'stopped', startedAt: '2026-06-02T00:00:00Z',
  branch: 'maestro/feat-1', sourceBranch: 'main', survived: true, added: 12, removed: 5,
};

test('survived entry: branch line under meta + green/red diff chip', async () => {
  const { window, selectProject, showHistory } = await boot({
    fetchHandler: (url) => (url.includes('/api/runs?') ? runs([SURVIVED], true) : null),
  });
  selectProject(); showHistory();
  await new Promise((r) => setTimeout(r, 0));
  const card = window.document.querySelector('#history .hist-card');
  assert.equal(card.querySelector('.h-meta .hist-branch').textContent, 'maestro/feat-1');
  assert.equal(card.querySelector('.hist-diff .diff-add').textContent, '+12');
  assert.equal(card.querySelector('.hist-diff .diff-del').textContent, '−5');
});

test('Create-PR button shows when gh available; click opens PR + merge pill', async () => {
  let prBody = null;
  const { window, selectProject, showHistory } = await boot({
    fetchHandler: (url, opts) => {
      if (url.includes('/api/runs?')) return runs([SURVIVED], true);
      // NOTE: match the exact path — `/api/projects`.includes('/api/pr') is true,
      // so a loose substring check would swallow the project-list fetch.
      if (url.endsWith('/api/pr')) {
        prBody = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, url: 'https://gh/x/pull/3', mergeable: 'MERGEABLE' }) });
      }
      return null;
    },
  });
  selectProject(); showHistory();
  await new Promise((r) => setTimeout(r, 0));
  const card = window.document.querySelector('#history .hist-card');
  const btn = card.querySelector('.hist-pr');
  assert.equal(btn.hidden, false, 'button visible when gh available');
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(prBody.id, 'p1');
  const link = card.querySelector('.hist-pr-link');
  assert.equal(link.getAttribute('href'), 'https://gh/x/pull/3');
  const pill = card.querySelector('.hist-merge');
  assert.equal(pill.hidden, false);
  assert.ok(pill.classList.contains('ok'));
  assert.match(pill.textContent, /can merge/);
});

test('button hidden when gh unavailable, and for non-survived branches', async () => {
  const { window, selectProject, showHistory } = await boot({
    fetchHandler: (url) => (url.includes('/api/runs?')
      ? runs([SURVIVED, { ...SURVIVED, id: 'p2', survived: false }], false) : null),
  });
  selectProject(); showHistory();
  await new Promise((r) => setTimeout(r, 0));
  const cards = window.document.querySelectorAll('#history .hist-card');
  assert.equal(cards[0].querySelector('.hist-pr').hidden, true, 'gh unavailable hides button');
  assert.equal(cards[1].querySelector('.hist-diff').textContent, '', 'non-survived shows no diff');
});
