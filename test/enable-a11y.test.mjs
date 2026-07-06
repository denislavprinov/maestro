// Accessibility (v2): keyboard operability, focus management on screen
// switches, and screen-reader announcements for live run state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, '../apps/enable/public/index.html');
const appPath = join(here, '../apps/enable/public/app.js');
const tick = () => new Promise((r) => setTimeout(r, 0));

class FakeWS {
  constructor(url) { FakeWS.last = this; this.url = url; this.closed = false; }
  close() { this.closed = true; }
  send() {}
}

const HISTORY_ENTRY = {
  id: 'ab12cd34', dir: '/store/p/ab12cd34', title: 'Enable project for AI',
  status: 'done', startedAt: '2026-07-06T15:00:00Z', branch: 'maestro/x',
  projectName: 'tinytool', readiness: { score: 91, baselineScore: 30, delta: 61, dimensions: {}, gaps: [] },
};

async function bootEnable() {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4319/' });
  const { window } = dom;
  window.WebSocket = FakeWS;
  window.fetch = (url) => {
    const u = String(url);
    if (u.includes('/api/enable/history/ab12cd34')) {
      return Promise.resolve({ ok: true, status: 200, json: async () =>
        ({ entry: HISTORY_ENTRY, readiness: HISTORY_ENTRY.readiness, changes: null }) });
    }
    if (u.includes('/api/enable/history')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ runs: [HISTORY_ENTRY] }) });
    }
    if (u.includes('/api/enable/run')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ runId: 'run-A' }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ root: '/x', projects: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(appPath + `?b=${Date.now()}_${Math.random()}`);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  await tick();
  return { window, document: window.document };
}

function frame(obj) { FakeWS.last.onmessage({ data: JSON.stringify(obj) }); }

test('history rows are real buttons (keyboard reachable)', async () => {
  const { document } = await bootEnable();
  const btn = document.querySelector('#history-list li button');
  assert.ok(btn, 'each history row must contain a button');
  assert.match(btn.textContent, /tinytool/);
  btn.click();
  await tick();
  assert.equal(document.querySelector('#results').classList.contains('active'), true);
});

test('switching screens moves focus to the screen heading', async () => {
  const { document } = await bootEnable();
  document.querySelector('#project-path').value = '/x/proj';
  document.querySelector('#go-setup').click();
  const heading = document.querySelector('#setup h2');
  assert.equal(heading.getAttribute('tabindex'), '-1', 'headings must be focusable targets');
  assert.equal(document.activeElement, heading, 'focus lands on the set-up heading');
});

test('run status changes are announced via a live region', async () => {
  const { document } = await bootEnable();
  document.querySelector('#project-path').value = '/x/proj';
  document.querySelector('#setup-form').dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();

  const status = document.querySelector('#sr-status');
  assert.ok(status, 'progress screen needs an #sr-status element');
  assert.equal(status.getAttribute('aria-live'), 'polite');

  frame({ type: 'readiness', kind: 'baseline', score: 40, runId: 'run-A' });
  assert.match(status.textContent, /40/);
  frame({ type: 'readiness', kind: 'cycle', cycle: 2, score: 71, runId: 'run-A' });
  assert.match(status.textContent, /71/);
});

test('details/patch toggles expose aria-expanded', async () => {
  const { document } = await bootEnable();
  const toggle = document.querySelector('#details-toggle');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-controls'), 'raw-log');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(document.querySelector('#patch-toggle').getAttribute('aria-controls'), 'patch-view');
});

test('free-text inputs carry accessible names; heading order has no h1->h3 skip', async () => {
  const { document } = await bootEnable();
  for (const el of document.querySelectorAll('input.free')) {
    assert.ok(el.getAttribute('aria-label'), `free input ${el.dataset.free} needs an aria-label`);
  }
  assert.ok(document.getElementById('project-path').getAttribute('aria-label') ||
    document.querySelector('label [id="project-path"], label #project-path'),
    'project path input must be labelled');
  const historyHeading = document.querySelector('#history-wrap h2');
  assert.ok(historyHeading, 'past-runs heading must be an h2 (was h3 under an h1)');
});

test('journey + ring are hidden from the accessibility tree (sr-status speaks instead)', async () => {
  const { document } = await bootEnable();
  assert.equal(document.querySelector('#journey').getAttribute('aria-hidden'), 'true');
  assert.equal(document.querySelector('.ring-wrap').getAttribute('aria-hidden'), 'true');
});
