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
    { value: 'copilot', label: 'Copilot' }, { value: 'agents', label: 'AGENTS.md (Codex & others)' }],
    defaults: ['cursor', 'copilot', 'agents'] },
  canary: { type: 'single', options: [{ value: 'yes', label: 'Yes (recommended)' }, { value: 'no', label: 'No' }] },
};

let baseline = null;
let baselineDims = null;
let ws = null;
let currentRunId = null;
let currentPipelineId = null;        // engine pipeline id, from state frames
let lastWarnLine = null;             // pause reason candidate (session limit etc.)
let answeredQuestions = new Set();   // per-run; guards against replayed frames
let currentHistoryId = null;         // set when viewing a past run from disk (no live socket); .md preview reads from this run's dir

// ---------- screen switching ----------
function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === id);
  // sidebar: "New" highlights on the fresh-run flow; a Past entry keeps its own
  // highlight (set in showHistoryDetail) while its result view is open.
  document.querySelector('#nav-new')?.classList.toggle('active', id !== 'results' || !viewingHistoryId);
  if (id !== 'results') markHistoryActive(null);
  // move focus to the screen's heading so keyboard/SR users land in context
  document.querySelector(`#${id} h1[tabindex], #${id} h2[tabindex]`)?.focus();
}

let viewingHistoryId = null;
function markHistoryActive(id) {
  viewingHistoryId = id;
  for (const b of document.querySelectorAll('#history-list .hist-btn')) {
    b.classList.toggle('active', id != null && b.dataset.histId === String(id));
  }
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

// ---------- home / target picker (project vs. workspace) ----------
function currentTarget() {
  return document.querySelector('input[name="target"]:checked')?.value || 'project';
}

async function loadWorkspaces() {
  const sel = document.querySelector('#workspace-select');
  const hint = document.querySelector('#workspace-empty-hint');
  try {
    const { workspaces } = await (await fetch('/api/enable/workspaces')).json();
    if (!workspaces.length) {
      sel.innerHTML = '<option value="">No workspaces yet</option>';
      hint.hidden = false;
      return;
    }
    hint.hidden = true;
    sel.innerHTML = '<option value="">Choose a workspace…</option>' +
      workspaces.map((w) => `<option value="${w.id}">${w.name} (${w.projectPaths.length} projects)</option>`).join('');
  } catch {
    sel.innerHTML = '<option value="">Could not list workspaces</option>';
  }
}

function chosenWorkspaceId() {
  return document.querySelector('#workspace-select').value;
}

function setTargetPane(target) {
  document.querySelector('#target-project-pane').hidden = target !== 'project';
  document.querySelector('#target-workspace-pane').hidden = target !== 'workspace';
  for (const btn of document.querySelector('#target-seg').querySelectorAll('.seg-btn')) {
    btn.setAttribute('aria-selected', String(btn.dataset.target === target));
  }
}

// ---------- knowledge graph ----------
// The graph routes address a project by *name* (a subdir of the projects root),
// so we derive the name from the chosen dir. Projects pasted from outside the
// root simply won't resolve server-side -> button stays disabled with a hint.
let graphProject = null;   // name the graph buttons currently point at
let graphReturn = 'home';  // screen to return to from the graph view
let lastProjectDir = '';   // dir of the most recently started run (for results view)

function projectName(dir) {
  if (!dir) return '';
  return dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
}

async function graphInfo(name) {
  if (!name) return { exists: false, hasHtml: false, hasReport: false };
  try { return await (await fetch(`/api/enable/graph/exists?project=${encodeURIComponent(name)}`)).json(); }
  catch { return { exists: false, hasHtml: false, hasReport: false }; }
}

// gate the "View knowledge graph" buttons for the given project dir
async function refreshGraphButtons(dir) {
  const name = projectName(dir);
  graphProject = name || null;
  const info = await graphInfo(name);
  const can = !!(info.exists && (info.hasHtml || info.hasReport));
  for (const id of ['home-graph-btn', 'results-graph-btn']) {
    const btn = document.querySelector('#' + id);
    if (!btn) continue;
    btn.hidden = !name;
    btn.disabled = !can;
    btn.title = can ? '' : 'Run /graphify on this project first';
  }
  const hint = document.querySelector('#home-graph-hint');
  if (hint) hint.hidden = !(name && !can);
}

async function openGraph(name, returnTo) {
  if (!name) return;
  graphReturn = returnTo || 'home';
  document.querySelector('#graph-project').textContent = ` · ${name}`;
  const frame = document.querySelector('#graph-frame');
  const report = document.querySelector('#graph-report');
  const noHtml = document.querySelector('#graph-nohtml');
  const info = await graphInfo(name);
  if (info.hasHtml) {
    frame.src = `/api/enable/graph/view?project=${encodeURIComponent(name)}`;
    frame.hidden = false; noHtml.hidden = true;
  } else {
    frame.removeAttribute('src'); frame.hidden = true; noHtml.hidden = false;
  }
  if (info.hasReport) {
    report.innerHTML = '<p class="hint-line">Loading report…</p>';
    try {
      const md = await (await fetch(`/api/enable/graph/report?project=${encodeURIComponent(name)}`)).text();
      report.innerHTML = renderMarkdown(md);
    } catch { report.innerHTML = '<p class="hint-line">Could not load the report.</p>'; }
  } else {
    report.innerHTML = '<p class="hint-line">No <code>GRAPH_REPORT.md</code> — run <code>/graphify</code> to generate one.</p>';
  }
  show('graph');
}

// Tiny markdown renderer for GRAPH_REPORT.md (headings, bullet lists, hr,
// paragraphs, inline code / bold / links). Source is escaped first so report
// content can never inject markup.
function renderMarkdown(md) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const raw of String(md).replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { closeList(); continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { closeList(); const n = m[1].length; out.push(`<h${n}>${inline(m[2])}</h${n}>`); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    if (/^[-*]\s+/.test(line)) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`); continue; }
    closeList(); out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

// ---------- folder picker ----------
let pickerDir = null;

async function loadPicker(dir) {
  let data;
  try {
    const res = await fetch('/api/enable/browse' + (dir ? `?dir=${encodeURIComponent(dir)}` : ''));
    if (!res.ok) return;
    data = await res.json();
  } catch { return; }
  pickerDir = data.dir;
  document.querySelector('#picker-path').textContent = data.dir;
  const up = document.querySelector('#picker-up');
  up.disabled = !data.parent;
  up.dataset.parent = data.parent || '';
  const folderIcon = '<svg class="picker-folder" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">' +
    '<path fill="currentColor" d="M1.5 4A1.5 1.5 0 0 1 3 2.5h3.2a1.5 1.5 0 0 1 1.06.44l.94.94H13A1.5 1.5 0 0 1 14.5 6.3v5.2A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5z"/></svg>';
  const list = document.querySelector('#picker-list');
  list.innerHTML = data.entries.map((e) =>
    `<li class="picker-item" data-path="${esc(e.path)}"><span class="picker-icon">${folderIcon}</span><span class="picker-name">${esc(e.name)}</span>${e.isGit ? '<span class="picker-badge">git</span>' : ''}<span class="picker-enter" aria-hidden="true">›</span></li>`).join('')
    || '<li class="picker-empty">No sub-folders here.</li>';
}

async function openPicker() {
  const modal = document.querySelector('#picker-modal');
  modal.hidden = false;
  document.body.classList.add('modal-open');
  const start = document.querySelector('#project-path').value.trim() || '';
  await loadPicker(start);
}

function closePicker() {
  document.querySelector('#picker-modal').hidden = true;
  document.body.classList.remove('modal-open');
}

// ---------- source branch ----------
async function refreshBranches() {
  const field = document.querySelector('#branch-field');
  const sel = document.querySelector('#source-branch');
  const dir = chosenProjectDir();
  if (!dir) { field.hidden = true; sel.innerHTML = ''; return; }
  let data;
  try {
    const res = await fetch(`/api/enable/branches?dir=${encodeURIComponent(dir)}`);
    if (!res.ok) { field.hidden = true; sel.innerHTML = ''; return; }
    data = await res.json();
  } catch { field.hidden = true; sel.innerHTML = ''; return; }
  sel.innerHTML = (data.branches || []).map((b) =>
    `<option value="${esc(b)}"${b === data.current ? ' selected' : ''}>${esc(b)}${b === data.current ? ' (current)' : ''}</option>`).join('');
  field.hidden = !(data.branches || []).length;
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

// ---------- pause / resume ----------
// Prefer the engine's own pause reason (done{paused}.reason, set for limit-pauses
// by orchestrator._completePaused); fall back to the last warn-level log line when
// it looks like a limit message, then a generic message. `reason` is either the
// engine's string or undefined.
function pausedReasonText(reason) {
  if (typeof reason === 'string' && reason.trim())
    return `${reason} The run will pick up where it left off.`;
  if (typeof lastWarnLine === 'string' && /limit/i.test(lastWarnLine))
    return `${lastWarnLine} The run will pick up where it left off.`;
  return 'Run paused — resume when you\'re ready.';
}

// 'running' | 'pausing' | 'winding-down' | 'paused' | 'idle'
// winding-down = the synthetic {type:'paused'} frame just arrived; the engine is
// still finishing the in-flight step, so Resume must stay disabled and unfocused
// until the real done{status:'paused'} frame confirms the pipeline actually stopped.
function setPauseUi(mode, reasonText) {
  const btn = document.querySelector('#pause-btn');
  const banner = document.querySelector('#paused-banner');
  const resumeBtn = document.querySelector('#resume-btn');
  btn.hidden = mode !== 'running' && mode !== 'pausing';
  btn.disabled = mode === 'pausing';
  btn.textContent = mode === 'pausing' ? 'Pausing…' : 'Pause run';
  banner.hidden = mode !== 'winding-down' && mode !== 'paused';
  if (mode === 'winding-down') {
    resumeBtn.disabled = true;
    document.querySelector('#paused-reason').textContent = 'Pausing — finishing the current step…';
  } else if (mode === 'paused') {
    resumeBtn.disabled = false;
    document.querySelector('#paused-reason').textContent = reasonText || pausedReasonText();
    announce('The run is paused.');
    resumeBtn.focus();
  }
}

// synthetic {type:'paused'} frame: POST /pause just returned but the engine is
// still winding down the in-flight step — show the banner, keep Resume disabled.
function showWindingDown() {
  hideGate(null);
  setPauseUi('winding-down');
}

// done{status:'paused'}: the pipeline has actually stopped — enable Resume, set
// the final reason text, and move focus there.
function showPaused(reason) {
  stopLiveMeter();
  hideGate(null);
  setPauseUi('paused', pausedReasonText(reason));
}

// ---------- run ----------
async function start(target, answers) {
  const mock = document.querySelector('#mock-toggle').checked;
  const interactive = document.querySelector('#interactive-toggle').checked;
  const body = { answers, mock, interactive };
  if (target === 'workspace') {
    body.workspaceId = chosenWorkspaceId();
    lastProjectDir = '';   // graph/estimate buttons stay hidden in workspace mode
  } else {
    body.projectDir = chosenProjectDir();
    body.sourceBranch = document.querySelector('#source-branch')?.value || undefined;
    lastProjectDir = body.projectDir;
  }
  resetProgress();
  show('progress');
  startLiveMeter();
  let runId;
  try {
    const res = await fetch('/api/enable/run', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { showError((await res.json().catch(() => ({}))).error || `run failed (${res.status})`); return; }
    ({ runId } = await res.json());
  } catch (err) { showError(String(err.message || err)); return; }

  setPauseUi('running');
  connectRun(runId);
}

function connectRun(runId) {
  if (ws) { try { ws.close(); } catch {} }   // drop the previous run's socket
  currentRunId = runId;
  currentHistoryId = null;                     // a live run supersedes any disk view
  ws = new WebSocket(`ws://${location.host}/ws?runId=${runId}`);
  ws.onmessage = (m) => { try { handle(JSON.parse(m.data)); } catch {} };
  ws.onerror = () => showError('Lost connection to the Enable server.');
}

let resumeInFlight = false;   // single-flight: a double-click must not fire a second POST

async function resumeRun(pipelineId) {
  if (resumeInFlight) return;
  resumeInFlight = true;
  const resumeBtn = document.querySelector('#resume-btn');
  resumeBtn.disabled = true;
  resetProgress();
  show('progress');
  startLiveMeter();
  try {
    // No run-mode fields here: the home-screen toggles describe the NEXT new
    // run, not this pipeline. The engine reads the run's own persisted mode —
    // sending a stale toggle once mock-corrupted a real run.
    const res = await fetch('/api/enable/resume', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pipelineId }) });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      // "already live" with a joinable run: this pipeline is streaming right
      // now (second tab, refresh, racing click) — rejoin it instead of painting
      // an error banner over a healthy run.
      if (res.status === 409 && body.liveRunId) {
        currentPipelineId = pipelineId;
        setPauseUi('running');
        connectRun(body.liveRunId);
        return;
      }
      // other rejections (not resumable, worktree gone, …): stay on the
      // progress screen and re-show the paused banner so Resume can be
      // retried, instead of routing to the dead-end error screen.
      const msg = body.error || `resume failed (${res.status})`;
      currentPipelineId = pipelineId;
      stopLiveMeter();
      setPauseUi('paused', `Could not resume: ${msg}`);
      return;
    }
    const { runId } = await res.json();
    currentPipelineId = pipelineId;
    setPauseUi('running');
    connectRun(runId);
  } catch (err) { showError(String(err.message || err)); }
  finally {
    resumeInFlight = false;
    resumeBtn.disabled = false;
  }
}

