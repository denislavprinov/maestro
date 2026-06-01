import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Behavior tests for Task 5: the expandable .hist-card History view. We boot the
// REAL app.js against the REAL index.html under jsdom, stub fetch + WebSocket,
// drive the History load via the same path the app uses (select a project ->
// onProjectChanged -> loadHistory; navigate to #history), and assert the cards
// render, expand, and tint from the lazily-fetched saved state.
//
// Each test gets a fresh DOM + a fresh module import (cache-busted) so module
// top-level state can't leak between cases.

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));

const PROJECT = '/tmp/proj';

// Boot app.js into a fresh jsdom window. `fetchHandler(url, opts)` may return a
// Promise to override a request; returning null falls through to the defaults.
async function boot({ fetchHandler } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;

  // jsdom doesn't implement scrollIntoView; the viewer modal calls it on open.
  window.Element.prototype.scrollIntoView = function () {};

  const wsBox = { ws: null };
  window.WebSocket = class {
    constructor() {
      this.readyState = 1;
      this._listeners = {};
      wsBox.ws = this;
    }
    send() {}
    close() {}
    addEventListener(type, fn) {
      (this._listeners[type] ||= []).push(fn);
    }
    dispatch(type, evt) {
      (this._listeners[type] || []).forEach((fn) => fn(evt));
    }
  };

  const calls = [];
  window.fetch = (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    if (fetchHandler) {
      const r = fetchHandler(String(url), opts || {});
      if (r) return r;
    }
    // Default boot fetches: /api/projects returns our one project so the select
    // can be populated; /api/config benign.
    if (String(url).includes('/api/projects')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ projects: [{ name: 'proj', path: PROJECT, exists: true }] }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [] }),
    });
  };

  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try {
      Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true });
    } catch {
      /* read-only global already present — leave it */
    }
  }
  globalThis.window = window;
  globalThis.document = window.document;

  await import(appPath + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0)); // let loadProjects/loadConfig settle

  // Select our project the way a user would: set the <select> value + dispatch
  // change. This triggers onProjectChanged -> loadHistory(PROJECT).
  function selectProject() {
    const sel = window.document.querySelector('#projectSelect');
    sel.value = PROJECT;
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  function showHistory() {
    window.location.hash = 'history';
    window.dispatchEvent(new window.Event('hashchange'));
  }

  return { window, calls, wsBox, selectProject, showHistory };
}

function runsListResponse(pipelines, live = []) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ pipelines, live }) });
}

test('history renders 2 .hist-card divs (no <li>), badges DONE/STOPPED, nav count=2', async () => {
  const ctx = await boot({
    fetchHandler: (url) => {
      if (url.includes('/api/runs?')) {
        return runsListResponse([
          { id: 'p-done', title: 'Done run', status: 'done', startedAt: '2026-01-01T00:00:00Z' },
          { id: 'p-stop', title: 'Stopped run', status: 'stopped', startedAt: '2026-01-02T00:00:00Z' },
        ]);
      }
      return null;
    },
  });
  ctx.selectProject();
  ctx.showHistory();
  await new Promise((r) => setTimeout(r, 0));

  const doc = ctx.window.document;
  const cards = doc.querySelectorAll('#history .hist-card');
  assert.equal(cards.length, 2, 'two history cards rendered');
  assert.equal(doc.querySelectorAll('#history li').length, 0, 'no <li> emitted');

  const badges = [...doc.querySelectorAll('#history .badge')];
  assert.equal(badges[0].textContent, 'DONE');
  assert.ok(badges[0].classList.contains('green'), 'done badge is green');
  assert.equal(badges[1].textContent, 'STOPPED');
  assert.ok(badges[1].classList.contains('red'), 'stopped badge is red');

  // Titles surface in .h-meta b.
  assert.equal(cards[0].querySelector('.h-meta b').textContent, 'Done run');

  assert.equal(doc.querySelector('#nav-history-count').textContent, '2', 'nav count reflects rendered cards');
});

