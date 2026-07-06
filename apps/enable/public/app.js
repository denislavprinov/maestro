'use strict';

const DIMENSION_LABELS = { docs: 'Documentation', skillsAgents: 'Custom skills', rules: 'Guardrails',
  tests: 'Test setup', featureSkillCoverage: 'Key-workflow coverage', realTests: 'Working tests',
  vendoring: 'Bundled skills', multiTool: 'Cross-tool support', codeHealth: 'Code health' };

const STAGES = [
  { node: 's_clarify', label: 'Set up',     color: '#e5484d' },
  { node: 's_analyze', label: 'Understand', color: '#4493f8' },
  { node: 's_infra',   label: 'Build',      color: '#46d39a' },
  { node: 's_tests',   label: 'Add tests',  color: '#f2a25c' },
  { node: 's_eval',    label: 'Review',     color: '#f5b833' },
  { node: 's_canary',  label: 'Test-drive', color: '#46d39a' },
];

// The 5 fixed set-up questions. value === the choice string sent to the engine.
const SETUP_QUESTIONS = {
  testTier: { type: 'single', options: [
    { value: 'scaffold', label: 'Scaffold (recommended)' }, { value: 'docs-only', label: 'Docs only' },
    { value: 'smoke', label: 'Smoke tests' }, { value: 'characterization', label: 'Characterization' }] },
  vendoringDepth: { type: 'single', options: [
    { value: 'full', label: 'Full (recommended)' }, { value: 'baseline-only', label: 'Baseline only' },
    { value: 'none', label: 'None' }] },
  multiToolTargets: { type: 'multi', options: [
    { value: 'claude', label: 'Claude (CLAUDE.md)', locked: true }, { value: 'cursor', label: 'Cursor' },
    { value: 'copilot', label: 'Copilot' }, { value: 'agents', label: 'AGENTS.md' }], defaults: ['cursor', 'copilot'] },
  canary: { type: 'single', options: [{ value: 'yes', label: 'Yes (recommended)' }, { value: 'no', label: 'No' }] },
};

let baseline = null;
let ws = null;
let currentRunId = null;
let answeredQuestions = new Set();   // per-run; guards against replayed frames

// ---------- screen switching ----------
function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === id);
  // move focus to the screen's heading so keyboard/SR users land in context
  document.querySelector(`#${id} h1[tabindex], #${id} h2[tabindex]`)?.focus();
}

// screen-reader narration of run progress (the journey/ring are aria-hidden)
function announce(text) {
  const el = document.querySelector('#sr-status');
  if (el) el.textContent = text;
}

// ---------- home / project loading ----------
async function loadProjects() {
  const sel = document.querySelector('#project-select');
  try {
    const { projects } = await (await fetch('/api/enable/projects')).json();
    sel.innerHTML = '<option value="">Choose a project…</option>' +
      projects.map((p) => `<option value="${p.path}">${p.name}</option>`).join('');
    if (!projects.length) sel.innerHTML = '<option value="">No git projects found — paste a path below</option>';
  } catch {
    sel.innerHTML = '<option value="">Could not list projects — paste a path below</option>';
  }
}

function chosenProjectDir() {
  return document.querySelector('#project-path').value.trim() || document.querySelector('#project-select').value;
}

// ---------- set-up form ----------
function buildSetupForm() {
  for (const [id, q] of Object.entries(SETUP_QUESTIONS)) {
    const box = document.querySelector(`.opts[data-q="${id}"]`);
    if (!box) continue;
    box.innerHTML = q.options.map((o, i) => {
      const input = q.type === 'multi' ? 'checkbox' : 'radio';
      const checked = q.type === 'multi'
        ? (o.locked || (q.defaults || []).includes(o.value)) : i === 0;
      const dis = o.locked ? 'disabled' : '';
      return `<label class="opt ${o.locked ? 'locked' : ''}">
        <input type="${input}" name="${id}" value="${o.value}" ${checked ? 'checked' : ''} ${dis} />
        <span>${o.label}</span></label>`;
    }).join('');
  }
}

function collectAnswers() {
  const a = {};
  a.testTier = document.querySelector('input[name="testTier"]:checked')?.value;
  a.vendoringDepth = document.querySelector('input[name="vendoringDepth"]:checked')?.value;
  a.canary = document.querySelector('input[name="canary"]:checked')?.value;
  // multi: array of label keys; onboarding.joinMultiToolTargets maps + locks CLAUDE.md
  const free = document.querySelector('input[data-free="multiToolTargets"]').value.trim();
  if (free) {
    a.multiToolTargets = free; // free text passes through verbatim
  } else {
    a.multiToolTargets = [...document.querySelectorAll('input[name="multiToolTargets"]:checked')]
      .map((el) => el.value).filter((v) => v !== 'claude'); // claude is always added server-side
  }
  const scope = document.querySelector('input[data-free="scopeConstraints"]').value.trim();
  a.scopeConstraints = scope;
  return a;
}

