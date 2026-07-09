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

async function bootEnable(opts = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4319/' });
  const { window } = dom;
  window.WebSocket = FakeWS;
  const CHANGES_FIXTURE = opts.changes || {
    summary: { filesNew: 2, filesChanged: 1, filesDeleted: 0, linesAdded: 10, linesRemoved: 1 },
    newFiles: [{ path: 'CLAUDE.md', status: 'A', added: 9, removed: 0 },
               { path: '.cursor/rules/x.mdc', status: 'A', added: 1, removed: 0 }],
    changedFiles: [{ path: 'package.json', status: 'M', added: 1, removed: 1 }],
    nitpicks: [],
    patch: 'diff --git a/CLAUDE.md b/CLAUDE.md\n+hello\n',
  };
  const HISTORY_ENTRY = {
    id: 'ab12cd34', dir: '/store/p/ab12cd34', title: 'Enable project for AI',
    status: 'done', startedAt: '2026-07-06T15:00:00Z', branch: 'maestro/enable-project-for-ai-ab12cd34',
    projectName: 'tinytool', readiness: { score: 91, baselineScore: 30, delta: 61, dimensions: {}, gaps: [] },
  };
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('/api/enable/history/ab12cd34')) {
      return Promise.resolve({ ok: true, status: 200, json: async () =>
        ({ entry: HISTORY_ENTRY, readiness: HISTORY_ENTRY.readiness, changes: CHANGES_FIXTURE }) });
    }
    if (u.includes('/api/enable/history')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ runs: [HISTORY_ENTRY] }) });
    }
    if (u.includes('/api/enable/browse')) {
      const m = u.match(/dir=([^&]*)/);
      const dir = m ? decodeURIComponent(m[1]) : '/home/user';
      if (dir === '/home/user/proj') {
        return Promise.resolve({ ok: true, status: 200, json: async () =>
          ({ dir: '/home/user/proj', parent: '/home/user', entries: [] }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () =>
        ({ dir: '/home/user', parent: '/home', entries: [
          { name: 'proj', path: '/home/user/proj', isGit: true },
          { name: 'docs', path: '/home/user/docs', isGit: false }] }) });
    }
    if (u.includes('/changes')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => CHANGES_FIXTURE });
    }
    if (u.includes('/api/enable/branches')) {
      return Promise.resolve({ ok: true, status: 200, json: async () =>
        ({ branches: ['main', 'feature-x'], current: 'main' }) });
    }
    if (u.includes('/api/enable/run')) {
      try { globalThis.__lastRunBody = JSON.parse(opts.body); } catch {}
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
const tick = () => new Promise((r) => setTimeout(r, 0));

// A two-file patch so per-file splitting / modal sections are observable.
const MULTI_CHANGES = {
  summary: { filesNew: 1, filesChanged: 1, filesDeleted: 0, linesAdded: 2, linesRemoved: 1 },
  newFiles: [{ path: 'CLAUDE.md', status: 'A', added: 1, removed: 0 }],
  changedFiles: [{ path: 'package.json', status: 'M', added: 1, removed: 1 }],
  nitpicks: [],
  patch: [
    'diff --git a/CLAUDE.md b/CLAUDE.md',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/CLAUDE.md',
    '@@ -0,0 +1 @@',
    '+hello world',
    'diff --git a/package.json b/package.json',
    'index 2222222..3333333 100644',
    '--- a/package.json',
    '+++ b/package.json',
    '@@ -1 +1 @@',
    '-old line',
    '+new line',
    '',
  ].join('\n'),
};

// Drive a run to the results screen with the What-changed panel populated.
async function toResults(document, over = {}) {
  const ws = await startRun(document);
  frame(ws, { type: 'readiness', kind: 'final', score: 93, baselineScore: 28, delta: 65,
    dimensions: {}, gaps: [], branch: 'maestro/x', runId: 'run-A', ...over });
  await tick();
  return ws;
}

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
  assert.match(document.querySelector('#hero .score-before').textContent, /28/);
  assert.match(document.querySelector('#hero .score-after').textContent, /93/);
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

  const modal = document.querySelector('#diff-modal');
  assert.equal(modal.hidden, true);
  document.querySelector('#patch-toggle').click();
  assert.equal(modal.hidden, false);
  assert.match(document.querySelector('#diff-pane').textContent, /diff --git a\/CLAUDE\.md/);
});

test('patch view colors added/removed lines and file status glyphs', async () => {
  const { document } = await bootEnable();
  await toResults(document);
  document.querySelector('#patch-toggle').click();

  const pane = document.querySelector('#diff-pane');
  assert.ok(pane.querySelector('.diff-add'), 'added lines get a .diff-add span');
  assert.match(pane.querySelector('.diff-add').textContent, /\+hello/);
  assert.ok(pane.querySelector('.diff-meta'), 'diff --git header line gets a .diff-meta span');

  const files = document.querySelector('#changes-files');
  const added = files.querySelector('.file-status.status-A');
  const changed = files.querySelector('.file-status.status-M');
  assert.ok(added, 'new-file rows carry a status-A class for coloring');
  assert.ok(changed, 'changed-file rows carry a status-M class for coloring');
});