async function pauseRun() {
  if (!currentRunId) return;
  setPauseUi('pausing');
  try {
    const res = await fetch('/api/enable/pause', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: currentRunId }) });
    if (!res.ok) setPauseUi('running');   // engine refused (already finishing)
  } catch { setPauseUi('running'); }
}

function handle(ev) {
  if (ev.runId && ev.runId !== currentRunId) return; // another run's frame
  switch (ev.type) {
    case 'state':    if (ev.id) currentPipelineId = ev.id; updateLiveTotals(ev); break;
    case 'phase':    if (ev.status === 'done') activateStage(ev.nodeId || ev.phase); break;
    case 'log':      appendFeed(ev); break;
    case 'readiness':
      if (ev.kind === 'baseline') { baseline = ev.score; baselineDims = ev.dimensions || null; renderRing(ev.score, null);
        if (ev.score != null) announce(`Starting readiness score: ${Math.round(ev.score)} out of 100.`); }
      if (ev.kind === 'cycle')    { setPassLabel(ev.cycle); if (ev.score != null) { renderRing(ev.score, baseline);
        announce(`Pass ${ev.cycle}: readiness score ${Math.round(ev.score)} out of 100.`); } }
      if (ev.kind === 'final')    renderResults(ev);
      break;
    case 'paused':   showWindingDown(); break;
    case 'done':
      stopLiveMeter();
      if (ev.status === 'paused') showPaused(ev.reason);
      else if (ev.status === 'error') showError('The run ended with an error.');
      else setPauseUi('idle');
      break;
    case 'error':    stopLiveMeter(); showError(ev.message); break;
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
  baselineDims = null;
  currentPipelineId = null;
  lastWarnLine = null;
  setPauseUi('idle');
  answeredQuestions = new Set();
  hideGate(null);
  stopLiveMeter();
  runStartTs = null;
  lastTotals = { costUsd: 0, tokens: 0, activeMs: 0 };
  const meter = document.querySelector('#run-meter');
  if (meter) { meter.hidden = true; meter.innerHTML = ''; }
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
  if (ev.level === 'warn' && typeof (ev.text || ev.message) === 'string') lastWarnLine = ev.text || ev.message;
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

// ---------- run stats: elapsed / cost / tokens ----------
// Live totals arrive on `state` frames (engine's getState: totalCostUsd,
// totalActiveMs, per-step tokens). Elapsed is wall-clock from run start, ticked
// once a second and frozen on `done`. Past runs (history) carry cost + active time
// from the DB; tokens aren't persisted, so they're shown live only.
let runStartTs = null;
let liveTimer = null;
let lastTotals = { costUsd: 0, tokens: 0, activeMs: 0 };
let estTimer = null;

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `${m}m ${String(r).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}
const fmtUsd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
function fmtTokens(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
const sumTokens = (steps) => (Array.isArray(steps)
  ? steps.reduce((a, s) => a + (Number(s && s.tokens) || 0), 0) : 0);
const statChip = (label, value) =>
  `<span class="stat-chip"><span class="stat-k">${label}</span><span class="stat-v">${value}</span></span>`;

function renderLiveMeter() {
  const el = document.querySelector('#run-meter');
  if (!el || runStartTs == null) return;
  el.hidden = false;
  const chips = [statChip('elapsed', fmtDuration(Date.now() - runStartTs))];
  // resumed runs: 'elapsed' counts this lifetime only, while cost/tokens are
  // engine totals across ALL lifetimes — show cumulative active time alongside
  // so the numbers read consistently.
  if (lastTotals.activeMs > Date.now() - runStartTs) chips.push(statChip('active total', fmtDuration(lastTotals.activeMs)));
  if (lastTotals.costUsd > 0) chips.push(statChip('cost', fmtUsd(lastTotals.costUsd)));
  if (lastTotals.tokens > 0) chips.push(statChip('tokens', fmtTokens(lastTotals.tokens)));
  el.innerHTML = chips.join('');
}
function updateLiveTotals(state) {
  lastTotals = {
    costUsd: Number(state.totalCostUsd) || 0,
    activeMs: Number(state.totalActiveMs) || 0,
    tokens: sumTokens(state.steps),
  };
  renderLiveMeter();
}
function startLiveMeter() {
  runStartTs = Date.now();
  lastTotals = { costUsd: 0, tokens: 0, activeMs: 0 };
  stopLiveMeter();
  liveTimer = setInterval(renderLiveMeter, 1000);
  renderLiveMeter();
}
function stopLiveMeter() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
}
// Stats snapshot for the live run at results time.
function liveStats() {
  if (runStartTs == null) return null;
  return { elapsedMs: Date.now() - runStartTs, costUsd: lastTotals.costUsd, tokens: lastTotals.tokens };
}
function renderStats(stats) {
  const el = document.querySelector('#result-stats');
  if (!el) return;
  const chips = [];
  if (stats && stats.elapsedMs != null) chips.push(statChip('took', fmtDuration(stats.elapsedMs)));
  if (stats && stats.estimated) {
    chips.push(statChip('cost (est)', `${fmtUsd(stats.estLow)}–${fmtUsd(stats.estHigh)}`));
  } else if (stats && stats.costUsd != null && stats.costUsd > 0) {
    chips.push(statChip('cost', fmtUsd(stats.costUsd)));
  }
  if (stats && stats.tokens != null && stats.tokens > 0) chips.push(statChip('tokens', fmtTokens(stats.tokens)));
  el.innerHTML = chips.join('');
  el.hidden = chips.length === 0;
}

// ---------- pre-run cost estimate ----------
async function refreshEstimate() {
  const el = document.querySelector('#setup-estimate');
  const dir = chosenProjectDir();
  if (!el) return;
  if (!dir) { el.hidden = true; return; }
  const a = collectAnswers();
  const targets = Array.isArray(a.multiToolTargets)
    ? a.multiToolTargets : String(a.multiToolTargets || '').split(',').map((s) => s.trim()).filter(Boolean);
  const qs = new URLSearchParams({
    dir, testTier: a.testTier || '', vendoringDepth: a.vendoringDepth || '',
    canary: a.canary || '', multiTool: targets.join(','),
  });
  el.hidden = false;
  el.textContent = 'Estimating…';
  try {
    const res = await fetch(`/api/enable/estimate?${qs}`);
    if (!res.ok) { el.hidden = true; return; }
    const e = await res.json();
    const mock = document.querySelector('#mock-toggle')?.checked;
    el.innerHTML = `<span class="est-label">Estimated ${mock ? 'real-run ' : ''}cost</span> ` +
      `<strong>${fmtUsd(e.low)}–${fmtUsd(e.high)}</strong> · ~${e.minutes} min ` +
      `<span class="est-note">· rough estimate</span>`;
  } catch { el.hidden = true; }
}
function scheduleEstimate() {
  clearTimeout(estTimer);
  estTimer = setTimeout(refreshEstimate, 300);
}

// ---------- results ----------
const clampPct = (x) => Math.max(0, Math.min(100, x));

// Count a number up from `from` to `to`; instant when motion is reduced/unavailable.
function animateCount(el, from, to) {
  if (!el) return;
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || typeof requestAnimationFrame !== 'function') { el.textContent = String(to); return; }
  const dur = 900;
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);   // ease-out cubic
    el.textContent = String(Math.round(from + (to - from) * eased));
    if (p < 1) requestAnimationFrame(step);
  };
  el.textContent = String(from);
  requestAnimationFrame(step);
}

function renderResults(r) {
  show('results');
  const hero = document.querySelector('#hero');
  hero.innerHTML = '';
  if (r.score == null) {
    hero.textContent = 'Done';
  } else if (r.baselineScore == null) {
    hero.innerHTML = '<span class="score-after"></span>';
    animateCount(hero.querySelector('.score-after'), 0, Math.round(r.score));
  } else {
    const b = Math.round(r.baselineScore), s = Math.round(r.score), d = Math.round(r.delta);
    hero.innerHTML = `<span class="score-before">${b}</span><span class="score-arrow">→</span>` +
      `<span class="score-after"></span>` +
      `<span class="score-delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${d}</span>`;
    animateCount(hero.querySelector('.score-after'), b, s);
  }
  // completion glow-sweep — replay by forcing a reflow between class removal/add
  hero.classList.remove('reveal'); void hero.offsetWidth; hero.classList.add('reveal');

  const bdims = r.baselineDimensions || baselineDims || {};
  const bars = document.querySelector('#bars');
  bars.innerHTML = '';
  for (const [key, label] of Object.entries(DIMENSION_LABELS)) {
    const v = (r.dimensions || {})[key];
    const w = typeof v === 'number' ? clampPct(v) : 0;
    const bv = bdims[key];
    const ghost = typeof bv === 'number' ? clampPct(bv) : null;
    const color = w >= 80 ? 'var(--accent)' : w >= 50 ? 'var(--amber)' : 'var(--red)';
    bars.insertAdjacentHTML('beforeend',
      `<div class="bar"><span class="bar-label">${label}</span>
        <span class="bar-track"><i class="bar-current" style="width:${w}%;background:${color}"></i>${ghost != null ? `<i class="bar-ghost" style="width:${ghost}%"></i>` : ''}</span>
        <span class="bar-val">${typeof v === 'number' ? Math.round(v) : '—'}</span></div>`);
  }

  const gaps = r.gaps || [];
  document.querySelector('#gaps-wrap').hidden = gaps.length === 0;
  document.querySelector('#gaps').innerHTML = gaps.map((g) => `<li>${typeof g === 'string' ? g : (g.title || JSON.stringify(g))}</li>`).join('');
  resetTodoButton(gaps.map((g) => (typeof g === 'string' ? g : g.title || JSON.stringify(g))));
  document.querySelector('#result-branch').textContent = r.branch ? `Branch: ${r.branch}` : '';
  refreshGraphButtons(lastProjectDir);   // graph may have been (re)built during the run
  renderStats(r._stats || (currentRunId ? liveStats() : null));
  if (currentRunId) loadChanges(`/api/enable/runs/${currentRunId}/changes`);
}