// ---------- run ----------
async function start(projectDir, answers) {
  const mock = document.querySelector('#mock-toggle').checked;
  resetProgress();
  show('progress');
  let runId;
  try {
    const interactive = document.querySelector('#interactive-toggle').checked;
    const res = await fetch('/api/enable/run', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectDir, answers, mock, interactive }) });
    if (!res.ok) { showError((await res.json().catch(() => ({}))).error || `run failed (${res.status})`); return; }
    ({ runId } = await res.json());
  } catch (err) { showError(String(err.message || err)); return; }

  if (ws) { try { ws.close(); } catch {} }   // drop the previous run's socket
  currentRunId = runId;
  ws = new WebSocket(`ws://${location.host}/ws?runId=${runId}`);
  ws.onmessage = (m) => { try { handle(JSON.parse(m.data)); } catch {} };
  ws.onerror = () => showError('Lost connection to the Enable server.');
}

function handle(ev) {
  if (ev.runId && ev.runId !== currentRunId) return; // another run's frame
  switch (ev.type) {
    case 'phase':    if (ev.status === 'done') activateStage(ev.nodeId || ev.phase); break;
    case 'log':      appendFeed(ev); break;
    case 'readiness':
      if (ev.kind === 'baseline') { baseline = ev.score; renderRing(ev.score, null);
        if (ev.score != null) announce(`Starting readiness score: ${Math.round(ev.score)} out of 100.`); }
      if (ev.kind === 'cycle')    { setPassLabel(ev.cycle); if (ev.score != null) { renderRing(ev.score, baseline);
        announce(`Pass ${ev.cycle}: readiness score ${Math.round(ev.score)} out of 100.`); } }
      if (ev.kind === 'final')    renderResults(ev);
      break;
    case 'done':     if (ev.status === 'error') showError('The run ended with an error.'); break;
    case 'error':    showError(ev.message); break;
    case 'question':          showGate(ev); break;
    case 'question-answered': hideGate(ev.id); break;
  }
}

// ---------- interactive gates ----------
// clarify never lands here (auto-answered from the set-up screen); gate =
// reviewer still sees blocking issues after the automatic fix cycles; recovery
// = a step failed repeatedly and the engine wants a retry/stop call.
function showGate(q) {
  if (q.kind === 'clarify' || answeredQuestions.has(q.id)) return;
  const wrap = document.querySelector('#gate-wrap');
  const issues = document.querySelector('#gate-issues');
  const primary = document.querySelector('#gate-primary');
  const secondary = document.querySelector('#gate-secondary');
  issues.innerHTML = '';

  if (q.kind === 'gate') {
    document.querySelector('#gate-title').textContent = 'The reviewer still sees issues';
    document.querySelector('#gate-detail').textContent =
      'Automatic improvement passes are used up. Run one more, or accept the result as is?';
    issues.innerHTML = (q.issues || []).slice(0, 6)
      .map((i) => `<li>${typeof i === 'string' ? i : (i.title || i.summary || '')}</li>`).join('');
    primary.textContent = 'Fix another round';
    secondary.textContent = 'Accept and continue';
    primary.onclick = () => sendAnswer(q.id, { decision: 'another' });
    secondary.onclick = () => sendAnswer(q.id, { decision: 'continue' });
  } else if (q.kind === 'recovery') {
    document.querySelector('#gate-title').textContent = 'A step keeps failing';
    document.querySelector('#gate-detail').textContent =
      'The engine retried and it still fails. Try again, or stop the run?';
    primary.textContent = 'Retry';
    secondary.textContent = 'Stop the run';
    primary.onclick = () => sendAnswer(q.id, { decision: 'retry' });
    secondary.onclick = () => sendAnswer(q.id, { decision: 'abort' });
  } else return;

  wrap.hidden = false;
  primary.focus();
}

function hideGate(id) {
  if (id) answeredQuestions.add(id);
  document.querySelector('#gate-wrap').hidden = true;
}

async function sendAnswer(id, payload) {
  try {
    const res = await fetch('/api/enable/answer', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: currentRunId, id, payload }) });
    if (res.ok) hideGate(id);
  } catch {}
}

