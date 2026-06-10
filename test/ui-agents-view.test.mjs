// test/ui-agents-view.test.mjs — jsdom tests for the Agents management view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));

const AGENTS = [
  { key: 'planner', displayName: 'Plan', description: 'architecture', color: 'violet', runnerType: 'producer', consumes: ['userPrompt'], produces: ['plan'], order: 1, origin: 'builtin', connectsTo: '*' },
  { key: 'docsWriter', displayName: 'Docs Writer', description: 'writes docs', color: 'green', runnerType: 'producer', consumes: ['plan'], produces: ['review'], order: 42, origin: 'user', connectsTo: '*' },
];
const CHANNELS = ['userPrompt', 'plan', 'review', 'checklist', 'code', 'workspace', 'clarify', 'decomposition'];

class WSStub {
  constructor() { this.readyState = 1; this.sent = []; this._listeners = {}; WSStub.last = this; }
  send(s) { this.sent.push(typeof s === 'string' ? JSON.parse(s) : s); }
  close() {}
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  _open() { (this._listeners.open || []).forEach((fn) => fn({})); }
  deliver(obj) { (this._listeners.message || []).forEach((fn) => fn({ data: JSON.stringify(obj) })); }
}

async function boot({ fetchHandler } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.WebSocket = WSStub;
  window.confirm = () => true;
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0); // composer paints via rAF (same stub as ui-composer.test.mjs)
  window.fetch = (url, opts) => {
    const u = String(url);
    if (fetchHandler) { const r = fetchHandler(u, opts || {}); if (r) return r; }
    if (u.includes('/api/agents')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ agents: AGENTS, channels: CHANNELS }) });
    if (u.includes('/api/projects')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [] }) });
    if (u.includes('/api/workspaces')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ workspaces: [] }) });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator', 'requestAnimationFrame']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(appPath + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  if (WSStub.last) WSStub.last._open();
  return { window, ws: () => WSStub.last }; // ws accessor: Task 7's wizard tests destructure it
}
const click = (window, node) => node.dispatchEvent(new window.Event('click', { bubbles: true }));
const goAgents = async (window) => {
  window.location.hash = 'agents';
  window.dispatchEvent(new window.Event('hashchange'));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

test('agents view renders grouped cards with origin badges + produces/consumes chips', async () => {
  const { window } = await boot();
  await goAgents(window);
  const doc = window.document;
  assert.equal(doc.querySelector('.view[data-view="agents"]').classList.contains('hidden'), false);
  const cards = [...doc.querySelectorAll('#agents-list .agent-card')];
  assert.equal(cards.length, 2);
  const user = cards.find((c) => c.dataset.agentKey === 'docsWriter');
  assert.equal(user.querySelector('.agent-origin').textContent, 'user');
  assert.ok([...user.querySelectorAll('.agent-chip.prod')].some((n) => n.textContent === 'review'));
  assert.ok([...user.querySelectorAll('.agent-chip.cons')].some((n) => n.textContent === 'plan'));
  const builtin = cards.find((c) => c.dataset.agentKey === 'planner');
  assert.equal(builtin.querySelector('.agent-delete').hidden, true, 'no delete for builtin');
  assert.equal(builtin.querySelector('.agent-edit').hidden, true, 'no edit for builtin');
  assert.equal(builtin.querySelector('.agent-duplicate').hidden, false);
  assert.equal(user.querySelector('.agent-duplicate').hidden, true);
  const labels = [...doc.querySelectorAll('#agents-list .agents-group-label')].map((n) => n.textContent);
  assert.deepEqual(labels, ['Built-in agents', 'Your agents']);
});

test('Delete issues DELETE /api/agents/:key; a 409 keeps the card + surfaces the error', async () => {
  let mode = 409;
  const calls = [];
  const { window } = await boot({
    fetchHandler: (u, opts) => {
      if (u.endsWith('/api/agents/docsWriter') && opts.method === 'DELETE') {
        calls.push(u);
        return mode === 409
          ? Promise.resolve({ ok: false, status: 409, json: async () => ({ error: 'used by saved workflow(s): Uses Docs' }) })
          : Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      }
      return null;
    },
  });
  await goAgents(window);
  const doc = window.document;
  const card = doc.querySelector('.agent-card[data-agent-key="docsWriter"]');
  click(window, card.querySelector('.agent-delete'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 1);
  assert.ok(doc.querySelector('.agent-card[data-agent-key="docsWriter"]'), '409 keeps the card');
  assert.match(doc.querySelector('#agents-msg').textContent, /Uses Docs/);
  mode = 200;
  click(window, doc.querySelector('.agent-card[data-agent-key="docsWriter"] .agent-delete'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(doc.querySelector('.agent-card[data-agent-key="docsWriter"]'), null, '200 removes the card');
});

test('Duplicate on a builtin GETs the full agent then POSTs a copy with a fresh name', async () => {
  const posts = [];
  const { window } = await boot({
    fetchHandler: (u, opts) => {
      if (u.endsWith('/api/agents/planner') && (!opts.method || opts.method === 'GET')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ meta: AGENTS[0], markdown: '# planner body' }) });
      }
      if (u.endsWith('/api/agents') && opts.method === 'POST') {
        posts.push(JSON.parse(opts.body));
        return Promise.resolve({ ok: true, status: 201, json: async () => ({ meta: { ...AGENTS[0], key: 'planCopy', origin: 'user' }, markdown: '# planner body' }) });
      }
      return null;
    },
  });
  await goAgents(window);
  const doc = window.document;
  click(window, doc.querySelector('.agent-card[data-agent-key="planner"] .agent-duplicate'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].meta.displayName, 'Plan (copy)');
  assert.equal(posts[0].meta.key, undefined, 'key derived server-side');
  assert.equal(posts[0].markdown, '# planner body');
});

test('composer save surfaces server warnings via the link-banner toast', async () => {
  const { window } = await boot({
    fetchHandler: (u, opts) => {
      if (u.endsWith('/api/workflows') && opts.method === 'POST') {
        return Promise.resolve({ ok: true, status: 201, json: async () => ({
          workflow: { id: 'wf_warny', name: 'Warny', steps: [[{ id: 's0_0', key: 'planner' }]], feedbacks: [] },
          warnings: ['node "s1_0" consumes "checklist" but no upstream step produces it'],
        }) });
      }
      if (u.endsWith('/api/workflows') && (!opts.method || opts.method === 'GET')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ workflows: [] }) });
      }
      if (u.includes('/api/workflows/')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ id: 'wf_default', name: 'Default', steps: [[{ id: 's0_0', key: 'planner' }]], feedbacks: [] }) });
      }
      return null;
    },
  });
  window.prompt = () => 'Warny';
  window.location.hash = 'composer';
  window.dispatchEvent(new window.Event('hashchange'));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const doc = window.document;
  assert.ok(window.__composer.steps.length >= 1, 'canvas seeded from default');
  click(window, doc.querySelector('#composer-save'));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.match(doc.querySelector('#composer-link-text').textContent, /consumes "checklist"/, 'warning toasted');
  assert.equal(doc.querySelector('#composer-link-banner').hidden, false);
});
