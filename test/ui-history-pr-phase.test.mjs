// test/ui-history-pr-phase.test.mjs
// Phase-2 PR enrichment over the WS: a `history-pr` batch patches the matching
// card in place (Create-PR -> PR link), tagged by a request token so stale/racing
// batches are dropped. Boots the REAL app.js under jsdom; WS frames are delivered
// via wsBox.ws.dispatch('message', { data }) (harness per test/ui-question.test.mjs).
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
  const wsBox = { ws: null };
  window.WebSocket = class {
    constructor() { this.readyState = 1; this._listeners = {}; wsBox.ws = this; }
    send() {} close() {}
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
    dispatch(type, evt) { (this._listeners[type] || []).forEach((fn) => fn(evt)); }
  };
  const calls = [];
  window.fetch = (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
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
  const showHistory = () => { window.location.hash = 'history'; window.dispatchEvent(new window.Event('hashchange')); };
  const refresh = () => window.document.querySelector('#refresh-history').dispatchEvent(new window.Event('click', { bubbles: true }));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const prTokens = () => calls.filter((c) => c.url.endsWith('/api/history/pr') && c.opts.body).map((c) => JSON.parse(c.opts.body).token);
  const dispatchPr = (msg) => wsBox.ws.dispatch('message', { data: JSON.stringify({ type: 'history-pr', done: true, items: [], ...msg }) });
  return { window, calls, wsBox, showHistory, refresh, tick, prTokens, dispatchPr };
}

const skeleton = (pipelines, ghAvailable = true) =>
  Promise.resolve({ ok: true, status: 200, json: async () => ({ pipelines, live: [], ghAvailable }) });

const ROW = (over = {}) => ({
  id: 'p1', title: 'Feat', status: 'stopped', startedAt: '2026-06-02T00:00:00Z',
  branch: 'maestro/feat-1', sourceBranch: 'main', survived: true, added: 3, removed: 1,
  projectName: 'Proj', projectKey: 'proj-0000abcd', projectDir: '/x/proj', ...over,
});

const cardSel = (id, key) => `#history .hist-card[data-pipeline-id="${id}"][data-project-key="${key}"]`;

test('history-pr OPEN batch swaps Create-PR -> "View PR" link in place, merge pill stays hidden', async () => {
  const ctx = await boot({ fetchHandler: (url) => (url.endsWith('/api/history') ? skeleton([ROW()]) : null) });
  ctx.showHistory();
  await ctx.tick();
  const card = ctx.window.document.querySelector('#history .hist-card');
  assert.equal(card.querySelector('.hist-pr').hidden, false, 'Create-PR button shown initially');

  // Expand the card first; the in-place patch must NOT collapse it (no full repaint).
  card.querySelector('.hist-head').dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  await ctx.tick();
  assert.equal(card.querySelector('.hist-head').getAttribute('aria-expanded'), 'true');

  const token = ctx.prTokens().at(-1);
  assert.ok(token != null, 'client POSTed a load token');
  ctx.dispatchPr({ token, done: true, items: [{ projectKey: 'proj-0000abcd', id: 'p1', pr: { state: 'OPEN', url: 'https://gh/x/pull/8', number: 8 } }] });
  await ctx.tick();

  assert.equal(card.querySelector('.hist-pr'), null, 'Create-PR button replaced');
  const link = card.querySelector('.hist-pr-link');
  assert.equal(link.getAttribute('href'), 'https://gh/x/pull/8');
  assert.equal(link.textContent, 'View PR');
  assert.equal(card.querySelector('.hist-merge').hidden, true, 'mergeability pill stays hidden (clarification B)');
  assert.equal(card.querySelector('.hist-head').getAttribute('aria-expanded'), 'true', 'expand survived the patch');
});