// ---------- gaps -> TODO.md ----------
let todoGaps = [];

function resetTodoButton(gaps) {
  todoGaps = gaps;
  const btn = document.querySelector('#todo-btn');
  btn.hidden = !lastProjectDir;   // no known project -> nowhere to write
  btn.disabled = false;
  btn.textContent = 'Create tasks in TODO.md';
  document.querySelector('#todo-error').hidden = true;
}

async function createTodoTasks() {
  const btn = document.querySelector('#todo-btn');
  const errEl = document.querySelector('#todo-error');
  errEl.hidden = true;
  btn.disabled = true;
  try {
    const res = await fetch('/api/enable/todo', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: lastProjectDir, gaps: todoGaps }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    btn.textContent = body.written > 0
      ? `✓ Added to TODO.md (${body.written})`
      : '✓ Already in TODO.md';
  } catch (err) {
    btn.disabled = false;
    errEl.textContent = `Could not write TODO.md: ${err.message}`;
    errEl.hidden = false;
  }
}

// ---------- what changed ----------
const MAX_FILE_ROWS = 12;

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function statBar(added, removed) {
  const total = (added || 0) + (removed || 0);
  const a = total ? Math.round(((added || 0) / total) * 100) : 0;
  return `<span class="stat-bar" aria-hidden="true"><i class="stat-add" style="width:${a}%"></i><i class="stat-del" style="width:${total ? 100 - a : 0}%"></i></span>`;
}

