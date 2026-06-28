// test/ui-running-pause-fixes.test.mjs — regressions in the Running tab around a
// PAUSED run: (a) Resume button placement (CSS), (c) paused frontier node kind,
// (d) branch name on the run card. Harness mirrors ui-pause-resume.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, '../ui/public/index.html');
const appPath = join(here, '../ui/public/app.js');
const cssPath = join(here, '../ui/public/style.css');

async function bootLive() {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.WebSocket = class {
    constructor() { this.readyState = 1; this._listeners = {}; }
    send() {} close() {}
    addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  };
  window.fetch = (url) => {
    if (String(url).includes('/api/projects')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [] }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(appPath + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  return { window };
}

// (a) Resume button placement — it must right-align like Pause/Stop, not drift left.
test('(a) .btn-resume.sm right-aligns via margin-left:auto, like .btn-pause.sm', () => {
  const css = readFileSync(cssPath, 'utf8');
  const m = css.match(/\.btn-resume\.sm\s*\{([^}]*)\}/);
  assert.ok(m, '.btn-resume.sm rule missing — Resume button has no small-footer styling');
  assert.match(m[1], /margin-left:\s*auto/, '.btn-resume.sm must right-align like .btn-pause.sm');
});

// (c) A paused run's frontier node must read as paused, not "running…".
test('(c) nodeKindFor maps paused/pausing run status to the paused node kind', async () => {
  const { window } = await bootLive();
  const { nodeKindFor } = window.__np;
  assert.equal(nodeKindFor({ status: 'paused', pendingQuestion: null }, 'running'), 'pause');
  assert.equal(nodeKindFor({ status: 'pausing', pendingQuestion: null }, 'running'), 'pause');
  // a live run is unaffected
  assert.equal(nodeKindFor({ status: 'running', pendingQuestion: null }, 'running'), 'now');
  // done status still wins for a live run
  assert.equal(nodeKindFor({ status: 'running', pendingQuestion: null }, 'done'), 'done');
});

// (d) Branch name shows on the run card and survives a later state event.
test('(d) run-card meta renders branch feature and refreshes when branch arrives via onState', async () => {
  const { window } = await bootLive();
  const { upsertRun, buildRunCard, onState } = window.__np;
  const r = upsertRun({ runId: 'rb1', title: 't', projectDir: '/tmp/proj', status: 'running' });
  r.el = buildRunCard(r);
  const meta = () => r.el.querySelector('.rm-text').textContent;
  assert.doesNotMatch(meta(), /feat\/x/, 'no branch before it is known');
  // Branch arrives on a later state snapshot — the meta line must refresh.
  onState(r, { branch: { feature: 'feat/x' } });
  assert.match(meta(), /feat\/x/, 'branch feature must appear in the meta line after onState');
});