test('history-pr MERGED batch renders a "Merged" link', async () => {
  const ctx = await boot({ fetchHandler: (url) => (url.endsWith('/api/history') ? skeleton([ROW()]) : null) });
  ctx.showHistory();
  await ctx.tick();
  const token = ctx.prTokens().at(-1);
  ctx.dispatchPr({ token, items: [{ projectKey: 'proj-0000abcd', id: 'p1', pr: { state: 'MERGED', url: 'https://gh/x/pull/9', number: 9 } }] });
  await ctx.tick();
  const card = ctx.window.document.querySelector('#history .hist-card');
  const link = card.querySelector('.hist-pr-link.merged');
  assert.ok(link, 'merged link present');
  assert.equal(link.textContent, 'Merged');
  assert.equal(link.getAttribute('href'), 'https://gh/x/pull/9');
});

test('id collision across projects: only the (id, projectKey)-matched card is patched', async () => {
  const ctx = await boot({
    fetchHandler: (url) => (url.endsWith('/api/history')
      ? skeleton([ROW({ id: 'dup', projectKey: 'k1' }), ROW({ id: 'dup', projectKey: 'k2' })]) : null),
  });
  ctx.showHistory();
  await ctx.tick();
  const token = ctx.prTokens().at(-1);
  ctx.dispatchPr({ token, items: [{ projectKey: 'k1', id: 'dup', pr: { state: 'OPEN', url: 'https://gh/x/pull/1', number: 1 } }] });
  await ctx.tick();

  const k1 = ctx.window.document.querySelector(cardSel('dup', 'k1'));
  const k2 = ctx.window.document.querySelector(cardSel('dup', 'k2'));
  assert.ok(k1.querySelector('.hist-pr-link'), 'k1 card patched to a link');
  assert.equal(k1.querySelector('.hist-pr'), null);
  assert.equal(k2.querySelector('.hist-pr-link'), null, 'k2 card untouched');
  assert.equal(k2.querySelector('.hist-pr').hidden, false, 'k2 still shows Create-PR');
});

test('stale/never-issued token batch is dropped (no DOM change)', async () => {
  const ctx = await boot({ fetchHandler: (url) => (url.endsWith('/api/history') ? skeleton([ROW()]) : null) });
  ctx.showHistory();
  await ctx.tick();
  const token = ctx.prTokens().at(-1);
  ctx.dispatchPr({ token: token + 999, items: [{ projectKey: 'proj-0000abcd', id: 'p1', pr: { state: 'OPEN', url: 'https://gh/x/pull/8', number: 8 } }] });
  await ctx.tick();
  const card = ctx.window.document.querySelector('#history .hist-card');
  assert.equal(card.querySelector('.hist-pr-link'), null, 'no link from a stale token');
  assert.equal(card.querySelector('.hist-pr').hidden, false, 'Create-PR button still shown');
  // settle the real load so no watchdog lingers
  ctx.dispatchPr({ token, items: [] });
  await ctx.tick();
});

test('race: a forced refresh supersedes the prior load; the old token batch is dropped', async () => {
  const ctx = await boot({ fetchHandler: (url) => (url.endsWith('/api/history') ? skeleton([ROW()]) : null) });
  ctx.showHistory();
  await ctx.tick();
  ctx.refresh();                         // force-refresh -> bumps the token
  await ctx.tick();
  const tokens = ctx.prTokens();
  const [tA, tB] = [tokens[0], tokens.at(-1)];
  assert.notEqual(tA, tB, 'force refresh issued a new token');

  // Deliver the OLD token LAST -> must be ignored.
  ctx.dispatchPr({ token: tA, items: [{ projectKey: 'proj-0000abcd', id: 'p1', pr: { state: 'OPEN', url: 'https://gh/x/pull/8', number: 8 } }] });
  await ctx.tick();
  const card = ctx.window.document.querySelector('#history .hist-card');
  assert.equal(card.querySelector('.hist-pr-link'), null, 'stale (tA) batch dropped after tB superseded it');

  // The current token still patches.
  ctx.dispatchPr({ token: tB, items: [{ projectKey: 'proj-0000abcd', id: 'p1', pr: { state: 'OPEN', url: 'https://gh/x/pull/8', number: 8 } }] });
  await ctx.tick();
  assert.ok(card.querySelector('.hist-pr-link'), 'current (tB) batch patches');
});