function fileRow(f) {
  const status = f.status === 'M' ? 'M' : f.status === 'D' ? 'D' : 'A';
  const sign = status === 'M' ? '±' : status === 'D' ? '−' : '+';
  return `<li class="file-row" data-path="${esc(f.path)}"><span class="file-status status-${status}">${sign}</span> <span class="file-name">${esc(f.path)}</span>
    ${statBar(f.added, f.removed)}<span class="file-counts">+${f.added || 0}/−${f.removed || 0}</span></li>`;
}

function diffLineClass(line) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-meta';
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-del';
  if (line.startsWith('@@')) return 'diff-hunk';
  if (line.startsWith('diff --git') || line.startsWith('index ')) return 'diff-meta';
  return '';
}

function renderPatch(patch) {
  return patch.split('\n').map((line) => {
    const cls = diffLineClass(line);
    return cls ? `<span class="${cls}">${esc(line)}</span>` : esc(line);
  }).join('\n');
}

// Split a unified diff blob into per-file chunks on "diff --git" boundaries.
function patchFilePath(header) {
  const m = header.match(/^diff --git a\/(.*?) b\/(.*)$/);
  if (!m) return '';
  return m[2] === '/dev/null' ? m[1] : m[2];
}

function splitPatch(patch) {
  if (!patch) return [];
  const chunks = [];
  let cur = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git')) {
      cur = { path: patchFilePath(line), lines: [line] };
      chunks.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return chunks.map((c) => ({ path: c.path, text: c.lines.join('\n') }));
}

