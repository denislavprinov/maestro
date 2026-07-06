import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, '../apps/enable/public/index.html');
const appPath = join(here, '../apps/enable/public/app.js');

class FakeWS {
  constructor(url) { FakeWS.last = this; this.url = url; this.closed = false; }
  close() { this.closed = true; }
  send() {}
}

async function bootEnable() {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4319/' });
  const { window } = dom;
  window.WebSocket = FakeWS;
  const CHANGES_FIXTURE = {
    summary: { filesNew: 2, filesChanged: 1, filesDeleted: 0, linesAdded: 10, linesRemoved: 1 },
    newFiles: [{ path: 'CLAUDE.md', status: 'A', added: 9, removed: 0 },
               { path: '.cursor/rules/x.mdc', status: 'A', added: 1, removed: 0 }],
    changedFiles: [{ path: 'package.json', status: 'M', added: 1, removed: 1 }],
    nitpicks: [],
    patch: 'diff --git a/CLAUDE.md b/CLAUDE.md\n+hello\n',
  };
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('/changes')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => CHANGES_FIXTURE });
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
  // app.js was imported after the DOM finished parsing, so fire the boot event by hand
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  return { window, document: window.document };
}

async function startRun(document) {
  document.querySelector('#project-path').value = '/x/proj';
  document.querySelector('#setup-form').dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));   // let async start() finish
  return FakeWS.last;
}

function frame(ws, obj) { ws.onmessage({ data: JSON.stringify(obj) }); }

test('renderer ignores frames from a different runId', async () => {
  const { document } = await bootEnable();
  const ws = await startRun(document);
  assert.ok(ws, 'a WebSocket must have been opened');
  assert.match(ws.url, /runId=run-A/);

  const score = () => document.querySelector('#ring-score').textContent;
  assert.equal(score(), '—');

  frame(ws, { type: 'readiness', kind: 'baseline', score: 40, runId: 'run-B' }); // foreign
  assert.equal(score(), '—', 'foreign-run frame must not move the ring');

  frame(ws, { type: 'readiness', kind: 'baseline', score: 40, runId: 'run-A' }); // own
  assert.equal(score(), '40');
});

test('final readiness frame shows the branch on the results screen', async () => {
  const { document } = await bootEnable();
  const ws = await startRun(document);
  frame(ws, { type: 'readiness', kind: 'final', score: 93, baselineScore: 28, delta: 65,
    dimensions: {}, gaps: [], branch: 'maestro/enable-project-for-ai-ab12cd34', runId: 'run-A' });
  assert.equal(document.querySelector('#results').classList.contains('active'), true);
  assert.equal(document.querySelector('#result-branch').textContent,
    'Branch: maestro/enable-project-for-ai-ab12cd34');
  assert.match(document.querySelector('#hero').textContent, /28 → 93 \(\+65\)/);
});

test('results screen renders the What-changed panel from the changes route', async () => {
  const { document } = await bootEnable();
  const ws = await startRun(document);
  frame(ws, { type: 'readiness', kind: 'final', score: 93, baselineScore: 28, delta: 65,
    dimensions: {}, gaps: [], branch: 'maestro/x', runId: 'run-A' });
  await new Promise((r) => setTimeout(r, 0));   // let the changes fetch resolve

  const wrap = document.querySelector('#changes-wrap');
  assert.ok(wrap, '#changes-wrap must exist in the results screen');
  assert.equal(wrap.hidden, false);
  assert.match(document.querySelector('#changes-summary').textContent, /2 new files/);
  assert.match(document.querySelector('#changes-summary').textContent, /1 changed/);
  assert.match(document.querySelector('#changes-files').textContent, /CLAUDE\.md/);
  assert.match(document.querySelector('#changes-files').textContent, /package\.json/);

  const toggle = document.querySelector('#patch-toggle');
  const view = document.querySelector('#patch-view');
  assert.equal(view.hidden, true);
  toggle.click();
  assert.equal(view.hidden, false);
  assert.match(view.textContent, /diff --git a\/CLAUDE\.md/);
});

test('starting a new run closes the previous run socket', async () => {
  const { document } = await bootEnable();
  const first = await startRun(document);
  const second = await startRun(document);
  assert.notEqual(first, second);
  assert.equal(first.closed, true, 'stale socket from the previous run must be closed');
});