test('expanding a card toggles aria-expanded, unhides detail, tints stepper from fetched state', async () => {
  const ctx = await boot({
    fetchHandler: (url) => {
      if (url.includes('/api/runs?')) {
        return runsListResponse([{ id: 'p-stop', title: 'Stopped run', status: 'stopped', startedAt: '2026-01-02T00:00:00Z' }]);
      }
      // Lazy per-card detail fetch: GET /api/runs/:id?projectDir=...
      if (url.includes('/api/runs/p-stop')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ state: { phase: 'implement', status: 'stopped', cycle: 1 }, auditMarkdown: '' }),
        });
      }
      return null;
    },
  });
  ctx.selectProject();
  ctx.showHistory();
  await new Promise((r) => setTimeout(r, 0));

  const doc = ctx.window.document;
  const card = doc.querySelector('#history .hist-card');
  const head = card.querySelector('.hist-head');
  const detail = card.querySelector('.hist-detail');
  assert.equal(head.getAttribute('aria-expanded'), 'false', 'starts collapsed');
  assert.equal(detail.hidden, true, 'detail starts hidden');

  // Click the head (NOT the title) to expand.
  head.dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0)); // let the lazy detail fetch resolve

  assert.equal(head.getAttribute('aria-expanded'), 'true', 'expanded after click');
  assert.equal(detail.hidden, false, 'detail unhidden after expand');

  // Tinted stepper: phase=implement, status=stopped => preflight/plan/refine done,
  // implement stopped, review/done pending.
  const byStep = {};
  for (const s of detail.querySelectorAll('.stage[data-node-id]')) byStep[s.dataset.nodeId] = s;
  assert.ok(byStep.preflight.classList.contains('s-done'), 'preflight done');
  assert.ok(byStep.plan.classList.contains('s-done'), 'plan done');
  assert.ok(byStep.refine.classList.contains('s-done'), 'refine done');
  assert.ok(byStep.implement.classList.contains('s-stop'), 'implement stopped');
  assert.ok(byStep.implement.querySelector('.num').classList.contains('n-red'), 'implement num red');
  assert.ok(byStep.review.querySelector('.num').classList.contains('n-grey'), 'review pending grey');
  assert.ok(!byStep.review.classList.contains('s-done'), 'review not done');

  // Collapse again toggles aria-expanded back + re-hides.
  head.dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  assert.equal(head.getAttribute('aria-expanded'), 'false', 'collapses on second click');
  assert.equal(detail.hidden, true, 'detail re-hidden');
});

test('clicking the title opens the viewer modal (distinct from expand)', async () => {
  let detailFetches = 0;
  const ctx = await boot({
    fetchHandler: (url) => {
      if (url.includes('/api/runs?')) {
        return runsListResponse([{ id: 'p-done', title: 'Done run', status: 'done', startedAt: '2026-01-01T00:00:00Z' }]);
      }
      if (url.includes('/api/runs/p-done')) {
        detailFetches++;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ state: { phase: 'done', status: 'done' }, auditMarkdown: '# saved audit' }) });
      }
      return null;
    },
  });
  ctx.selectProject();
  ctx.showHistory();
  await new Promise((r) => setTimeout(r, 0));

  const doc = ctx.window.document;
  const card = doc.querySelector('#history .hist-card');
  const head = card.querySelector('.hist-head');

  // Click the title -> viewer opens; the head must NOT expand.
  card.querySelector('.h-meta b').dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(head.getAttribute('aria-expanded'), 'false', 'title click did not expand the card');
  const viewer = doc.querySelector('#viewer-card');
  assert.equal(viewer.classList.contains('hidden'), false, 'viewer modal opened');
  assert.match(doc.querySelector('#viewer').textContent, /saved audit/, 'viewer shows the saved markdown');
});

test('keyboard: Enter on the head toggles expand', async () => {
  const ctx = await boot({
    fetchHandler: (url) => {
      if (url.includes('/api/runs?')) {
        return runsListResponse([{ id: 'p-done', title: 'Done run', status: 'done', startedAt: '2026-01-01T00:00:00Z' }]);
      }
      if (url.includes('/api/runs/p-done')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ state: { phase: 'done', status: 'done' } }) });
      }
      return null;
    },
  });
  ctx.selectProject();
  ctx.showHistory();
  await new Promise((r) => setTimeout(r, 0));

  const doc = ctx.window.document;
  const head = doc.querySelector('#history .hist-head');
  head.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(head.getAttribute('aria-expanded'), 'true', 'Enter expands the card');

  // DONE state tints every stage s-done.
  const detail = doc.querySelector('#history .hist-detail');
  const stages = [...detail.querySelectorAll('.stage[data-node-id]')];
  assert.ok(stages.every((s) => s.classList.contains('s-done')), 'DONE tints all stages done');
});

test('pipelines and live runs are merged + deduped by id', async () => {
  const ctx = await boot({
    fetchHandler: (url) => {
      if (url.includes('/api/runs?')) {
        return runsListResponse(
          [{ id: 'p-done', title: 'Done run', status: 'done', startedAt: '2026-01-01T00:00:00Z' }],
          // one NEW live run (surfaces) + one already on disk (deduped away).
          [
            { id: 'live-1', runId: 'live-1', title: 'Live run', status: 'running', live: true },
            { id: 'p-done', runId: 'p-done', title: 'Done run', status: 'done', live: true },
          ],
        );
      }
      return null;
    },
  });
  ctx.selectProject();
  ctx.showHistory();
  await new Promise((r) => setTimeout(r, 0));

  const doc = ctx.window.document;
  const cards = doc.querySelectorAll('#history .hist-card');
  assert.equal(cards.length, 2, 'disk(1) + unique live(1) = 2 (duplicate id deduped)');
  assert.equal(doc.querySelector('#nav-history-count').textContent, '2');

  const badges = [...doc.querySelectorAll('#history .badge')].map((b) => b.textContent);
  assert.ok(badges.includes('RUNNING'), 'the live-only run shows a RUNNING badge');
  const runningBadge = [...doc.querySelectorAll('#history .badge')].find((b) => b.textContent === 'RUNNING');
  assert.ok(runningBadge.classList.contains('running'), 'RUNNING badge uses the .running variant');
});

