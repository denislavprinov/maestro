// Renderer pause/resume affordances: pause button lifecycle, paused banner with
// Resume, and Resume buttons on resumable history entries.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '../apps/enable/public/index.html'), 'utf8');
const appUrl = () => join(here, '../apps/enable/public/app.js') + `?b=${Date.now()}_${Math.random()}`;

class FakeWS { constructor(url) { FakeWS.last = this; this.url = url; } close() {} send() {} }

// close every JSDOM window this file opens so the process can exit cleanly
const openDoms = [];
after(() => { for (const dom of openDoms) { try { dom.window.close(); } catch {} } });

async function boot({ history = [], onFetch = () => null } = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost:4319/' });
  openDoms.push(dom);
  const { window } = dom;
  window.WebSocket = FakeWS;
  const calls = [];
  window.fetch = (url, opts) => {
    calls.push({ url: String(url), opts });
    const custom = onFetch(String(url), opts);
    if (custom) return Promise.resolve(custom);
    if (String(url).includes('/api/enable/history')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ runs: history }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ root: '/x', projects: [], runs: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(appUrl());
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  return { window, calls };
}

test('paused frame shows the banner (winding-down) with Resume disabled; done{paused} enables it', async () => {
  const { window } = await boot();
  const w = window;
  // simulate an active run: elements exist statically in index.html
  w.document.querySelector('#pause-btn').hidden = false;
  // drive the frame handler through a fake WS message via the exposed handler path:
  // renderers attach ws.onmessage in connectRun; instead dispatch through handleFrame
  // exported on window for tests.
  w.__enableTest.setRun('run-1', 'pl-1');
  w.__enableTest.handle({ type: 'paused', runId: 'run-1' });
  assert.equal(w.document.querySelector('#paused-banner').hidden, false);
  assert.equal(w.document.querySelector('#pause-btn').hidden, true);
  // synthetic frame = engine still winding down; Resume must not be usable yet
  assert.equal(w.document.querySelector('#resume-btn').disabled, true);

  w.__enableTest.handle({ type: 'done', status: 'paused', runId: 'run-1' });
  assert.equal(w.document.querySelector('#paused-banner').hidden, false);
  assert.equal(w.document.querySelector('#resume-btn').disabled, false);
});

test('done{paused} also lands on the banner, not the error screen', async () => {
  const { window: w } = await boot();
  w.__enableTest.setRun('run-1', 'pl-1');
  w.__enableTest.handle({ type: 'done', status: 'paused', runId: 'run-1' });
  assert.equal(w.document.querySelector('#paused-banner').hidden, false);
  assert.equal(w.document.querySelector('#resume-btn').disabled, false);
  assert.equal(w.document.querySelector('#errored').classList.contains('active'), false);
});

test('resume button POSTs /api/enable/resume with the pipeline id and current mock/interactive toggles', async () => {
  let resumeBody = null;
  const { window: w } = await boot({
    onFetch: (url, opts) => {
      if (url.includes('/api/enable/resume')) {
        resumeBody = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ runId: 'run-2', pipelineId: 'pl-1' }) };
      }
      return null;
    },
  });
  w.__enableTest.setRun('run-1', 'pl-1');
  w.__enableTest.handle({ type: 'paused', runId: 'run-1' });
  // engine confirms the actual pause before Resume is usable
  w.__enableTest.handle({ type: 'done', status: 'paused', runId: 'run-1' });
  w.document.querySelector('#mock-toggle').checked = true;
  w.document.querySelector('#interactive-toggle').checked = true;
  w.document.querySelector('#resume-btn').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(resumeBody, { pipelineId: 'pl-1', mock: true, interactive: true });
  assert.ok(FakeWS.last.url.includes('runId=run-2'), 'reconnected on the new runId');
});

test('history renders a Resume button only on resumable entries', async () => {
  const mk = (id, status, resumable) => ({ id, dir: `/s/${id}`, title: 'Enable project for AI',
    status, resumable, startedAt: '2026-07-10T10:00:00Z', projectName: `p-${id}`, readiness: null });
  const { window: w } = await boot({ history: [mk('aa', 'paused', true), mk('bb', 'done', false)] });
  const items = [...w.document.querySelectorAll('#history-list li')];
  assert.equal(items.length, 2);
  assert.ok(items[0].querySelector('.hist-resume'), 'paused entry has Resume');
  assert.ok(!items[1].querySelector('.hist-resume'), 'done entry has none');
});