// ---------- progress rendering ----------
function resetProgress() {
  baseline = null;
  answeredQuestions = new Set();
  hideGate(null);
  const j = document.querySelector('#journey');
  j.innerHTML = STAGES.map((s) => `<div class="stage" data-node="${s.node}" style="--c:${s.color}">
    <span class="stage-dot"></span><span class="stage-label">${s.label}</span></div>`).join('');
  document.querySelector('#feed').innerHTML = '';
  document.querySelector('#raw-log').textContent = '';
  document.querySelector('#ring-score').textContent = '—';
  setPassLabel(null);
  renderRing(null, null);
}

function activateStage(node) {
  const stages = [...document.querySelectorAll('.stage')];
  const idx = stages.findIndex((s) => s.dataset.node === node);
  stages.forEach((s, i) => {
    s.classList.toggle('done', idx >= 0 && i <= idx);
    s.classList.toggle('active', i === idx);
  });
  const st = STAGES.find((s) => s.node === node);
  if (st) announce(`Finished stage: ${st.label}.`);
}

function appendFeed(ev) {
  const text = ev.text || ev.message || ev.value;
  if (!text) return;
  const raw = document.querySelector('#raw-log');
  raw.textContent += `${ev.source ? `[${ev.source}] ` : ''}${text}\n`;
  raw.scrollTop = raw.scrollHeight;
  // plain-English feed: only show human-meaningful lines, keep it short
  if (typeof text === 'string' && text.length < 160) {
    const feed = document.querySelector('#feed');
    const line = document.createElement('div');
    line.className = 'feed-line';
    line.textContent = text;
    feed.append(line);
    while (feed.children.length > 6) feed.firstChild.remove();
  }
}

function setPassLabel(cycle) {
  const el = document.querySelector('#pass-label');
  el.textContent = cycle == null ? 'working…' : `pass ${cycle}`;
}

function renderRing(score, base) {
  const R = 74, C = 2 * Math.PI * R;
  const fill = document.querySelector('#ring-fill');
  const pct = Math.max(0, Math.min(100, score || 0)) / 100;
  fill.setAttribute('stroke-dasharray', `${pct * C} ${C}`);
  const ghost = document.querySelector('#ring-ghost');
  if (base == null) ghost.style.display = 'none';
  else { ghost.style.display = ''; ghost.setAttribute('stroke-dasharray', `${(base / 100) * C} ${C}`); }
  document.querySelector('#ring-score').textContent = score == null ? '—' : Math.round(score);
}

// ---------- results ----------
function renderResults(r) {
  show('results');
  const hero = document.querySelector('#hero');
  if (r.score == null) hero.textContent = 'Done';
  else if (r.baselineScore == null) hero.textContent = `${Math.round(r.score)}`;
  else hero.textContent = `${Math.round(r.baselineScore)} → ${Math.round(r.score)} (${r.delta >= 0 ? '+' : ''}${Math.round(r.delta)})`;

  const bars = document.querySelector('#bars');
  bars.innerHTML = '';
  for (const [key, label] of Object.entries(DIMENSION_LABELS)) {
    const v = (r.dimensions || {})[key];
    const w = typeof v === 'number' ? Math.max(0, Math.min(100, v)) : 0;
    const color = w >= 80 ? '#46d39a' : w >= 50 ? '#f5b833' : '#e5484d';
    bars.insertAdjacentHTML('beforeend',
      `<div class="bar"><span class="bar-label">${label}</span>
        <span class="bar-track"><i style="width:${w}%;background:${color}"></i></span>
        <span class="bar-val">${typeof v === 'number' ? Math.round(v) : '—'}</span></div>`);
  }

  const gaps = r.gaps || [];
  document.querySelector('#gaps-wrap').hidden = gaps.length === 0;
  document.querySelector('#gaps').innerHTML = gaps.map((g) => `<li>${typeof g === 'string' ? g : (g.title || JSON.stringify(g))}</li>`).join('');
  document.querySelector('#result-branch').textContent = r.branch ? `Branch: ${r.branch}` : '';
  if (currentRunId) loadChanges(`/api/enable/runs/${currentRunId}/changes`);
}

// ---------- what changed ----------
const MAX_FILE_ROWS = 12;

function fileRow(f) {
  const sign = f.status === 'M' ? '±' : f.status === 'D' ? '−' : '+';
  return `<li><span class="file-status">${sign}</span> ${f.path}
    <span class="file-counts">+${f.added || 0}/−${f.removed || 0}</span></li>`;
}

async function loadChanges(url) {
  const wrap = document.querySelector('#changes-wrap');
  wrap.hidden = true;
  let c;
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    c = await res.json();
  } catch { return; }
  renderChanges(c);
}

