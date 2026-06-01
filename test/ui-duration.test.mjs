// test/ui-duration.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));
const PROJECT = '/tmp/proj';

// Identical boot harness to test/ui-cost.test.mjs (jsdom + stubbed WS/fetch).
async function boot({ fetchHandler } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.WebSocket = class {
    constructor() { this.readyState = 1; this._listeners = {}; }
    send() {} close() {}
    addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  };
  window.fetch = (url, opts) => {
    if (fetchHandler) { const r = fetchHandler(String(url), opts || {}); if (r) return r; }
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
  const selectProject = () => { const s = window.document.querySelector('#projectSelect'); s.value = PROJECT; s.dispatchEvent(new window.Event('change', { bubbles: true })); };
  const showHistory = () => { window.location.hash = 'history'; window.dispatchEvent(new window.Event('hashchange')); };
  return { window, selectProject, showHistory };
}
const runsList = (pipelines, live = []) => Promise.resolve({ ok: true, status: 200, json: async () => ({ pipelines, live }) });

test('history card shows total pipeline duration next to the date', async () => {
  const ctx = await boot({
    fetchHandler: (url) => url.includes('/api/runs?')
      ? runsList([{ id: 'p1', title: 'Run', status: 'done', startedAt: '2026-01-01T00:00:00Z', totalActiveMs: 83_000 }])
      : null,
  });
  ctx.selectProject(); ctx.showHistory();
  await new Promise((r) => setTimeout(r, 0));
  const t = ctx.window.document.querySelector('#history .hist-card .hist-time');
  assert.equal(t.textContent, '1m 23s');
});

test('a pipeline with no timing data renders a blank time chip', async () => {
  const ctx = await boot({
    fetchHandler: (url) => url.includes('/api/runs?')
      ? runsList([{ id: 'p1', title: 'Run', status: 'done', startedAt: '2026-01-01T00:00:00Z', totalActiveMs: null }])
      : null,
  });
  ctx.selectProject(); ctx.showHistory();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctx.window.document.querySelector('#history .hist-card .hist-time').textContent, '');
});

test('expanding a card paints per-phase duration from saved steps (refine cycles summed; never-run blank; 0ms -> 0s)', async () => {
  const state = {
    phase: 'done', status: 'done', cycle: 2, totalActiveMs: 8500,
    steps: [
      { key: 'preflight', phase: 'preflight', activeMs: 500, runningSince: null },
      { key: 'plan', phase: 'plan', activeMs: 4000, runningSince: null },
      { key: 'refine#1', phase: 'refine', activeMs: 1500, runningSince: null },
      { key: 'refine#2', phase: 'refine', activeMs: 1000, runningSince: null }, // two cycles -> 2500
      { key: 'implement', phase: 'implement', activeMs: 0, runningSince: null }, // ran sub-ms -> 0s
      // no review step recorded -> review stays blank
    ],
  };
  const ctx = await boot({
    fetchHandler: (url) => {
      if (url.includes('/api/runs?')) return runsList([{ id: 'p1', title: 'Run', status: 'done', startedAt: '2026-01-01T00:00:00Z', totalActiveMs: 8500 }]);
      if (url.includes('/api/runs/p1')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ state, auditMarkdown: '' }) });
      return null;
    },
  });
  ctx.selectProject(); ctx.showHistory();
  await new Promise((r) => setTimeout(r, 0));
  ctx.window.document.querySelector('#history .hist-head').dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  const byStep = {};
  for (const s of ctx.window.document.querySelectorAll('#history .hist-detail .stage[data-step]')) byStep[s.dataset.step] = s;
  assert.equal(byStep.plan.querySelector('.dur').textContent, '4s');
  assert.equal(byStep.refine.querySelector('.dur').textContent, '3s', 'refine cycles summed (2500ms -> 3s)');
  assert.equal(byStep.implement.querySelector('.dur').textContent, '0s', 'executed sub-ms phase shows 0s');
  assert.equal(byStep.review.querySelector('.dur').textContent, '', 'never-run review stays blank');
  assert.equal(byStep.preflight.querySelector('.dur').textContent, '1s', 'preflight has its own dur chip');
});

test('clarify active time folds into the Plan stage chip (parity with cost)', async () => {
  // normalizePhase maps both clarify and plan -> 'plan' (app.js:251), so a
  // clarify step's activeMs must show inside the Plan chip, not a separate one.
  const state = {
    phase: 'done', status: 'done', cycle: 0, totalActiveMs: 3000,
    steps: [
      { key: 'clarify#1', phase: 'clarify', activeMs: 1000, runningSince: null },
      { key: 'plan', phase: 'plan', activeMs: 2000, runningSince: null },
    ],
  };
  const ctx = await boot({
    fetchHandler: (url) => {
      if (url.includes('/api/runs?')) return runsList([{ id: 'p1', title: 'Run', status: 'done', startedAt: '2026-01-01T00:00:00Z', totalActiveMs: 3000 }]);
      if (url.includes('/api/runs/p1')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ state, auditMarkdown: '' }) });
      return null;
    },
  });
  ctx.selectProject(); ctx.showHistory();
  await new Promise((r) => setTimeout(r, 0));
  ctx.window.document.querySelector('#history .hist-head').dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  const planStage = [...ctx.window.document.querySelectorAll('#history .hist-detail .stage[data-step]')].find((s) => s.dataset.step === 'plan');
  assert.equal(planStage.querySelector('.dur').textContent, '3s', 'clarify(1000)+plan(2000) -> 3s in the Plan chip');
});

test('history ignores a dangling runningSince (saved data is treated as final)', async () => {
  // A run killed mid-phase can persist a step with runningSince set while status
  // is still 'running'. History must show the finalized activeMs only — never
  // now - runningSince (which, with a stale epoch, would be a runaway value).
  const state = {
    phase: 'implement', status: 'running', cycle: 0, totalActiveMs: 2000,
    steps: [
      { key: 'plan', phase: 'plan', activeMs: 2000, runningSince: null },
      { key: 'implement', phase: 'implement', activeMs: 0, runningSince: 1 }, // stale -> huge if added live
    ],
  };
  const ctx = await boot({
    fetchHandler: (url) => {
      if (url.includes('/api/runs?')) return runsList([{ id: 'p1', title: 'Run', status: 'running', startedAt: '2026-01-01T00:00:00Z', totalActiveMs: 2000 }]);
      if (url.includes('/api/runs/p1')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ state, auditMarkdown: '' }) });
      return null;
    },
  });
  ctx.selectProject(); ctx.showHistory();
  await new Promise((r) => setTimeout(r, 0));
  ctx.window.document.querySelector('#history .hist-head').dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  const byStep = {};
  for (const s of ctx.window.document.querySelectorAll('#history .hist-detail .stage[data-step]')) byStep[s.dataset.step] = s;
  assert.equal(byStep.implement.querySelector('.dur').textContent, '0s', 'finalized 0ms; dangling clock ignored');
});