test('home lists past runs; clicking one opens the results view from disk', async () => {
  const { document } = await bootEnable();
  const wrap = document.querySelector('#history-wrap');
  assert.ok(wrap, '#history-wrap must exist on the home screen');
  assert.equal(wrap.hidden, false);
  const item = document.querySelector('#history-list li .hist-btn');
  assert.ok(item, 'one history row button (keyboard reachable)');
  assert.match(item.textContent, /tinytool/);
  assert.match(item.textContent, /91/);

  item.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(document.querySelector('#results').classList.contains('active'), true);
  assert.match(document.querySelector('#hero .score-before').textContent, /30/);
  assert.match(document.querySelector('#hero .score-after').textContent, /91/);
  assert.match(document.querySelector('#result-branch').textContent, /enable-project-for-ai-ab12cd34/);
  assert.match(document.querySelector('#changes-summary').textContent, /2 new files/);
});

test('Show patch opens a full-screen diff modal with one section per file', async () => {
  const { document } = await bootEnable({ changes: MULTI_CHANGES });
  await toResults(document);

  const modal = document.querySelector('#diff-modal');
  assert.ok(modal, '#diff-modal must exist');
  assert.equal(modal.hidden, true, 'modal is closed until asked for');

  document.querySelector('#patch-toggle').click();
  assert.equal(modal.hidden, false, 'Show patch opens the modal');

  const sections = modal.querySelectorAll('section[id^="diff-file-"]');
  assert.equal(sections.length, 2, 'one <section> per file in the patch');
  assert.ok(document.querySelector('#diff-file-0'), 'first file section');
  assert.ok(document.querySelector('#diff-file-1'), 'second file section');
  // each section carries a sticky per-file path header and its own patch body
  assert.match(document.querySelector('#diff-file-0').textContent, /CLAUDE\.md/);
  assert.match(document.querySelector('#diff-file-1').textContent, /package\.json/);
  assert.ok(document.querySelector('#diff-file-1 .diff-del'), 'removed line colored in the right file');
});

test('clicking a file row opens the modal focused on that file', async () => {
  const { window, document } = await bootEnable({ changes: MULTI_CHANGES });
  const scrolled = [];
  window.Element.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this); };
  await toResults(document);

  const modal = document.querySelector('#diff-modal');
  assert.equal(modal.hidden, true, 'modal starts closed');
  const row = [...document.querySelectorAll('#changes-files .file-row')]
    .find((li) => li.dataset.path === 'package.json');
  assert.ok(row, 'package.json file row exists');
  row.click();

  assert.equal(modal.hidden, false, 'clicking a file row opens the modal');
  assert.equal(scrolled[scrolled.length - 1], document.querySelector('#diff-file-1'),
    'scrollIntoView fired on the clicked file section');
  assert.equal(document.querySelector('.diff-file-item.active').dataset.idx, '1',
    'the clicked file is the active sidebar entry');
  assert.ok(document.querySelector('#diff-file-1').classList.contains('flash'),
    'the focused section gets a highlight flash');
});

test('Esc, backdrop and ✕ all close the diff modal', async () => {
  const { window, document } = await bootEnable({ changes: MULTI_CHANGES });
  await toResults(document);
  const modal = document.querySelector('#diff-modal');

  document.querySelector('#patch-toggle').click();
  assert.equal(modal.hidden, false);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(modal.hidden, true, 'Esc closes');

  document.querySelector('#patch-toggle').click();
  document.querySelector('.diff-modal-backdrop').click();
  assert.equal(modal.hidden, true, 'backdrop click closes');

  document.querySelector('#patch-toggle').click();
  document.querySelector('#diff-modal-close').click();
  assert.equal(modal.hidden, true, '✕ closes');
});

test('per-dimension rows render ghost (baseline) and current bars at distinct widths', async () => {
  const { document } = await bootEnable();
  const ws = await startRun(document);
  frame(ws, { type: 'readiness', kind: 'baseline', score: 20, dimensions: { docs: 20 }, runId: 'run-A' });
  frame(ws, { type: 'readiness', kind: 'final', score: 90, baselineScore: 20, delta: 70,
    dimensions: { docs: 90 }, gaps: [], branch: 'x', runId: 'run-A' });
  await tick();

  const row = document.querySelector('.bar');
  const ghost = row.querySelector('.bar-ghost');
  const cur = row.querySelector('.bar-current');
  assert.ok(ghost && cur, 'both a ghost baseline bar and a current bar render');
  assert.match(cur.style.width, /90%/, 'current bar sized to the current value');
  assert.match(ghost.style.width, /20%/, 'ghost bar sized to the baseline value');
  assert.notEqual(ghost.style.width, cur.style.width, 'distinct widths make the delta obvious');
});