// ---------- markdown preview ----------
const mdCache = new Map();   // path -> { ok, content }; reset per results render

function isMarkdown(p) { return /\.(md|markdown)$/i.test(p || ''); }

// Where to fetch a changed file's full content from — the live run, else the
// disk-backed history view. Null when neither is active (nothing to preview).
function fileEndpoint(p) {
  const q = `?path=${encodeURIComponent(p)}`;
  if (currentRunId) return `/api/enable/runs/${currentRunId}/file${q}`;
  if (currentHistoryId) return `/api/enable/history/${currentHistoryId}/file${q}`;
  return null;
}

async function loadMdContent(p) {
  if (mdCache.has(p)) return mdCache.get(p);
  const url = fileEndpoint(p);
  let out = { ok: false, content: '' };
  if (url) {
    try {
      const res = await fetch(url);
      if (res.ok) out = { ok: true, content: (await res.json()).content || '' };
    } catch { /* leave as unavailable */ }
  }
  mdCache.set(p, out);
  return out;
}

// Only same-origin/relative or http(s) links survive; everything else (javascript:,
// data:, quotes that could break out of the attribute) is dropped to plain text.
function safeHref(u) {
  const t = String(u).trim();
  if (/["'<>]/.test(t) || /^\s*javascript:/i.test(t)) return null;
  if (/^(https?:\/\/|\/|#|\.?\.?\/)/i.test(t) || /^[\w./#-]+$/.test(t)) return esc(t);
  return null;
}

// Inline spans. Code spans are lifted out to NUL sentinels first so nothing inside
// them is re-parsed AND so emphasis/links that straddle a code span still match;
// they are restored last. Everything else is HTML-escaped before markup is added.
function inlineMd(raw) {
  const codes = [];
  let s = String(raw).replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return ` ${codes.length - 1} `; });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const href = safeHref(url);
    return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_]+)_/g, '$1<em>$2</em>');
  return s.replace(/ (\d+) /g, (m, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

// Compact, safe Markdown -> HTML for the preview pane. Covers the constructs that
// show up in repo docs (headings, lists, fenced code, blockquotes, rules, inline
// emphasis/links); anything else falls through as a paragraph. Not CommonMark.
function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let listType = null;   // 'ul' | 'ol' | null
  const flushPara = () => { if (para.length) { out.push(`<p>${inlineMd(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      flushPara(); flushList();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      out.push(`<pre class="md-code"><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); flushList(); const n = h[1].length; out.push(`<h${n}>${inlineMd(h[2].trim())}</h${n}>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue; }
    const bq = line.match(/^\s*>\s?(.*)$/);
    if (bq) {
      flushPara(); flushList();
      const buf = [bq[1]];
      while (i + 1 < lines.length) { const m = lines[i + 1].match(/^\s*>\s?(.*)$/); if (!m) break; buf.push(m[1]); i++; }
      out.push(`<blockquote>${inlineMd(buf.join(' '))}</blockquote>`);
      continue;
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const t = ul ? 'ul' : 'ol';
      if (listType && listType !== t) flushList();
      if (!listType) { listType = t; out.push(`<${t}>`); }
      out.push(`<li>${inlineMd((ul ? ul[1] : ol[1]).trim())}</li>`);
      continue;
    }
    if (/^\s*$/.test(line)) { flushPara(); flushList(); continue; }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join('\n');
}

// ---------- diff modal ----------
let diffState = { files: [], chunks: [] };

function statusGlyph(status) {
  const st = status === 'M' ? 'M' : status === 'D' ? 'D' : 'A';
  return { st, sign: st === 'M' ? '±' : st === 'D' ? '−' : '+' };
}

function statusOf(path) {
  const f = (diffState.files || []).find((x) => x.path === path);
  return statusGlyph(f ? f.status : 'M').st;
}

function chunkIndexForPath(path) {
  return (diffState.chunks || []).findIndex((c) => c.path === path);
}

function openDiffModal(focusIndex = 0) {
  const chunks = diffState.chunks || [];
  if (!chunks.length) return;
  const listEl = document.querySelector('#diff-file-list');
  const paneEl = document.querySelector('#diff-pane');
  listEl.innerHTML = chunks.map((ch, i) => {
    const { st, sign } = statusGlyph(statusOf(ch.path));
    return `<button class="diff-file-item" data-idx="${i}" type="button">
      <span class="file-status status-${st}">${sign}</span>
      <span class="diff-file-name">${esc(ch.path)}</span></button>`;
  }).join('');
  paneEl.innerHTML = chunks.map((ch, i) => {
    const { st, sign } = statusGlyph(statusOf(ch.path));
    // Markdown files that still exist can be previewed rendered/raw, not just as a diff.
    const previewable = isMarkdown(ch.path) && st !== 'D';
    const toggle = previewable
      ? `<span class="diff-view-toggle" role="group">
          <button type="button" data-view="diff" class="active">Diff</button>
          <button type="button" data-view="rendered">Rendered</button>
          <button type="button" data-view="raw">Raw</button>
        </span>`
      : '';
    return `<section id="diff-file-${i}" class="diff-file" data-path="${esc(ch.path)}">
      <header class="diff-file-head"><span class="file-status status-${st}">${sign}</span> ${esc(ch.path)}${toggle}</header>
      <pre class="diff-body">${renderPatch(ch.text)}</pre>
      ${previewable ? '<div class="md-preview" hidden></div>' : ''}
    </section>`;
  }).join('');
  const modal = document.querySelector('#diff-modal');
  modal.hidden = false;
  document.body.classList.add('modal-open');
  const toggle = document.querySelector('#patch-toggle');
  toggle.setAttribute('aria-expanded', 'true');
  toggle.textContent = 'Hide patch';
  focusDiffFile(Math.max(0, focusIndex));
}

function focusDiffFile(i) {
  const sec = document.querySelector(`#diff-file-${i}`);
  if (!sec) return;
  if (typeof sec.scrollIntoView === 'function') sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
  sec.classList.remove('flash');
  void sec.offsetWidth;   // reflow so the animation replays
  sec.classList.add('flash');
  for (const it of document.querySelectorAll('.diff-file-item'))
    it.classList.toggle('active', Number(it.dataset.idx) === i);
}

function closeDiffModal() {
  const modal = document.querySelector('#diff-modal');
  modal.hidden = true;
  document.body.classList.remove('modal-open');
  const toggle = document.querySelector('#patch-toggle');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.textContent = 'Show patch';
}

// Switch a .md file section between its diff, rendered preview, and raw source.
async function switchDiffView(btn) {
  const sec = btn.closest('.diff-file');
  if (!sec) return;
  const view = btn.dataset.view;
  for (const b of sec.querySelectorAll('.diff-view-toggle [data-view]'))
    b.classList.toggle('active', b === btn);
  const body = sec.querySelector('.diff-body');
  const prev = sec.querySelector('.md-preview');
  if (!prev) return;
  if (view === 'diff') { body.hidden = false; prev.hidden = true; return; }
  body.hidden = true; prev.hidden = false;
  prev.classList.toggle('rendered', view === 'rendered');
  const { ok, content } = await loadMdContent(sec.dataset.path);
  if (btn.classList.contains('active') === false) return;   // user switched away mid-fetch
  if (!ok) { prev.innerHTML = '<p class="md-empty">Preview unavailable.</p>'; return; }
  prev.innerHTML = view === 'rendered' ? renderMarkdown(content) : `<pre class="md-raw">${esc(content)}</pre>`;
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

  mdCache.clear();
  diffState = { files, chunks: splitPatch(c.patch) };
  const toggle = document.querySelector('#patch-toggle');
  toggle.hidden = !c.patch;
  toggle.textContent = 'Show patch';
  toggle.setAttribute('aria-expanded', 'false');
  wrap.hidden = false;
}

// ---------- history ----------
// Engine pipeline status -> [color family, label]; same statuses (and the same
// family colors) as the main Maestro UI's statusPill.
function historyPill(status) {
  if (status === 'done') return ['green', 'Done'];
  if (status === 'paused' || status === 'pausing') return ['amber', 'Paused'];
  if (status === 'interrupted') return ['amber', 'Interrupted'];
  if (status === 'error') return ['red', 'Error'];
  if (status === 'stopped') return ['red', 'Stopped'];
  if (status === 'running' || status === 'starting') return ['blue', 'Running'];
  return ['dim', status || 'Unknown'];
}

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
    const [family, text] = historyPill(h.status);
    const name = h.projectName || h.title;
    li.innerHTML = `<button type="button" class="hist-btn" data-hist-id="${h.id}">
      <span class="hist-project">${name}</span>
      <span class="hist-pill ${family}"><i class="pdot"></i>${text}</span></button>` +
      (h.resumable ? `<button type="button" class="hist-resume"
        aria-label="Resume the ${name} run from ${when}" title="Resume run">Resume</button>` : '') +
      `<button type="button" class="hist-delete" aria-label="Delete the ${name} run from ${when}" title="Delete run">✕</button>`;
    li.querySelector('.hist-btn').addEventListener('click', () => showHistoryDetail(h.id));
    li.querySelector('.hist-resume')?.addEventListener('click', () => resumeRun(h.id));
    li.querySelector('.hist-delete').addEventListener('click', () => deleteHistory(h));
    list.append(li);
  }
  wrap.hidden = false;
}

// removes the run's store dir, plan/review files and local branch + worktree
async function deleteHistory(h) {
  const name = h.projectName || h.title;
  if (!window.confirm(`Delete the ${name} run? This removes its files and local branch. The project itself is untouched.`)) return;
  try {
    const res = await fetch(`/api/enable/history/${h.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      window.alert(body.error || `Could not delete the run (${res.status}).`);
      return;
    }
  } catch { return; }
  loadHistory();
}

async function showHistoryDetail(id) {
  let d;
  try {
    const res = await fetch(`/api/enable/history/${id}`);
    if (!res.ok) return;
    d = await res.json();
  } catch { return; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
  stopLiveMeter();
  currentRunId = null;                       // disk view, no live socket
  markHistoryActive(id);
  currentHistoryId = id;                      // .md preview reads from this run's dir
  const e = d.entry || {};
  lastProjectDir = e.projectDir || e.projectName || '';   // for the graph button on this view
  const est = e.estimatedCost;
  const realCost = e.totalCostUsd > 0 ? e.totalCostUsd : null;
  const _stats = {
    elapsedMs: Number.isFinite(e.totalActiveMs) && e.totalActiveMs > 0 ? e.totalActiveMs : null,
    costUsd: realCost,
    estimated: realCost == null && !!est,
    estLow: est?.low, estHigh: est?.high,
    tokens: null,                            // not persisted for past runs
  };
  renderResults({ ...(d.readiness || {}), branch: e.branch ?? null, _stats });
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
  loadWorkspaces();
  loadHistory();
  buildSetupForm();

  document.querySelector('#go-setup').addEventListener('click', () => {
    const target = currentTarget();
    const err = document.querySelector('#home-error');
    const ready = target === 'workspace' ? !!chosenWorkspaceId() : !!chosenProjectDir();
    if (!ready) {
      err.textContent = target === 'workspace' ? 'Pick a workspace first.' : 'Pick a project or paste a path first.';
      err.hidden = false;
      return;
    }
    err.hidden = true;
    show('setup');
    if (target === 'project') refreshEstimate();   // no per-repo estimate for workspaces yet
  });

  for (const btn of document.querySelector('#target-seg').querySelectorAll('.seg-btn')) {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      document.querySelector(`input[name="target"][value="${target}"]`).checked = true;
      setTargetPane(target);
    });
  }

  document.querySelector('#setup-form').addEventListener('change', scheduleEstimate);
  document.querySelector('#setup-form').addEventListener('input', scheduleEstimate);
  document.querySelector('#mock-toggle').addEventListener('change', refreshEstimate);

  document.querySelector('#browse-btn').addEventListener('click', openPicker);
  document.querySelector('#todo-btn').addEventListener('click', createTodoTasks);
  const picker = document.querySelector('#picker-modal');
  picker.addEventListener('click', (e) => {
    if (e.target.closest('[data-pclose]')) { closePicker(); return; }
    const item = e.target.closest('.picker-item');
    if (item) loadPicker(item.dataset.path);
  });
  document.querySelector('#picker-up').addEventListener('click', (e) => {
    const p = e.currentTarget.dataset.parent;
    if (p) loadPicker(p);
  });
  document.querySelector('#picker-choose').addEventListener('click', () => {
    if (pickerDir) {
      document.querySelector('#project-path').value = pickerDir;
      document.querySelector('#project-select').value = '';
      refreshBranches();
    }
    closePicker();
  });
  const onProjectChange = () => { refreshBranches(); refreshGraphButtons(chosenProjectDir()); };
  document.querySelector('#project-select').addEventListener('change', onProjectChange);
  document.querySelector('#project-path').addEventListener('change', onProjectChange);
  document.querySelector('#home-graph-btn').addEventListener('click', () => openGraph(graphProject, 'home'));
  document.querySelector('#results-graph-btn').addEventListener('click', () => openGraph(graphProject, 'results'));
  document.querySelector('#graph-back').addEventListener('click', () => show(graphReturn));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !picker.hidden) closePicker();
  });

  document.querySelector('#setup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    start(currentTarget(), collectAnswers());
  });

  document.querySelector('#nav-new').addEventListener('click', () => {
    if (ws) { try { ws.close(); } catch {} }
    loadHistory();
    show('home');
  });

  for (const b of document.querySelectorAll('[data-back]')) {
    b.addEventListener('click', () => {
      if (ws) { try { ws.close(); } catch {} }
      if (b.dataset.back === 'home') loadHistory();   // pick up the run that just finished
      show(b.dataset.back);
    });
  }

  document.querySelector('#patch-toggle').addEventListener('click', () => openDiffModal(0));

  document.querySelector('#changes-files').addEventListener('click', (e) => {
    const row = e.target.closest('.file-row');
    if (!row) return;
    openDiffModal(Math.max(0, chunkIndexForPath(row.dataset.path)));
  });

  const modal = document.querySelector('#diff-modal');
  modal.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) { closeDiffModal(); return; }
    const view = e.target.closest('.diff-view-toggle [data-view]');
    if (view) { switchDiffView(view); return; }
    const item = e.target.closest('.diff-file-item');
    if (item) focusDiffFile(Number(item.dataset.idx));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeDiffModal();
  });

  document.querySelector('#details-toggle').addEventListener('click', () => {
    const raw = document.querySelector('#raw-log');
    const toggle = document.querySelector('#details-toggle');
    raw.hidden = !raw.hidden;
    toggle.textContent = raw.hidden ? 'Show details' : 'Hide details';
    toggle.setAttribute('aria-expanded', String(!raw.hidden));
  });

  document.querySelector('#pause-btn').addEventListener('click', pauseRun);
  document.querySelector('#resume-btn').addEventListener('click', () => {
    if (currentPipelineId) resumeRun(currentPipelineId);
  });

  // test-only hook (JSDOM suites drive frames without a real socket)
  window.__enableTest = {
    handle,
    setRun(runId, pipelineId) { currentRunId = runId; currentPipelineId = pipelineId; },
  };
}

document.addEventListener('DOMContentLoaded', init);
