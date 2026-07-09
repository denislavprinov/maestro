// Interactive gate UI (v2): engine gate/recovery questions surface in the
// renderer instead of being auto-answered, when the run opts in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { wireGateAnswers } from '../src/core/onboarding.mjs';

// ---------- unit: answer wiring ----------

function stubOrch() {
  const orch = new EventEmitter();
  orch.answered = [];
  orch.answer = (id, payload) => orch.answered.push({ id, payload });
  return orch;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('non-interactive: clarify/gate/recovery all auto-answered', async () => {
  const orch = stubOrch();
  wireGateAnswers(orch, new EventEmitter(), { answers: { testTier: 'scaffold' } });
  orch.emit('question', { id: 'clarify-1', kind: 'clarify', questions: [{ id: 'testTier' }] });
  orch.emit('question', { id: 'gate-fb_eval-3', kind: 'gate', issues: [] });
  orch.emit('question', { id: 'recovery-x', kind: 'recovery' });
  await tick();
  assert.deepEqual(orch.answered.map((a) => a.id), ['clarify-1', 'gate-fb_eval-3', 'recovery-x']);
  assert.deepEqual(orch.answered[0].payload, { answers: [{ id: 'testTier', choice: 'scaffold' }] });
  assert.deepEqual(orch.answered[1].payload, { decision: 'continue' });
  assert.deepEqual(orch.answered[2].payload, { decision: 'abort' });
});

test('interactive: clarify still auto-answered; gate/recovery left pending', async () => {
  const orch = stubOrch();
  wireGateAnswers(orch, new EventEmitter(), { answers: { testTier: 'scaffold' }, interactive: true });
  orch.emit('question', { id: 'clarify-1', kind: 'clarify', questions: [{ id: 'testTier' }] });
  orch.emit('question', { id: 'gate-fb_eval-3', kind: 'gate', issues: [] });
  orch.emit('question', { id: 'recovery-x', kind: 'recovery' });
  await tick();
  assert.deepEqual(orch.answered.map((a) => a.id), ['clarify-1']);
});

// ---------- renderer: gate card ----------

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
  const posts = [];
  window.fetch = (url, opts) => {
    const u = String(url);
    if (opts && opts.method === 'POST') posts.push({ url: u, body: JSON.parse(opts.body) });
    if (u.includes('/api/enable/answer')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    }
    if (u.includes('/api/enable/run')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ runId: 'run-A' }) });
    }
    if (u.includes('/api/enable/history')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ runs: [] }) });
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
  return { window, document: window.document, posts };
}

async function startRun(document) {
  document.querySelector('#project-path').value = '/x/proj';
  document.querySelector('#setup-form').dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  return FakeWS.last;
}

function frame(ws, obj) { ws.onmessage({ data: JSON.stringify(obj) }); }

test('interactive toggle is sent with the run request', async () => {
  const { document, posts } = await bootEnable();
  document.querySelector('#interactive-toggle').checked = true;
  await startRun(document);
  const run = posts.find((p) => p.url.includes('/api/enable/run'));
  assert.equal(run.body.interactive, true);
});

test('gate question shows the card; choosing posts the decision and hides it', async () => {
  const { document, posts } = await bootEnable();
  const ws = await startRun(document);
  const wrap = document.querySelector('#gate-wrap');
  assert.ok(wrap, '#gate-wrap must exist in the progress screen');
  assert.equal(wrap.hidden, true);

  frame(ws, { type: 'question', id: 'gate-fb_eval-3', kind: 'gate', runId: 'run-A',
    issues: [{ severity: 'critical', title: 'CLAUDE.md misstates the build command' }] });
  assert.equal(wrap.hidden, false);
  assert.match(document.querySelector('#gate-issues').textContent, /misstates the build command/);

  document.querySelector('#gate-primary').click();      // "Fix another round"
  await tick();
  const post = posts.find((p) => p.url.includes('/api/enable/answer'));
  assert.ok(post, 'answer POST sent');
  assert.equal(post.body.runId, 'run-A');
  assert.equal(post.body.id, 'gate-fb_eval-3');
  assert.deepEqual(post.body.payload, { decision: 'another' });
  assert.equal(wrap.hidden, true, 'card hides after answering');
});

test('recovery question offers retry/stop; question-answered frame hides the card', async () => {
  const { document, posts } = await bootEnable();
  const ws = await startRun(document);
  const wrap = document.querySelector('#gate-wrap');

  frame(ws, { type: 'question', id: 'recovery-1', kind: 'recovery', runId: 'run-A' });
  assert.equal(wrap.hidden, false);

  document.querySelector('#gate-secondary').click();    // "Stop the run"
  await tick();
  const post = posts.find((p) => p.url.includes('/api/enable/answer'));
  assert.deepEqual(post.body.payload, { decision: 'abort' });

  // replay path: an answered frame (e.g. answered from another tab) hides the card
  frame(ws, { type: 'question', id: 'recovery-2', kind: 'recovery', runId: 'run-A' });
  assert.equal(wrap.hidden, false);
  frame(ws, { type: 'question-answered', id: 'recovery-2', runId: 'run-A' });
  assert.equal(wrap.hidden, true);
});

test('clarify questions never show the gate card (auto-answered upstream)', async () => {
  const { document } = await bootEnable();
  const ws = await startRun(document);
  frame(ws, { type: 'question', id: 'clarify-1', kind: 'clarify', runId: 'run-A', questions: [] });
  assert.equal(document.querySelector('#gate-wrap').hidden, true);
});