test('hero splits before/after into muted and accent chips', async () => {
  const { document } = await bootEnable();
  await toResults(document, { score: 95, baselineScore: 12, delta: 83 });
  const hero = document.querySelector('#hero');
  const before = hero.querySelector('.score-before');
  const after = hero.querySelector('.score-after');
  assert.ok(before && after, 'before and after chips both render');
  assert.match(before.textContent, /12/);
  assert.match(after.textContent, /95/);
});

test('file rows show a two-segment added/removed stat bar', async () => {
  const { document } = await bootEnable();
  await toResults(document);
  const row = document.querySelector('#changes-files .file-row');
  assert.ok(row.querySelector('.stat-add'), 'green added segment');
  assert.ok(row.querySelector('.stat-del'), 'red removed segment');
});

test('Browse opens a folder picker listing sub-folders', async () => {
  const { document } = await bootEnable();
  const modal = document.querySelector('#picker-modal');
  assert.ok(modal, '#picker-modal must exist');
  assert.equal(modal.hidden, true, 'picker starts closed');

  document.querySelector('#browse-btn').click();
  await tick();
  assert.equal(modal.hidden, false, 'Browse opens the picker');
  assert.equal(document.querySelector('#picker-path').textContent, '/home/user');
  const items = [...document.querySelectorAll('.picker-item')].map((li) => li.dataset.path);
  assert.deepEqual(items, ['/home/user/proj', '/home/user/docs']);
});

test('choosing a folder fills the project path and closes the picker', async () => {
  const { document } = await bootEnable();
  document.querySelector('#browse-btn').click();
  await tick();
  document.querySelector('.picker-item[data-path="/home/user/proj"]').click();
  await tick();
  assert.equal(document.querySelector('#picker-path').textContent, '/home/user/proj',
    'clicking a folder descends into it');

  document.querySelector('#picker-choose').click();
  assert.equal(document.querySelector('#project-path').value, '/home/user/proj',
    'Use-this-folder fills the project path input');
  assert.equal(document.querySelector('#picker-modal').hidden, true, 'picker closes after choosing');
});

test('Esc closes the folder picker', async () => {
  const { window, document } = await bootEnable();
  document.querySelector('#browse-btn').click();
  await tick();
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(document.querySelector('#picker-modal').hidden, true);
});

test('picking a project lists its branches; the run posts the chosen sourceBranch', async () => {
  const { window, document } = await bootEnable();
  document.querySelector('#project-path').value = '/home/user/proj';
  document.querySelector('#project-path').dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick();

  const field = document.querySelector('#branch-field');
  const sel = document.querySelector('#source-branch');
  assert.equal(field.hidden, false, 'branch field shows once branches load');
  assert.deepEqual([...sel.options].map((o) => o.value), ['main', 'feature-x']);
  assert.equal(sel.value, 'main', 'defaults to the current branch');

  sel.value = 'feature-x';
  document.querySelector('#setup-form').dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(globalThis.__lastRunBody.sourceBranch, 'feature-x',
    'the run posts the chosen source branch');
});

test('history rows have a delete control: confirm -> DELETE -> list reload', async () => {
  const { window, document } = await bootEnable();
  const calls = [];
  const origFetch = window.fetch;
  window.fetch = globalThis.fetch = (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET' });
    if (opts.method === 'DELETE') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    }
    return origFetch(url, opts);
  };
  window.confirm = () => true;

  const del = document.querySelector('#history-list li .hist-delete');
  assert.ok(del, 'each history row needs a delete button');
  assert.match(del.getAttribute('aria-label') || '', /delete/i);
  del.click();
  await new Promise((r) => setTimeout(r, 0));

  const sent = calls.find((c) => c.method === 'DELETE');
  assert.ok(sent, 'DELETE request sent');
  assert.match(sent.url, /\/api\/enable\/history\/ab12cd34$/);
  assert.ok(calls.some((c) => c.method === 'GET' && /\/api\/enable\/history(?!\/)/.test(c.url)),
    'history reloaded after delete');
});

test('history delete is a no-op when the confirm dialog is declined', async () => {
  const { window, document } = await bootEnable();
  const calls = [];
  const origFetch = window.fetch;
  window.fetch = globalThis.fetch = (url, opts = {}) => {
    calls.push({ method: opts.method || 'GET' });
    return origFetch(url, opts);
  };
  window.confirm = () => false;
  document.querySelector('#history-list li .hist-delete').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(!calls.some((c) => c.method === 'DELETE'), 'no DELETE without confirmation');
});

test('starting a new run closes the previous run socket', async () => {
  const { document } = await bootEnable();
  const first = await startRun(document);
  const second = await startRun(document);
  assert.notEqual(first, second);
  assert.equal(first.closed, true, 'stale socket from the previous run must be closed');
});