test('empty history renders a .hist-empty div (no <li>)', async () => {
  const ctx = await boot({
    fetchHandler: (url) => {
      if (url.includes('/api/runs?')) return runsListResponse([], []);
      return null;
    },
  });
  ctx.selectProject();
  ctx.showHistory();
  await new Promise((r) => setTimeout(r, 0));

  const doc = ctx.window.document;
  const empty = doc.querySelector('#history .hist-empty');
  assert.ok(empty, '.hist-empty div present');
  assert.match(empty.textContent, /No saved pipelines/);
  assert.equal(doc.querySelectorAll('#history li').length, 0, 'no <li> in empty state');
  assert.equal(doc.querySelector('#nav-history-count').textContent, '0');
});

test('history load error renders a .hist-empty div (no <li>)', async () => {
  const ctx = await boot({
    fetchHandler: (url) => {
      if (url.includes('/api/runs?')) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
      }
      return null;
    },
  });
  ctx.selectProject();
  ctx.showHistory();
  await new Promise((r) => setTimeout(r, 0));

  const doc = ctx.window.document;
  const empty = doc.querySelector('#history .hist-empty');
  assert.ok(empty, '.hist-empty div present on error');
  assert.match(empty.textContent, /Could not load history: boom/);
  assert.equal(doc.querySelectorAll('#history li').length, 0, 'no <li> in error state');
});

const runsList = (pipelines, live = []) => Promise.resolve({ ok: true, status: 200, json: async () => ({ pipelines, live }) });

test('History card renders the persisted manifest nodes on expand', async () => {
  const customState = {
    status: 'stopped', phase: 'refine', cycle: 1, steps: [],
    stepper: {
      version: 1,
      steps: [
        { kind: 'preflight', nodes: [{ id: 'preflight', label: 'Preflight', sub: 'checks' }] },
        { kind: 'agents', nodes: [{ id: 's0_0', uiPhase: 'plan', label: 'Plan', color: 'violet', cycles: false }] },
        { kind: 'agents', nodes: [{ id: 's1_0', uiPhase: 'refine', label: 'Refine Plan', color: 'green', cycles: true }] },
        { kind: 'agents', nodes: [{ id: 's4_0', uiPhase: 'manual-checklist', label: 'Manual Tests Checklist', color: 'blue', cycles: false }] },
        { kind: 'agents', nodes: [{ id: 's5_0', uiPhase: 'manual-web', label: 'Manual web UI testing', color: 'violet', cycles: false }] },
        { kind: 'done', nodes: [{ id: 'done', label: 'Done', sub: 'complete' }] },
      ],
    },
  };
  const { window, selectProject, showHistory } = await boot({
    fetchHandler: (url) => {
      if (url.includes('/api/runs/')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ state: customState, auditMarkdown: '' }) });
      if (url.includes('/api/runs?')) return runsList([{ id: 'p1', title: 'Custom', status: 'stopped', startedAt: '2026-06-02T00:00:00Z' }]);
      return null;
    },
  });
  selectProject(); showHistory();
  await new Promise((r) => setTimeout(r, 0));
  window.document.querySelector('#history .hist-head').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  const detail = window.document.querySelector('#history .hist-card .hist-detail');
  const labels = [...detail.querySelectorAll('.stage .lbl b, .stage .stage-node b')].map((e) => e.textContent);
  assert.deepEqual(labels, ['Preflight', 'Plan', 'Refine Plan', 'Manual Tests Checklist', 'Manual web UI testing', 'Done']);
  // stopped at refine (cell idx 2) -> that cell is s-stop, earlier done.
  assert.ok(detail.querySelector('.stage[data-node-id="s1_0"]').classList.contains('s-stop'));
  assert.ok(detail.querySelector('.stage[data-node-id="s0_0"]').classList.contains('s-done'));
});

test('History card without a saved manifest still renders the legacy six', async () => {
  const legacyState = { status: 'done', phase: 'done', steps: [] }; // no .stepper
  const { window, selectProject, showHistory } = await boot({
    fetchHandler: (url) => {
      if (url.includes('/api/runs/')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ state: legacyState, auditMarkdown: '' }) });
      if (url.includes('/api/runs?')) return runsList([{ id: 'p1', title: 'Old', status: 'done', startedAt: '2026-06-02T00:00:00Z' }]);
      return null;
    },
  });
  selectProject(); showHistory();
  await new Promise((r) => setTimeout(r, 0));
  window.document.querySelector('#history .hist-head').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  const detail = window.document.querySelector('#history .hist-card .hist-detail');
  const labels = [...detail.querySelectorAll('.stage .lbl b')].map((e) => e.textContent);
  assert.deepEqual(labels, ['Preflight', 'Plan', 'Refine', 'Implement', 'Review', 'Done']);
  assert.ok([...detail.querySelectorAll('.stage')].every((s) => s.classList.contains('s-done')));
});