function renderChanges(c) {
  const wrap = document.querySelector('#changes-wrap');
  wrap.hidden = true;
  if (!c) return;
  const s = c.summary;
  if (!s && !c.patch) return;   // nothing to show (mock / mid-run)

  document.querySelector('#changes-summary').textContent = s
    ? `${s.filesNew || 0} new files, ${s.filesChanged || 0} changed, ${s.filesDeleted || 0} deleted` +
      ` (+${s.linesAdded || 0} / −${s.linesRemoved || 0} lines)`
    : '';

  const files = [...(c.newFiles || []), ...(c.changedFiles || [])];
  const list = document.querySelector('#changes-files');
  list.innerHTML = files.slice(0, MAX_FILE_ROWS).map(fileRow).join('') +
    (files.length > MAX_FILE_ROWS ? `<li class="file-more">…and ${files.length - MAX_FILE_ROWS} more</li>` : '');

  const toggle = document.querySelector('#patch-toggle');
  const view = document.querySelector('#patch-view');
  view.textContent = c.patch || '';
  view.hidden = true;
  toggle.hidden = !c.patch;
  toggle.textContent = 'Show patch';
  toggle.setAttribute('aria-expanded', 'false');
  wrap.hidden = false;
}

// ---------- history ----------
async function loadHistory() {
  const wrap = document.querySelector('#history-wrap');
  let hist;
  try {
    const res = await fetch('/api/enable/history');
    if (!res.ok) return;
    hist = (await res.json()).runs || [];
  } catch { return; }
  if (!hist.length) { wrap.hidden = true; return; }

  const list = document.querySelector('#history-list');
  list.innerHTML = '';
  for (const h of hist.slice(0, 20)) {
    const li = document.createElement('li');
    const when = h.startedAt ? new Date(h.startedAt).toLocaleDateString() : '';
    const r = h.readiness;
    const score = r && r.score != null
      ? (r.baselineScore != null ? `${Math.round(r.baselineScore)} → ${Math.round(r.score)}` : `${Math.round(r.score)}`)
      : h.status;
    li.innerHTML = `<button type="button" class="hist-btn">
      <span class="hist-project">${h.projectName || h.title}</span>
      <span class="hist-when">${when}</span><span class="hist-score">${score}</span></button>`;
    li.querySelector('.hist-btn').addEventListener('click', () => showHistoryDetail(h.id));
    list.append(li);
  }
  wrap.hidden = false;
}

async function showHistoryDetail(id) {
  let d;
  try {
    const res = await fetch(`/api/enable/history/${id}`);
    if (!res.ok) return;
    d = await res.json();
  } catch { return; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
  currentRunId = null;                       // disk view, no live socket
  renderResults({ ...(d.readiness || {}), branch: d.entry?.branch ?? null });
  renderChanges(d.changes);
}

function showError(detail) {
  document.querySelector('#error-detail').textContent = detail || '';
  show('errored');
}

// ---------- theme ----------
function initTheme() {
  const saved = localStorage.getItem('enable-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  document.querySelector('#theme-toggle').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('enable-theme', next);
  });
}

// ---------- wiring ----------
function init() {
  initTheme();
  loadProjects();
  loadHistory();
  buildSetupForm();

  document.querySelector('#go-setup').addEventListener('click', () => {
    const dir = chosenProjectDir();
    const err = document.querySelector('#home-error');
    if (!dir) { err.textContent = 'Pick a project or paste a path first.'; err.hidden = false; return; }
    err.hidden = true;
    show('setup');
  });

  document.querySelector('#setup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    start(chosenProjectDir(), collectAnswers());
  });

  for (const b of document.querySelectorAll('[data-back]')) {
    b.addEventListener('click', () => {
      if (ws) { try { ws.close(); } catch {} }
      if (b.dataset.back === 'home') loadHistory();   // pick up the run that just finished
      show(b.dataset.back);
    });
  }

  document.querySelector('#patch-toggle').addEventListener('click', () => {
    const view = document.querySelector('#patch-view');
    const toggle = document.querySelector('#patch-toggle');
    view.hidden = !view.hidden;
    toggle.textContent = view.hidden ? 'Show patch' : 'Hide patch';
    toggle.setAttribute('aria-expanded', String(!view.hidden));
  });

  document.querySelector('#details-toggle').addEventListener('click', () => {
    const raw = document.querySelector('#raw-log');
    const toggle = document.querySelector('#details-toggle');
    raw.hidden = !raw.hidden;
    toggle.textContent = raw.hidden ? 'Show details' : 'Hide details';
    toggle.setAttribute('aria-expanded', String(!raw.hidden));
  });
}

document.addEventListener('DOMContentLoaded', init);
