// maestro UI client. Vanilla ESM, no framework, no build step.

const $ = (sel, root = document) => (root || document).querySelector(sel);
const $$ = (sel, root = document) => [...(root || document).querySelectorAll(sel)];

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
const state = {
  ws: null,
  wsReady: false,
  helloSubscribed: new Set(), // runIds we've already sent a backfill subscribe for this socket
  projectDir: '',
  projects: [], // saved {name, path, exists} registry, loaded from /api/projects
  config: { steps: {}, customModels: [] }, // per-project model/effort selections
  models: [], // predefined + custom, from /api/config
  efforts: [], // effort levels, from /api/config
};

// UI tracker step roles, in order. (Mirrors the server's AGENT_STEPS keys; the
// server is authoritative — see loadConfig, which also receives data.steps.)
const STEP_ROLES = ['planner', 'refiner', 'implementer', 'reviewer'];

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------
const el = {
  wsDot: $('#ws-dot'),
  wsLabel: $('#ws-label'),

  form: $('#run-form'),
  projectSelect: $('#projectSelect'),
  projectDelete: $('#project-delete'),
  projectHint: $('#projectHint'),
  addProject: $('#add-project'),
  newProjectName: $('#newProjectName'),
  newProjectPath: $('#newProjectPath'),
  addProjectSave: $('#addProjectSave'),
  addProjectCancel: $('#addProjectCancel'),
  addProjectMsg: $('#addProjectMsg'),
  title: $('#title'),
  sourceRadios: $$('input[name="source"]'),
  promptPane: $('#prompt-pane'),
  markdownPane: $('#markdown-pane'),
  prompt: $('#prompt'),
  promptMarkdown: $('#promptMarkdown'),
  mdFile: $('#mdFile'),
  mdFileName: $('#mdFileName'),
  extras: $('#extras'),
  extrasNote: $('#extrasNote'),
  maxRefine: $('#maxRefine'),
  maxReview: $('#maxReview'),
  mock: $('#mock'),
  installBtn: $('#install-btn'),
  startBtn: $('#start-btn'),
  formMsg: $('#form-msg'),

  pipelineConfig: $('#pipeline-config'),

  history: $('#history'),
  refreshHistory: $('#refresh-history'),
  navHistoryCount: $('#nav-history-count'),

  viewerCard: $('#viewer-card'),
  viewerTitle: $('#viewer-title'),
  viewer: $('#viewer'),
  viewerClose: $('#viewer-close'),
};

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws`;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.wsReady = true;
    // A reconnect yields a fresh `hello`; backfill subscribes are driven from
    // there (handleServerMessage), not re-sent here. Reset the per-socket
    // dedupe set so the new socket re-subscribes to still-live runs.
    state.helloSubscribed = new Set();
    setWsStatus(true);
  });

  ws.addEventListener('message', (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handleServerMessage(msg);
  });

  ws.addEventListener('close', () => {
    state.wsReady = false;
    setWsStatus(false);
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });
}

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, 1500);
}

function setWsStatus(on) {
  el.wsDot.className = 'dot ' + (on ? 'dot-on' : 'dot-off');
  el.wsLabel.textContent = on ? 'connected' : 'disconnected';
}

// ---------------------------------------------------------------------------
// Server message router. Multi-run: every run's events arrive here (the server
// broadcasts every run to every socket). Each event carries its own runId; we
// fan it out to the matching per-run model.
// ---------------------------------------------------------------------------
function handleServerMessage(msg) {
  if (!msg || !msg.type) return;

  if (msg.type === 'hello') {
    onHello(msg);
    return;
  }

  // Tagged per-run event. Ignore anything without a runId.
  if (!msg.runId) return;
  const r = upsertRun({ runId: msg.runId });

  switch (msg.type) {
    case 'phase':
      onPhase(r, msg);
      break;
    case 'log':
      onLog(r, msg);
      break;
    case 'question':
      onQuestion(r, msg);
      break;
    case 'artifact':
      onArtifact(r, msg);
      break;
    case 'state':
      onState(r, msg);
      break;
    case 'done':
      onDone(r, msg);
      break;
    case 'error':
      onError(r, msg);
      break;
    default:
      break;
  }

  updateNavCounts();
  // If the user is already on the Running view, build/repaint cards now.
  // Without this, a run this tab didn't start (begun in another tab or via the
  // /maestro CLI — the server sends `hello` only once per socket and broadcasts
  // later runs purely as tagged events) would bump the nav badge but never
  // render a card until the user navigated away and back. renderRunningView
  // diffs by data-run-id and reuses r.el, so this is cheap + idempotent.
  if (currentView() === 'running') renderRunningView();
}

// hello greeting carries the server's authoritative run list. We upsert each
// into our map, backfill-subscribe to non-terminal runs whose buffer we don't
// yet have, and refresh whatever view is showing.
function onHello(msg) {
  const ws = state.ws;
  const list = Array.isArray(msg.runs) ? msg.runs : [];
  for (const r0 of list) {
    if (!r0 || !r0.runId) continue;
    upsertRun({
      runId: r0.runId,
      title: r0.title,
      projectDir: r0.projectDir,
      status: r0.status,
      startedAt: r0.startedAt,
      pendingQuestion: r0.pendingQuestion || null,
    });

    const nonTerminal =
      r0.status === 'starting' || r0.status === 'running' || (r0.pendingQuestion != null);
    // Backfill that run's buffered events exactly once per socket. (Runs started
    // by THIS tab already stream live via broadcast and were not in any prior
    // hello, so they get subscribed here only if a reconnect re-lists them.)
    if (nonTerminal && ws && state.wsReady && !state.helloSubscribed.has(r0.runId)) {
      state.helloSubscribed.add(r0.runId);
      try {
        ws.send(JSON.stringify({ type: 'subscribe', runId: r0.runId }));
      } catch {
        /* ignore */
      }
    }
    // Terminal runs (done|error|stopped) are simply excluded from liveRuns().
  }

  updateNavCounts();
  const cur = currentView();
  if (cur === 'running') renderRunningView();
  if (cur === 'history') {
    const d = selectedProjectPath();
    if (d) loadHistory(d);
  }
}

function currentView() {
  const h = location.hash.slice(1);
  return VIEW_NAMES.includes(h) ? h : 'new';
}

// ---------------------------------------------------------------------------
// Steps tracker
// ---------------------------------------------------------------------------
// Canonical order of phases for "everything before current => done".
const STEP_ORDER = ['preflight', 'plan', 'refine', 'implement', 'review', 'done'];

// Normalize a core phase name to one of our tracker step keys.
// Order matters: more specific phases ("refine", "review", "implement") are
// matched before the generic "plan"/"clarify" fallback, because names like
// "plan-refine" contain the substring "plan".
function normalizePhase(phase) {
  if (!phase) return null;
  const p = String(phase).toLowerCase();
  if (p.includes('preflight')) return 'preflight';
  if (p.includes('refine')) return 'refine';
  if (p.includes('review')) return 'review';
  if (p.includes('implement')) return 'implement';
  if (p.includes('done') || p.includes('complete') || p.includes('finish')) return 'done';
  if (p.includes('clarify') || p.includes('plan')) return 'plan';
  return null;
}

// ---------------------------------------------------------------------------
// Multi-run engine: per-run model + Map. Each run renders into one card in the
// Running view; events are fanned out by handleServerMessage.
// ---------------------------------------------------------------------------
const runs = new Map();

function nowHMS() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function makeRun({ runId, title, projectDir, status = 'running', startedAt, local = false, pendingQuestion = null }) {
  return {
    runId,
    title: title || '(untitled)',
    projectDir: projectDir || '',
    status,
    startedAt: startedAt || nowHMS(),
    local,
    maxStepIdx: -1,
    phaseKey: 'preflight',
    cycle: 0,
    phaseStatus: '',
    costByStage: {},   // { stageKey: usd } for the live stepper
    totalCostUsd: 0,   // pipeline total for the card meta line
    pendingQuestion,
    configSnapshot: null,
    logLines: [],
    el: null,
    _finished: false,
  };
}

// Upsert a run model. Only assigns DEFINED keys from the partial, and callers
// must never pass logLines/el/configSnapshot in a partial — those heavy/DOM
// fields are owned locally and must not be clobbered by a hello/tagged event.
function upsertRun(partial) {
  let r = runs.get(partial.runId);
  if (!r) {
    r = makeRun(partial);
    runs.set(partial.runId, r);
  } else {
    for (const k of Object.keys(partial)) {
      if (partial[k] !== undefined) r[k] = partial[k];
    }
  }
  return r;
}

// ---------------------------------------------------------------------------
// Per-run event handlers
// ---------------------------------------------------------------------------
function onPhase(r, msg) {
  const key = normalizePhase(msg.phase);
  if (key) {
    const idx = STEP_ORDER.indexOf(key);
    if (idx > r.maxStepIdx) r.maxStepIdx = idx;
    r.phaseKey = key;
    if (msg.cycle) r.cycle = msg.cycle;
    r.phaseStatus = msg.status || '';
  }
  // The "done" phase marks all steps complete.
  if (key === 'done' || (msg.phase && String(msg.phase).toLowerCase().includes('done'))) {
    r.maxStepIdx = STEP_ORDER.indexOf('done');
    r.phaseKey = 'done';
  }
  // Surface the phase transition in the run's log.
  const cyc = msg.cycle ? ` #${msg.cycle}` : '';
  const st = msg.status ? ` (${msg.status})` : '';
  onLog(r, { source: 'phase', level: 'phase', text: `${msg.phase}${cyc}${st}`, ts: Date.now() });
  maybeResume(r);
  paintRunCard(r);
}

// A submitted answer is only confirmed resumed when the next phase/state event
// for this run arrives (the server returns 200 even for a stale id, so HTTP
// success is not proof). Clear the pending question + panel here.
function maybeResume(r) {
  if (!r._answering) return;
  r._answering = false;
  r.pendingQuestion = null;
  clearQpanel(r);
}

// Format a USD amount. null/NaN -> '' (caller decides the default). A positive
// sub-cent value -> '<$0.01' so genuine spend is never hidden as a flat $0.00.
// 0 -> '$0.00' (a truthful mock zero, never blanked).
function fmtUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  if (v > 0 && v < 0.01) return '<$0.01';
  return '$' + v.toFixed(2);
}

// Exact tenth-of-a-cent dollar string for tooltips (the backend tracks 4 dp,
// the visible chip is rounded to 2). '' for non-finite input.
function fmtUsd4(n) {
  const v = Number(n);
  return Number.isFinite(v) ? '$' + v.toFixed(4) : '';
}

// Tooltip text for any cost figure: marks it as Claude Code's client-side
// estimate (not a bill) and reveals the exact value. '' when there's no number.
function estTitle(n) {
  const exact = fmtUsd4(n);
  return exact
    ? `Estimated cost ${exact} — Claude Code client-side estimate (total_cost_usd), not authoritative billing`
    : '';
}

// Roll saved per-step costs up into UI stage buckets. normalizePhase folds
// clarify->plan, refine#1+refine#2->refine, implement+fixes->implement, etc.
// A stage is keyed IFF its step carries a costUsd field (i.e. a result event was
// attributed to it) — so an executed-but-zero phase (mock) buckets as 0 and
// renders $0.00, while a phase that never ran (field absent) stays blank.
// Negative/NaN are dropped defensively. Returns { stageKey: number }.
function costByStage(steps) {
  const out = {};
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || s.costUsd == null) continue; // field absent => phase never recorded a cost
    const c = Number(s.costUsd);
    if (!Number.isFinite(c) || c < 0) continue; // ignore bogus; KEEP zero
    const key = normalizePhase(s.phase);
    if (key) out[key] = (out[key] || 0) + c;
  }
  return out;
}

function onState(r, msg) {
  if (msg.status) r.status = msg.status;
  if (msg.startedAt) r.startedAt = msg.startedAt;
  if (Array.isArray(msg.steps)) r.costByStage = costByStage(msg.steps);
  if (typeof msg.totalCostUsd === 'number') r.totalCostUsd = msg.totalCostUsd;
  if (msg.phase) {
    const key = normalizePhase(msg.phase);
    if (key) {
      const idx = STEP_ORDER.indexOf(key);
      if (idx > r.maxStepIdx) r.maxStepIdx = idx;
      r.phaseKey = key;
    }
  }
  if (msg.cycle) r.cycle = msg.cycle;
  maybeResume(r);
  paintRunCard(r);
}

// ---------------------------------------------------------------------------
// Per-step model + effort config
// ---------------------------------------------------------------------------
async function loadConfig(projectDir) {
  try {
    // No project => omit projectDir; the server replies with the built-in models
    // so the picker always shows Opus/Sonnet/Haiku, even on a fresh clone.
    const qs = projectDir ? `?projectDir=${encodeURIComponent(projectDir)}` : '';
    const res = await fetch(`/api/config${qs}`);
    const data = await safeJson(res);
    if (!res.ok) return;
    state.config = data.config || { steps: {}, customModels: [] };
    state.models = Array.isArray(data.models) ? data.models : [];
    state.efforts = Array.isArray(data.efforts) ? data.efforts : [];
  } catch {
    /* keep last-known config */
  }
  renderStepConfigs();
}

function modelById(id) {
  return state.models.find((m) => m.id === id) || null;
}

function option(value, text) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  return o;
}

function renderStepConfigs() {
  // Config always edits the NEXT run, so selectors are never locked. (The
  // multi-run engine in Task 3 owns per-run status; there is no global run
  // status to gate on anymore.)
  const locked = false;

  for (const role of STEP_ROLES) {
    const modelSel = document.querySelector(`.step-model[data-role="${role}"]`);
    const effortSel = document.querySelector(`.step-effort[data-role="${role}"]`);
    const caption = document.querySelector(`.step-current[data-role="${role}"]`);
    if (!modelSel || !effortSel) continue;

    const sel = state.config.steps[role] || {};

    // Model dropdown: "(default model)" + every model + "+ Add model…".
    modelSel.innerHTML = '';
    modelSel.appendChild(option('', '(default model)'));
    state.models.forEach((m) => modelSel.appendChild(option(m.id, m.label + (m.custom ? ' ·custom' : ''))));
    modelSel.appendChild(option('__add__', '+ Add model…'));
    modelSel.value = sel.model || '';

    // Effort dropdown: filtered to the selected model's supported efforts.
    const model = modelById(modelSel.value);
    effortSel.innerHTML = '';
    effortSel.appendChild(option('', '(default effort)'));
    (model ? model.efforts : []).forEach((e) => effortSel.appendChild(option(e, e)));
    effortSel.value = sel.effort && model && model.efforts.includes(sel.effort) ? sel.effort : '';

    modelSel.disabled = locked;
    effortSel.disabled = locked || !model; // no model picked => effort is meaningless

    if (caption) {
      const mLabel = model ? model.label : 'default model';
      caption.textContent = `${mLabel} · ${effortSel.value || 'default effort'}`;
    }
  }
}

async function saveStep(role, model, effort) {
  const projectDir = selectedProjectPath();
  if (!projectDir) return;
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, step: role, model, effort }),
    });
    const data = await safeJson(res);
    if (!res.ok) {
      appendLog({ source: 'ui', level: 'error', text: `config: ${data.error || res.status}`, ts: Date.now() });
      renderStepConfigs(); // revert UI to the last persisted state
      return;
    }
    state.config = data.config || state.config;
    renderStepConfigs();
  } catch (e) {
    appendLog({ source: 'ui', level: 'error', text: `config error: ${e.message}`, ts: Date.now() });
  }
}

async function addModelFlow(role) {
  const projectDir = selectedProjectPath();
  if (!projectDir) return;
  const id = (window.prompt('New model id (e.g. claude-opus-4-8 or a fine-tune id):') || '').trim();
  if (!id) { renderStepConfigs(); return; } // user cancelled -> restore selection
  const label = (window.prompt('Display name (optional):', id) || '').trim();
  try {
    const res = await fetch('/api/config/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, id, label }),
    });
    const data = await safeJson(res);
    if (!res.ok) {
      appendLog({ source: 'ui', level: 'error', text: `add model: ${data.error || res.status}`, ts: Date.now() });
      renderStepConfigs();
      return;
    }
    state.models = Array.isArray(data.models) ? data.models : state.models;
    await saveStep(role, id, ''); // select the new model for this step (effort reset)
  } catch (e) {
    appendLog({ source: 'ui', level: 'error', text: `add model error: ${e.message}`, ts: Date.now() });
    renderStepConfigs();
  }
}

// Delegated change handler for all step selects. The selects live in the
// #pipeline-config block (cached as el.pipelineConfig); each carries data-role.
el.pipelineConfig.addEventListener('change', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLSelectElement)) return;
  const role = t.dataset.role;
  if (!role) return;

  if (t.classList.contains('step-model')) {
    if (t.value === '__add__') return addModelFlow(role);
    // New model -> reset effort (old effort may be unsupported by the new model).
    saveStep(role, t.value, '');
  } else if (t.classList.contains('step-effort')) {
    const model = (state.config.steps[role] || {}).model || '';
    saveStep(role, model, t.value);
  }
});

// ---------------------------------------------------------------------------
// Log window
// ---------------------------------------------------------------------------
const MAX_LOG_LINES = 4000;

// Build one .log-line node from a normalized log record. (Same DOM shape the
// old global appendLog produced: ts/src/msg spans + lvl class.)
function buildLogLine({ source, level, text, ts }) {
  const line = document.createElement('div');
  line.className = 'log-line lvl-' + (level || 'info');

  const t = document.createElement('span');
  t.className = 'log-ts';
  t.textContent = fmtTime(ts);

  const s = document.createElement('span');
  s.className = 'log-src';
  s.textContent = source ? `[${source}]` : '';

  const m = document.createElement('span');
  m.className = 'log-msg';
  m.textContent = String(text);

  line.append(t, s, m);
  return line;
}

// Per-run log: push to the model and, if the card is mounted, append the line.
function onLog(r, msg) {
  const text = msg.text;
  if (text === undefined || text === null) return;
  const rec = { ts: msg.ts != null ? msg.ts : Date.now(), source: msg.source, level: msg.level, text };
  r.logLines.push(rec);
  if (r.logLines.length > MAX_LOG_LINES) r.logLines.shift();

  if (r.el) {
    const logEl = r.el.querySelector('.log');
    if (logEl) {
      logEl.appendChild(buildLogLine(rec));
      while (logEl.childElementCount > MAX_LOG_LINES) logEl.removeChild(logEl.firstChild);
      const sw = r.el.querySelector('.switch.autoscroll');
      if (sw && sw.classList.contains('on')) logEl.scrollTop = logEl.scrollHeight;
    }
  }
}

function onArtifact(r, msg) {
  onLog(r, {
    source: 'artifact',
    level: 'artifact',
    text: `${msg.kind || 'file'}: ${msg.path || ''}`,
    ts: Date.now(),
  });
}

// Non-run-scoped UI notices (config/answer/install errors). There is no global
// log surface anymore, so route these to the console; keep the {source,level,
// text,ts} shape for call-site compatibility.
function appendLog({ source, level, text }) {
  if (text === undefined || text === null) return;
  const tag = source ? `[${source}]` : '';
  if (level === 'error') console.error(`maestro ${tag} ${text}`);
  else console.log(`maestro ${tag} ${text}`);
}

function fmtTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// ---------------------------------------------------------------------------
// Questions (clarify) and gates. The full question/gate UI is built INLINE into
// each run card's .qpanel slot (no global question card). onQuestion stores the
// pending question, builds the panel, and repaints (paintRunCard toggles
// .attention + paints the paused stepper).
// ---------------------------------------------------------------------------
function onQuestion(r, msg) {
  r.pendingQuestion = msg;
  // A new question supersedes any half-finished answer attempt.
  r._answering = false;
  if (r.el) renderQpanel(r);
  paintRunCard(r);
}

// The `?` glyph used in the panel head. Built fresh each call (a node can only
// live in one place in the DOM).
function questionIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '17');
  svg.setAttribute('height', '17');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M9.1 9a3 3 0 1 1 4.6 2.5c-.9.6-1.7 1.2-1.7 2.3');
  path.setAttribute('stroke-linecap', 'round');
  const circle = document.createElementNS(NS, 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '17.5');
  circle.setAttribute('r', '.5');
  circle.setAttribute('fill', 'currentColor');
  circle.setAttribute('stroke-width', '1.4');
  svg.append(path, circle);
  return svg;
}

// Filter a clarify question's options down to the real ones (the contract pads
// to 3 slots with '' — drop empty/whitespace).
function realOptions(q) {
  const opts = Array.isArray(q && q.options) ? q.options : [];
  return opts.filter((o) => typeof o === 'string' && o.trim() !== '');
}

// Build the inline question/gate panel into r.el's .qpanel from r.pendingQuestion,
// un-hide it, and wire its inputs. Idempotent: re-building replaces the content.
function renderQpanel(r) {
  if (!r.el) return;
  const panel = r.el.querySelector('.qpanel');
  if (!panel) return;
  const pq = r.pendingQuestion;
  panel.innerHTML = '';
  if (!pq) {
    panel.classList.add('hidden');
    return;
  }

  const isGate = pq.kind === 'gate' || Array.isArray(pq.issues);

  // ----- head -----
  const head = document.createElement('div');
  head.className = 'qpanel-head';
  head.appendChild(questionIcon());
  const title = document.createElement('b');
  if (isGate) {
    title.textContent = 'Cycle gate';
  } else {
    const phaseLabel = PHASE_LABEL[r.phaseKey] || 'Pipeline';
    title.textContent = `${phaseLabel} needs your input`;
  }
  head.appendChild(title);
  if (!isGate) {
    const n = realQuestions(pq).length;
    const count = document.createElement('span');
    count.className = 'qcount';
    count.textContent = `${n} question${n === 1 ? '' : 's'}`;
    head.appendChild(count);
  }
  panel.appendChild(head);

  if (isGate) renderGateBody(r, panel, pq);
  else renderClarifyBody(r, panel, pq);

  panel.classList.remove('hidden');
}

// Clarify questions with at least a question string. (questions may be [] when
// the planner had nothing to ask — handled separately with a note.)
function realQuestions(pq) {
  return (Array.isArray(pq && pq.questions) ? pq.questions : []).filter(
    (q) => q && typeof q.question === 'string' && q.question.trim() !== ''
  );
}

function renderClarifyBody(r, panel, pq) {
  const questions = realQuestions(pq);

  // r._answers maps a stable per-question key -> chosen value (option text or
  // free-text or ''). Rebuilt each render so it tracks the current markup.
  r._answers = [];

  if (questions.length === 0) {
    const note = document.createElement('div');
    note.className = 'gate-intro';
    note.textContent =
      'No specific questions — you can submit an empty answer to let the pipeline proceed.';
    panel.appendChild(note);
  }

  questions.forEach((q, i) => {
    const block = document.createElement('div');
    block.className = 'qblock';

    const text = document.createElement('div');
    text.className = 'qtext';
    const qn = document.createElement('span');
    qn.className = 'qn';
    qn.textContent = String(i + 1);
    text.appendChild(qn);
    text.appendChild(document.createTextNode(q.question));
    block.appendChild(text);

    const opts = realOptions(q);
    const slot = { id: q.id, question: q.question, choice: '' };
    r._answers.push(slot);

    // allowFreeText === false => options-only (no free-text input). Absent or
    // true keeps the input. When suppressed, slot.choice can only be set by an
    // option click; if none is picked it stays '' (submit yields '' gracefully).
    const showFree = q.allowFreeText !== false;

    const optsWrap = document.createElement('div');
    optsWrap.className = 'qopts';

    let free = null;
    if (showFree) {
      free = document.createElement('input');
      free.className = 'qfree';
      free.type = 'text';
      free.placeholder = 'Or type your own answer…';
    }

    opts.forEach((optText) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'qopt';
      btn.setAttribute('aria-pressed', 'false');
      btn.textContent = optText;
      btn.addEventListener('click', () => {
        // Select this option, clear siblings + the free-text field (if present).
        optsWrap.querySelectorAll('.qopt').forEach((b) => {
          const on = b === btn;
          b.classList.toggle('sel', on);
          b.setAttribute('aria-pressed', String(on));
        });
        if (free) {
          free.value = '';
          free.classList.remove('has');
        }
        slot.choice = optText;
      });
      optsWrap.appendChild(btn);
    });
    if (opts.length) block.appendChild(optsWrap);

    // Free-text input: typing clears any option selection and becomes the choice.
    if (free) {
      free.addEventListener('input', () => {
        const v = free.value;
        free.classList.toggle('has', v.trim() !== '');
        if (v.trim() !== '') {
          optsWrap.querySelectorAll('.qopt').forEach((b) => {
            b.classList.remove('sel');
            b.setAttribute('aria-pressed', 'false');
          });
        }
        slot.choice = v;
      });
      block.appendChild(free);
    }

    panel.appendChild(block);
  });

  // ----- foot: submit -----
  const foot = document.createElement('div');
  foot.className = 'qpanel-foot';
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'btn-go';
  const NS = 'http://www.w3.org/2000/svg';
  const play = document.createElementNS(NS, 'svg');
  play.setAttribute('width', '14');
  play.setAttribute('height', '14');
  play.setAttribute('viewBox', '0 0 24 24');
  play.setAttribute('fill', 'currentColor');
  const tri = document.createElementNS(NS, 'path');
  tri.setAttribute('d', 'M6 4l14 8-14 8V4Z');
  play.appendChild(tri);
  submit.appendChild(play);
  submit.appendChild(document.createTextNode('Submit answers & resume'));
  foot.appendChild(submit);
  panel.appendChild(foot);
}

function renderGateBody(r, panel, pq) {
  const issues = Array.isArray(pq.issues) ? pq.issues : [];

  const intro = document.createElement('div');
  intro.className = 'gate-intro';
  intro.textContent = issues.length
    ? 'This cycle reached its limit with open issues. Approve another cycle to keep iterating, or continue with what you have.'
    : 'This cycle reached its limit. Approve another cycle to keep iterating, or continue with what you have.';
  panel.appendChild(intro);

  if (issues.length) {
    const list = document.createElement('ul');
    list.className = 'issues';
    issues.forEach((iss) => {
      const sev = String((iss && iss.severity) || 'suggestion').toLowerCase();
      const li = document.createElement('li');
      li.className = `issue sev-${sev}`;

      const ihead = document.createElement('div');
      ihead.className = 'issue-head';
      const sevEl = document.createElement('span');
      sevEl.className = 'issue-sev';
      sevEl.textContent = sev;
      const titleEl = document.createElement('span');
      titleEl.className = 'issue-title';
      titleEl.textContent = (iss && iss.title) || '(untitled issue)';
      ihead.append(sevEl, titleEl);
      li.appendChild(ihead);

      if (iss && iss.detail) {
        const det = document.createElement('div');
        det.className = 'issue-detail';
        det.textContent = iss.detail;
        li.appendChild(det);
      }
      if (iss && iss.location) {
        const loc = document.createElement('div');
        loc.className = 'issue-loc';
        loc.textContent = iss.location;
        li.appendChild(loc);
      }
      list.appendChild(li);
    });
    panel.appendChild(list);
  }

  const foot = document.createElement('div');
  foot.className = 'qpanel-foot gate-actions';
  const cont = document.createElement('button');
  cont.type = 'button';
  cont.className = 'btn gate-continue';
  cont.textContent = "Don't approve another cycle and continue";
  const another = document.createElement('button');
  another.type = 'button';
  another.className = 'btn btn-primary gate-another';
  another.textContent = 'I approve another cycle';
  foot.append(cont, another);
  panel.appendChild(foot);
}

// Gather the clarify answers from the live model slots and POST them.
function submitAnswer(r) {
  const answers = (r._answers || []).map((s) => ({
    id: s.id,
    question: s.question,
    choice: typeof s.choice === 'string' ? s.choice.trim() : '',
  }));
  postAnswer(r, { answers });
}

// POST /api/answer for a run's pending question. On a transport/HTTP error we
// log to the card and re-enable the panel; on 200 we DON'T assume the run
// resumed (the server returns 200 even for a stale id) — we disable the panel,
// show a "Resuming…" affordance, set r._answering, and KEEP r.pendingQuestion.
// The panel is cleared only when the next phase/state event confirms resume.
async function postAnswer(r, payload) {
  if (!r || !r.pendingQuestion) return;
  // Re-entrancy guard: an answer is already in flight for this run. Without
  // this a synthetic/double click (or a re-triggered handler) could fire a
  // second POST before maybeResume clears _answering.
  if (r._answering) return;
  // Never post for a dead run.
  if (r._finished || isTerminalStatus(r.status)) return;
  const id = r.pendingQuestion.id;
  const runId = r.runId;

  setPanelBusy(r, true);
  r._answering = true;

  try {
    const res = await fetch('/api/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, id, payload }),
    });
    if (!res.ok) {
      const err = await safeJson(res);
      r._answering = false;
      setPanelBusy(r, false);
      onLog(r, { source: 'ui', level: 'error', text: `answer failed: ${err.error || res.status}`, ts: Date.now() });
      return;
    }
    // 200: keep pendingQuestion; wait for the next phase/state to confirm resume.
  } catch (e) {
    r._answering = false;
    setPanelBusy(r, false);
    onLog(r, { source: 'ui', level: 'error', text: `answer error: ${e.message}`, ts: Date.now() });
  }
}

// Single source of truth for "this run is over". The server's terminal statuses
// are done|error|stopped; the remaining synonyms are accepted defensively. Used
// by liveRuns (to exclude finished runs) and postAnswer (to refuse a late POST).
function isTerminalStatus(status) {
  const s = String(status || '').toLowerCase();
  return s === 'done' || s === 'error' || s === 'stopped' || s === 'aborted' || s === 'failed' || s === 'complete' || s === 'completed';
}

// Disable/enable the panel's interactive controls and reflect a "Resuming…"
// state on the primary button while an answer is in flight / awaiting resume.
function setPanelBusy(r, busy) {
  if (!r.el) return;
  const panel = r.el.querySelector('.qpanel');
  if (!panel) return;
  panel.querySelectorAll('button, input').forEach((node) => {
    node.disabled = busy;
  });
  const primary = panel.querySelector('.btn-go, .gate-another');
  if (primary && busy && !primary.dataset.label) {
    primary.dataset.label = primary.textContent;
    primary.textContent = 'Resuming…';
  } else if (primary && !busy && primary.dataset.label) {
    primary.textContent = primary.dataset.label;
    delete primary.dataset.label;
  }
}

// Empty + hide a run's qpanel and drop its attention ring. Used on resume and
// from finishRun's terminal path.
function clearQpanel(r) {
  if (!r.el) return;
  const panel = r.el.querySelector('.qpanel');
  if (panel) {
    panel.innerHTML = '';
    panel.classList.add('hidden');
  }
  r.el.classList.remove('attention');
}

// ---------------------------------------------------------------------------
// Done / error — converge to a single idempotent terminal path.
//
// The server fires BOTH `error` and `done` on an error, and a stop emits
// state(stopped) -> done. finishRun is guarded by r._finished so the second
// call no-ops. On finish we paint the terminal stepper, drop the card from the
// live view, refresh History for that project, then client-evict the heavy
// fields (logLines/el) while keeping the model in the map so a duplicate
// hello/event won't recreate it fresh.
// ---------------------------------------------------------------------------
function finishRun(r, status) {
  if (r._finished) return;
  r._finished = true;
  r.status = status;
  r.pendingQuestion = null;
  r._answering = false;

  // Clear the card's qpanel + attention before it drops out.
  if (r.el) {
    clearQpanel(r);
    // Paint the terminal stepper one last time while the card still exists.
    paintStepper(r);
  }

  const projectDir = r.projectDir;
  // Card drops out of the live view (liveRuns excludes terminal statuses).
  renderRunningView();
  updateNavCounts();
  if (projectDir && projectDir === selectedProjectPath()) loadHistory(projectDir);

  // Client-evict heavy fields; keep the model so a stray duplicate event/hello
  // re-upserts onto the (already _finished) model rather than a fresh one.
  r.logLines = [];
  r.el = null;
}

function onDone(r, msg) {
  finishRun(r, msg.status || 'done');
}

function onError(r) {
  finishRun(r, 'error');
}

// ---------------------------------------------------------------------------
// Form: source toggle, file loading
// ---------------------------------------------------------------------------
function syncSourceToggle() {
  const val = (el.sourceRadios.find((r) => r.checked) || {}).value || 'prompt';
  el.promptPane.classList.toggle('hidden', val !== 'prompt');
  el.markdownPane.classList.toggle('hidden', val !== 'markdown');
}
el.sourceRadios.forEach((r) => r.addEventListener('change', syncSourceToggle));

// Segmented Task-source toggle. The .seg buttons are the visible control; the
// hidden radios (input[name="source"]) remain the source of truth read at submit.
$$('#source-seg button[data-src]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const src = btn.dataset.src;
    $$('#source-seg button[data-src]').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const radio = el.sourceRadios.find((r) => r.value === src);
    if (radio) radio.checked = true;
    syncSourceToggle();
  });
});

// Mock switch. The visible .switch mirrors the hidden #mock checkbox, which is
// what the submit handler reads (el.mock.checked).
const mockSwitch = $('#mock-switch');
function toggleMock() {
  const on = !el.mock.checked;
  el.mock.checked = on;
  mockSwitch.classList.toggle('on', on);
  mockSwitch.setAttribute('aria-checked', String(on));
}
if (mockSwitch) {
  mockSwitch.addEventListener('click', toggleMock);
  mockSwitch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      toggleMock();
    }
  });
}

// File-picker buttons trigger their (hidden) <input type=file>.
$$('.pick[data-pick]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.pick === 'md') el.mdFile.click();
    else if (btn.dataset.pick === 'extras') el.extras.click();
  });
});

el.mdFile.addEventListener('change', async () => {
  const f = el.mdFile.files && el.mdFile.files[0];
  if (!f) return;
  el.mdFileName.textContent = f.name;
  try {
    const text = await f.text();
    el.promptMarkdown.value = text;
  } catch (e) {
    el.mdFileName.textContent = `failed to read: ${e.message}`;
  }
});

el.extras.addEventListener('change', () => {
  const files = el.extras.files;
  if (files && files.length) {
    const names = [...files].map((f) => f.name).join(', ');
    el.extrasNote.textContent = `${files.length} file(s) will be uploaded and copied into the pipeline's extras/ folder: ${names}`;
  } else {
    el.extrasNote.textContent = 'Reference files for context (kept with the pipeline record).';
  }
});

// Read a File as base64 (without the data: URL prefix).
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

// Collect the selected extra files as [{ name, dataBase64 }] for upload.
async function collectExtras() {
  const files = el.extras.files ? [...el.extras.files] : [];
  const out = [];
  for (const f of files) {
    try {
      const dataBase64 = await fileToBase64(f);
      out.push({ name: f.name, dataBase64 });
    } catch {
      /* skip unreadable file */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Project registry: dropdown + inline add-form + delete.
// ---------------------------------------------------------------------------
const LAST_PROJECT_KEY = 'maestro.lastProject';

function selectedProjectPath() {
  const v = el.projectSelect.value;
  return !v || v === '__add__' ? '' : v;
}

function selectedProjectName() {
  const opt = el.projectSelect.selectedOptions && el.projectSelect.selectedOptions[0];
  return opt && opt.dataset ? opt.dataset.name || '' : '';
}

async function loadProjects(selectName) {
  try {
    const res = await fetch('/api/projects');
    const data = await safeJson(res);
    state.projects = data && Array.isArray(data.projects) ? data.projects : [];
  } catch {
    state.projects = [];
  }
  renderProjectOptions(selectName);
}

function renderProjectOptions(selectName) {
  const want = selectName || localStorage.getItem(LAST_PROJECT_KEY) || '';
  el.projectSelect.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.disabled = true;
  placeholder.textContent = state.projects.length ? 'Select a project…' : 'No projects yet';
  el.projectSelect.appendChild(placeholder);

  state.projects.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.path;
    opt.dataset.name = p.name;
    opt.textContent = p.exists ? p.name : `${p.name} (missing)`;
    el.projectSelect.appendChild(opt);
  });

  const add = document.createElement('option');
  add.value = '__add__';
  add.textContent = '+ Add project…';
  el.projectSelect.appendChild(add);

  // Restore by index (not value) so duplicate paths can't pick the wrong name.
  const idx = state.projects.findIndex((p) => p.name === want);
  if (idx >= 0) el.projectSelect.selectedIndex = idx + 1; // +1 past the placeholder
  else placeholder.selected = true;

  onProjectChanged();
}

function onProjectChanged() {
  const path = selectedProjectPath();
  el.projectDelete.disabled = !path;
  if (path) {
    state.projectDir = path;
    localStorage.setItem(LAST_PROJECT_KEY, selectedProjectName());
    loadHistory(path);
    loadConfig(path);
  } else {
    state.projectDir = '';
    // No project yet: still load the built-in models so the picker isn't empty.
    loadConfig('');
  }
}

el.projectSelect.addEventListener('change', () => {
  if (el.projectSelect.value === '__add__') {
    openAddProject();
    return;
  }
  hideAddProject();
  onProjectChanged();
});

function openAddProject() {
  el.addProject.classList.remove('hidden');
  el.newProjectName.value = '';
  el.newProjectPath.value = '';
  setAddMsg('');
  el.newProjectName.focus();
}

function hideAddProject() {
  el.addProject.classList.add('hidden');
}

function setAddMsg(text, kind) {
  el.addProjectMsg.textContent = text || '';
  el.addProjectMsg.className = 'hint' + (kind ? ' ' + kind : '');
}

el.addProjectCancel.addEventListener('click', () => {
  hideAddProject();
  renderProjectOptions(localStorage.getItem(LAST_PROJECT_KEY) || '');
});

el.addProjectSave.addEventListener('click', async () => {
  const name = el.newProjectName.value.trim();
  const projPath = el.newProjectPath.value.trim();
  if (!name) return setAddMsg('Name is required.', 'err');
  if (!projPath) return setAddMsg('Path is required.', 'err');
  el.addProjectSave.disabled = true;
  try {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, path: projPath }),
    });
    const data = await safeJson(res);
    if (!res.ok) {
      setAddMsg(data.error || `HTTP ${res.status}`, 'err');
      return;
    }
    state.projects = Array.isArray(data.projects) ? data.projects : state.projects;
    hideAddProject();
    renderProjectOptions(name); // auto-select the newly added project
  } catch (e) {
    setAddMsg(e.message, 'err');
  } finally {
    el.addProjectSave.disabled = false;
  }
});

el.projectDelete.addEventListener('click', async () => {
  const name = selectedProjectName();
  if (!name) return;
  if (!confirm(`Remove "${name}" from the project list? Files on disk are not touched.`)) return;
  el.projectDelete.disabled = true;
  try {
    const res = await fetch(`/api/projects?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    const data = await safeJson(res);
    if (!res.ok) {
      setFormMsg(`Delete failed: ${data.error || res.status}`, 'err');
      el.projectDelete.disabled = false;
      return;
    }
    state.projects = Array.isArray(data.projects) ? data.projects : [];
    if (localStorage.getItem(LAST_PROJECT_KEY) === name) localStorage.removeItem(LAST_PROJECT_KEY);
    state.projectDir = '';
    el.history.innerHTML = '';
    el.history.appendChild(histEmpty('Select a project to load history.'));
    renderProjectOptions('');
  } catch (e) {
    setFormMsg(`Delete error: ${e.message}`, 'err');
    el.projectDelete.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Start a run
// ---------------------------------------------------------------------------
el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  setFormMsg('', '');

  const projectDir = selectedProjectPath();
  if (!projectDir) return setFormMsg('Select a project first (or add one).', 'err');

  const source = (el.sourceRadios.find((r) => r.checked) || {}).value || 'prompt';
  const promptText = el.prompt.value.trim();
  const mdText = el.promptMarkdown.value.trim();
  const title = el.title.value.trim();

  const body = {
    projectDir,
    title: title || undefined,
    maxRefine: Number(el.maxRefine.value) || 5,
    maxReview: Number(el.maxReview.value) || 5,
    mock: el.mock.checked,
  };

  if (source === 'markdown') {
    if (!mdText) return setFormMsg('Provide markdown text or load a .md file.', 'err');
    body.promptMarkdown = mdText;
  } else {
    if (!promptText) return setFormMsg('Provide a prompt describing the task.', 'err');
    body.prompt = promptText;
  }

  el.startBtn.disabled = true;
  setFormMsg('Starting run...', '');

  // Upload the selected extra files' bytes; the server writes them to a temp
  // dir and the orchestrator copies them into the pipeline's extras/ folder.
  let extras = [];
  try {
    extras = await collectExtras();
  } catch {
    extras = [];
  }
  if (extras.length) body.extras = extras;

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await safeJson(res);
    if (!res.ok || !data.runId) {
      el.startBtn.disabled = false;
      return setFormMsg(`Failed to start: ${data.error || res.status}`, 'err');
    }

    // begin tracking the new run (creates a local model + switches to Running)
    beginRun(data.runId, projectDir, title);
    // Re-enable the form so more runs can be started concurrently.
    el.startBtn.disabled = false;
    setFormMsg('Run started.', 'ok');
    if (extras.length) {
      appendLog({
        source: 'ui',
        level: 'system',
        text: `uploaded ${extras.length} extra file(s): ${extras.map((e) => e.name).join(', ')}`,
        ts: Date.now(),
      });
    }
  } catch (err) {
    el.startBtn.disabled = false;
    setFormMsg(`Error: ${err.message}`, 'err');
  }
});

// Create the local run model for a run THIS tab just started, snapshot the
// config it was launched with, and switch to the Running view. We do NOT send a
// subscribe here: live events arrive via the server's broadcast, and a
// subscribe would double-replay this run's buffer on the next hello.
function beginRun(runId, projectDir, title) {
  const r = upsertRun({ runId, title: title || '(untitled)', projectDir, status: 'starting', local: true });
  r.configSnapshot = JSON.parse(JSON.stringify({ steps: state.config.steps, models: state.models }));
  hideViewer();
  updateNavCounts();
  showView('running');
  renderRunningView();
}

function setFormMsg(text, kind) {
  el.formMsg.textContent = text;
  el.formMsg.className = 'form-msg' + (kind ? ' ' + kind : '');
}

// ---------------------------------------------------------------------------
// Per-card Stop. POST /api/stop; on success the server emits state(stopped) +
// done, which finishRun handles (card drops out + History refresh). On failure
// re-enable the button and log to that card.
// ---------------------------------------------------------------------------
async function stopRun(runId, btn) {
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId }),
    });
    if (!res.ok) {
      const err = await safeJson(res);
      if (btn) btn.disabled = false;
      const r = runs.get(runId);
      if (r) onLog(r, { source: 'ui', level: 'error', text: `stop failed: ${err.error || res.status}`, ts: Date.now() });
    }
  } catch (e) {
    if (btn) btn.disabled = false;
    const r = runs.get(runId);
    if (r) onLog(r, { source: 'ui', level: 'error', text: `stop error: ${e.message}`, ts: Date.now() });
  }
}

// Delegated controls on the dynamic run-card list: per-card Stop + per-card
// auto-scroll switch. Scoped to each card via closest('.run-card').
const runListEl = $('#run-list');
if (runListEl) {
  runListEl.addEventListener('click', (e) => {
    const stopBtn = e.target.closest && e.target.closest('.btn-stop');
    if (stopBtn) {
      const card = stopBtn.closest('.run-card');
      const runId = card && card.dataset.runId;
      if (runId) stopRun(runId, stopBtn);
      return;
    }
    const sw = e.target.closest && e.target.closest('.switch.autoscroll');
    if (sw) {
      const on = !sw.classList.contains('on');
      sw.classList.toggle('on', on);
      sw.setAttribute('aria-checked', String(on));
      return;
    }

    // qpanel actions. Resolve the run per-card via the enclosing .run-card so
    // delegation works for any dynamically-built card.
    const qbtn = e.target.closest && e.target.closest('.qpanel .btn-go, .qpanel .gate-continue, .qpanel .gate-another');
    if (qbtn) {
      const card = qbtn.closest('.run-card');
      const runId = card && card.dataset.runId;
      const r = runId && runs.get(runId);
      if (!r) return;
      if (qbtn.classList.contains('gate-continue')) postAnswer(r, { decision: 'continue' });
      else if (qbtn.classList.contains('gate-another')) postAnswer(r, { decision: 'another' });
      else submitAnswer(r);
    }
  });

  // a11y: the autoscroll .switch has role="switch" + tabindex="0" but only the
  // click path toggled it. Mirror that toggle for Space/Enter via a delegated
  // keydown (scoped through closest('.run-card') so it can't fire elsewhere).
  runListEl.addEventListener('keydown', (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    const sw = e.target.closest && e.target.closest('.switch.autoscroll');
    if (!sw || !sw.closest('.run-card')) return;
    e.preventDefault();
    const on = !sw.classList.contains('on');
    sw.classList.toggle('on', on);
    sw.setAttribute('aria-checked', String(on));
  });
}

// ---------------------------------------------------------------------------
// Install agents
// ---------------------------------------------------------------------------
el.installBtn.addEventListener('click', async () => {
  const projectDir = selectedProjectPath();
  if (!projectDir) return setFormMsg('Select a project first.', 'err');
  el.installBtn.disabled = true;
  setFormMsg('Installing agents + /maestro skill...', '');
  try {
    const res = await fetch('/api/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir }),
    });
    const data = await safeJson(res);
    if (!res.ok) {
      setFormMsg(`Install failed: ${data.error || res.status}`, 'err');
    } else {
      const n = (data.copied || []).length;
      setFormMsg(`Installed ${n} file(s) into ${data.target || projectDir + '/.claude'}. ${data.hint || ''}`, 'ok');
    }
  } catch (e) {
    setFormMsg(`Install error: ${e.message}`, 'err');
  } finally {
    el.installBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
el.refreshHistory.addEventListener('click', () => {
  const dir = selectedProjectPath();
  if (dir) loadHistory(dir);
  else setFormMsg('Select a project to load history.', 'err');
});

async function loadHistory(projectDir) {
  try {
    const res = await fetch(`/api/runs?projectDir=${encodeURIComponent(projectDir)}`);
    const data = await safeJson(res);
    if (!res.ok) {
      renderHistoryError(data.error || `HTTP ${res.status}`);
      return;
    }
    renderHistory(projectDir, data.pipelines || [], data.live || []);
  } catch (e) {
    renderHistoryError(e.message);
  }
}

// Render the #history container as expandable .hist-card DIVs (never <li>).
// Merges the disk `pipelines` with the in-memory `live` runs (deduped by id) so
// an active/just-finished run surfaces even before it's written to disk.
function renderHistory(projectDir, pipelines, live = []) {
  el.history.innerHTML = '';

  // Merge: start from disk records, append any live entry whose id isn't present.
  const records = [...(Array.isArray(pipelines) ? pipelines : [])];
  const seen = new Set(records.map((p) => p && p.id).filter(Boolean));
  for (const lr of Array.isArray(live) ? live : []) {
    if (!lr) continue;
    const id = lr.id || lr.runId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // Normalize a live entry into a record shape the card builder understands.
    records.push({ id, title: lr.title, status: lr.status || 'running', live: true, startedAt: lr.startedAt });
  }

  if (el.navHistoryCount) el.navHistoryCount.textContent = String(records.length);

  if (!records.length) {
    el.history.appendChild(histEmpty('No saved pipelines yet for this folder.'));
    return;
  }

  records.forEach((p) => {
    el.history.appendChild(buildHistCard(projectDir, p));
  });
}

// One row of the history empty/error state — a DIV (never an <li>).
function histEmpty(text) {
  const div = document.createElement('div');
  div.className = 'hist-empty';
  div.textContent = text;
  return div;
}

// Map a pipeline status to { cls, text } for the collapsed-card badge.
function historyBadge(p) {
  const s = String(p.status || '').toLowerCase();
  if (s === 'done' || s === 'complete' || s === 'completed') return { cls: 'badge green', text: 'DONE' };
  if (s === 'stopped' || s === 'aborted') return { cls: 'badge red', text: 'STOPPED' };
  if (s === 'error' || s === 'failed') return { cls: 'badge red', text: 'ERROR' };
  if (p.live || s === 'running' || s === 'starting') return { cls: 'badge running', text: 'RUNNING' };
  return { cls: 'badge', text: s ? s.toUpperCase() : 'UNKNOWN' };
}

// Build one expandable history card from a (disk or live) record. The collapsed
// card shows only list-feed data (badge/title/timestamp); the tinted stepper is
// lazily fetched + rendered on first expand.
function buildHistCard(projectDir, p) {
  const tpl = $('#hist-card-tpl');
  const node = tpl.content.firstElementChild.cloneNode(true);
  const id = p.id || '';
  node.dataset.pipelineId = id;

  const badge = node.querySelector('.badge');
  if (badge) {
    const { cls, text } = historyBadge(p);
    badge.className = cls;
    badge.textContent = text;
  }

  const titleEl = node.querySelector('.h-meta b');
  const title = p.title || id || '(untitled)';
  if (titleEl) {
    titleEl.textContent = title;
    // Title click opens the saved-markdown viewer (distinct from expand).
    titleEl.addEventListener('click', (e) => {
      e.stopPropagation();
      viewPipeline(projectDir, id, p.title);
    });
  }
  const whenEl = node.querySelector('.h-meta small');
  if (whenEl) whenEl.textContent = fmtDate(p.startedAt || p.mtime);
  const totalEl = node.querySelector('.hist-total');
  if (totalEl) {
    totalEl.textContent = typeof p.totalCostUsd === 'number' ? fmtUsd(p.totalCostUsd) : '';
    totalEl.title = typeof p.totalCostUsd === 'number' ? estTitle(p.totalCostUsd) : '';
  }

  const head = node.querySelector('.hist-head');
  const detail = node.querySelector('.hist-detail');
  if (head && detail) {
    const toggle = () => toggleHistCard(projectDir, id, head, detail);
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        toggle();
      }
    });
  }

  return node;
}

// Expand/collapse a history card. On the FIRST expand, lazily fetch the saved
// state and render the tinted stepper, caching it so re-expand doesn't refetch.
function toggleHistCard(projectDir, id, head, detail) {
  const expanded = head.getAttribute('aria-expanded') === 'true';
  if (expanded) {
    head.setAttribute('aria-expanded', 'false');
    detail.hidden = true;
    return;
  }
  head.setAttribute('aria-expanded', 'true');
  detail.hidden = false;
  if (detail.dataset.loaded === '1') return; // cached — don't refetch
  detail.dataset.loaded = '1';
  loadHistDetail(projectDir, id, detail);
}

// Fetch GET /api/runs/:id and tint this card's stepper from data.state. On
// failure, show a small inline notice and allow a retry on the next expand.
async function loadHistDetail(projectDir, id, detail) {
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(id)}?projectDir=${encodeURIComponent(projectDir)}`);
    const data = await safeJson(res);
    if (!res.ok) {
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    if (!data || !data.state) {
      // 200 but no saved state.json yet (e.g. an in-progress run not persisted).
      throw new Error('no saved details for this pipeline yet');
    }
    // A prior failed expand may have left a "Could not load details…" note in
    // this card. On a successful retry, clear it so the stepper isn't shown
    // alongside a stale error.
    const stale = detail.querySelector('.detail-error');
    if (stale) stale.remove();
    paintHistStepper(detail, data.state);
    if (typeof data.state.totalCostUsd === 'number') {
      const card = detail.closest('.hist-card');
      const totalEl = card && card.querySelector('.hist-total');
      if (totalEl) {
        totalEl.textContent = fmtUsd(data.state.totalCostUsd);
        totalEl.title = estTitle(data.state.totalCostUsd);
      }
    }
  } catch (e) {
    detail.dataset.loaded = ''; // allow a retry on the next expand
    let note = detail.querySelector('.detail-error');
    if (!note) {
      note = document.createElement('div');
      note.className = 'detail-error';
      detail.appendChild(note);
    }
    note.textContent = `Could not load details: ${e.message}`;
  }
}

// Tint the 6-stage stepper inside a history card's .hist-detail from a saved
// state ({ phase, status, cycle }). Driven by the reached phase, not live events.
function paintHistStepper(detail, st) {
  const status = String(st.status || '').toLowerCase();
  const key = normalizePhase(st.phase);
  const reached = key ? STEP_ORDER.indexOf(key) : -1;
  const isDone = status === 'done' || status === 'complete' || status === 'completed';

  for (const stage of detail.querySelectorAll('.stage[data-step]')) {
    const idx = STEP_ORDER.indexOf(stage.dataset.step);
    const numEl = stage.querySelector('.num');
    stage.classList.remove('s-done', 's-now', 's-pause', 's-stop');
    if (numEl) numEl.classList.remove('n-green', 'n-peach', 'n-amber', 'n-red', 'n-grey');

    let kind = null; // 'done' | 'stop' | null(pending)
    if (isDone) {
      kind = 'done'; // DONE: every stage complete (incl. the Done step).
    } else if (idx < reached) {
      kind = 'done'; // stages before the reached step completed.
    } else if (idx === reached) {
      // STOPPED/ERROR halt at the reached step; otherwise mark it reached/done.
      kind = (status === 'stopped' || status === 'error' || status === 'aborted' || status === 'failed') ? 'stop' : 'done';
    }
    // idx > reached and idx === doneIdx (when not done) stay pending.

    if (kind === 'done') {
      stage.classList.add('s-done');
      if (numEl) numEl.classList.add('n-green');
    } else if (kind === 'stop') {
      stage.classList.add('s-stop');
      if (numEl) numEl.classList.add('n-red');
    } else if (numEl) {
      numEl.classList.add('n-grey'); // pending
    }

    // Single saved `cycle` scalar — show on refine/review only if present. We do
    // NOT fabricate separate refine/review counts (no data source for them).
    const cyEl = stage.querySelector('.cycle');
    if (cyEl) cyEl.textContent = (CYCLING_PHASES.has(stage.dataset.step) && st.cycle) ? `#${st.cycle}` : '';

    const costEl = stage.querySelector('.cost'); // COST: per-stage figure
    if (costEl) {
      const c = costByStage(st.steps)[stage.dataset.step];
      costEl.textContent = c != null ? fmtUsd(c) : '';
      costEl.title = c != null ? estTitle(c) : '';
    }
  }
}

function renderHistoryError(message) {
  el.history.innerHTML = '';
  el.history.appendChild(histEmpty(`Could not load history: ${message}`));
}

async function viewPipeline(projectDir, id, title) {
  if (!id) return;
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(id)}?projectDir=${encodeURIComponent(projectDir)}`);
    const data = await safeJson(res);
    if (!res.ok) {
      showViewer(title || id, `Could not load pipeline: ${data.error || res.status}`);
      return;
    }
    const md = data.auditMarkdown || '(no saved markdown)';
    showViewer(title || id, md);
  } catch (e) {
    showViewer(title || id, `Error: ${e.message}`);
  }
}

function showViewer(title, text) {
  el.viewerTitle.textContent = title ? `Saved: ${title}` : 'Saved pipeline';
  el.viewer.textContent = text;
  el.viewerCard.classList.remove('hidden');
  el.viewerCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function hideViewer() {
  el.viewerCard.classList.add('hidden');
}
el.viewerClose.addEventListener('click', hideViewer);
// Close the modal on backdrop click (overlay itself, not its inner card)...
el.viewerCard.addEventListener('click', (e) => {
  if (e.target === el.viewerCard) hideViewer();
});
// ...and on Escape, when it's open.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.viewerCard.classList.contains('hidden')) hideViewer();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

function fmtDate(v) {
  if (!v) return '';
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleString();
}

// ---------------------------------------------------------------------------
// Multi-run rendering: one card per live run in the Running view.
// ---------------------------------------------------------------------------

// A run is "live" while it is starting/running OR has a pending question
// (paused). Terminal statuses (done|error|stopped) are never live; on finish we
// also clear pendingQuestion, so a lingering question can't keep it live.
// The `!r._finished` guard ensures a run that has been through finishRun can
// never re-enter the live list — even if an out-of-order event or a future
// hello upserts it with a live `status` again. The terminal exclusion routes
// through isTerminalStatus so the done|error|stopped definition lives in one
// place (shared with postAnswer's guard).
function liveRuns() {
  return [...runs.values()].filter(
    (r) =>
      !r._finished &&
      !isTerminalStatus(r.status) &&
      (r.status === 'starting' || r.status === 'running' || r.pendingQuestion != null)
  );
}

// Project basename for display (e.g. "/a/b/proj" -> "proj").
function projectName(dir) {
  if (!dir) return '(no project)';
  const parts = String(dir).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || dir;
}

// Derive an HH:MM:SS label from an ISO timestamp; pass through anything that
// already looks like a bare time string.
function startedLabel(startedAt) {
  if (!startedAt) return '';
  const d = new Date(startedAt);
  if (!isNaN(d.getTime())) return d.toTimeString().slice(0, 8);
  return String(startedAt);
}

const PHASE_LABEL = { preflight: 'Preflight', plan: 'Plan', refine: 'Refine', implement: 'Implement', review: 'Review', done: 'Done' };
const CYCLING_PHASES = new Set(['refine', 'review']);

// Status-pill copy map (committed — no '?'). Returns { family, text }.
function statusPill(r) {
  if (r.pendingQuestion != null) return { family: 'amber', text: 'Paused · awaiting answers' };
  if (r.status === 'starting') return { family: 'peach', text: 'Starting' };
  if (r.status === 'done') return { family: 'green', text: 'Done' };
  if (r.status === 'stopped') return { family: 'red', text: 'Stopped' };
  if (r.status === 'error') return { family: 'red', text: 'Error' };
  // running
  switch (r.phaseKey) {
    case 'plan': return { family: 'violet', text: 'Planning' };
    case 'refine': return { family: 'peach', text: 'Refining' };
    case 'implement': return { family: 'blue', text: 'Implementing' };
    case 'review': return { family: 'peach', text: 'Reviewing' };
    default: return { family: 'peach', text: 'Running' };
  }
}

function buildRunCard(r) {
  const tpl = $('#run-card-tpl');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.runId = r.runId;

  const titleEl = node.querySelector('.run-title');
  if (titleEl) titleEl.textContent = r.title;
  const metaEl = node.querySelector('.rm-text');
  if (metaEl) metaEl.textContent = `${projectName(r.projectDir)} · started ${startedLabel(r.startedAt)}`;

  // Stage sublabels: only meaningful for a run THIS tab started (we have the
  // config snapshot). preflight/done keep their static labels.
  if (r.local && r.configSnapshot) fillStageSublabels(node, r.configSnapshot);

  // Hydrate the log from any events that arrived before the card existed.
  const logEl = node.querySelector('.log');
  if (logEl) for (const rec of r.logLines) logEl.appendChild(buildLogLine(rec));

  // A2: a card built from a hello-seeded pending question (mid-pause reload, the
  // original `question` event may be past the replay buffer) must render the
  // panel immediately from r.pendingQuestion — independent of any replayed
  // event. r.el must be set before renderQpanel reads it.
  if (r.pendingQuestion != null) {
    r.el = node;
    renderQpanel(r);
  }

  return node;
}

// Map each agent role's snapshot (model label + effort) onto the matching
// stage's sublabel. The card steps use phase keys; map them to config roles.
const STEP_TO_ROLE = { plan: 'planner', refine: 'refiner', implement: 'implementer', review: 'reviewer' };
function fillStageSublabels(node, snap) {
  const models = Array.isArray(snap.models) ? snap.models : [];
  const steps = snap.steps || {};
  const labelFor = (role) => {
    const sel = steps[role] || {};
    const m = models.find((x) => x.id === sel.model);
    const modelLabel = m ? m.label : 'default';
    return sel.effort ? `${modelLabel} · ${sel.effort}` : modelLabel;
  };
  for (const stage of node.querySelectorAll('.stage[data-step]')) {
    const step = stage.dataset.step;
    const role = STEP_TO_ROLE[step];
    if (!role) continue; // preflight/done keep static sublabel
    const sub = stage.querySelector('.sub');
    if (sub) sub.textContent = labelFor(role);
  }
}

// Paint the 6-stage stepper from the run model.
const STAGE_NUM = { done: ['s-done', 'n-green'], now: ['s-now', 'n-peach'], pause: ['s-pause', 'n-amber'], stop: ['s-stop', 'n-red'] };
function paintStepper(r) {
  if (!r.el) return;
  const terminalDone = r.status === 'done';
  for (const stage of r.el.querySelectorAll('.stage[data-step]')) {
    const step = stage.dataset.step;
    const idx = STEP_ORDER.indexOf(step);
    const numEl = stage.querySelector('.num');

    stage.classList.remove('s-done', 's-now', 's-pause', 's-stop');
    if (numEl) numEl.classList.remove('n-green', 'n-peach', 'n-amber', 'n-red', 'n-grey');

    let kind = null; // 'done' | 'now' | 'pause' | 'stop' | null(pending)
    if (terminalDone) {
      kind = 'done';
    } else if (idx < r.maxStepIdx) {
      kind = 'done';
    } else if (idx === r.maxStepIdx) {
      if (r.pendingQuestion != null) kind = 'pause';
      else if (r.status === 'stopped') kind = 'stop';
      else if (['done', 'complete', 'passed'].includes(r.phaseStatus)) kind = 'done';
      else kind = 'now';
    }

    if (kind) {
      const [sCls, nCls] = STAGE_NUM[kind];
      stage.classList.add(sCls);
      if (numEl) numEl.classList.add(nCls);
    } else if (numEl) {
      numEl.classList.add('n-grey'); // pending
    }

    // Cycle badge on refine/review.
    const cyEl = stage.querySelector('.cycle');
    if (cyEl) cyEl.textContent = (CYCLING_PHASES.has(step) && r.cycle) ? `#${r.cycle}` : '';

    const costEl = stage.querySelector('.cost');
    if (costEl) {
      const c = (r.costByStage || {})[step];
      costEl.textContent = c != null ? fmtUsd(c) : '';
      costEl.title = c != null ? estTitle(c) : '';
    }
  }
}

function paintRunCard(r) {
  if (!r.el) return;

  // Status pill: family class + text, preserving the leading .pdot.
  const pill = r.el.querySelector('.pill-run');
  if (pill) {
    const { family, text } = statusPill(r);
    pill.className = `pill-run ${family}`;
    const txt = pill.querySelector('.pill-text');
    if (txt) txt.textContent = text;
    else pill.textContent = text;
  }

  // Foot chip.
  const chip = r.el.querySelector('.chip');
  if (chip) {
    const phaseLabel = PHASE_LABEL[r.phaseKey] || 'Running';
    if (r.pendingQuestion != null) {
      const n = questionCount(r.pendingQuestion);
      chip.textContent = `${phaseLabel} paused · ${n} question${n === 1 ? '' : 's'}`;
    } else if (CYCLING_PHASES.has(r.phaseKey) && r.cycle) {
      // Max cycles aren't carried on the client run model, so show the current
      // cycle number without a misleading denominator.
      chip.textContent = `${phaseLabel} cycle ${r.cycle}`;
    } else {
      chip.textContent = phaseLabel;
    }
  }

  paintStepper(r);
  const totalEl = r.el.querySelector('.run-cost');
  if (totalEl) {
    totalEl.textContent = fmtUsd(r.totalCostUsd || 0); // always shows (mock => $0.00)
    totalEl.title = estTitle(r.totalCostUsd || 0);
  }
  r.el.classList.toggle('attention', r.pendingQuestion != null);
}

function questionCount(pq) {
  if (!pq) return 0;
  if (Array.isArray(pq.questions)) return pq.questions.length;
  if (Array.isArray(pq.issues)) return pq.issues.length;
  return 1;
}

function renderRunningView() {
  const list = $('#run-list');
  if (!list) return;
  const live = liveRuns();
  const seen = new Set();

  for (const r of live) {
    seen.add(r.runId);
    if (!r.el) {
      r.el = buildRunCard(r);
      list.append(r.el);
    }
    paintRunCard(r);
  }

  // Remove cards whose run is no longer live.
  [...list.children].forEach((c) => {
    if (c.dataset && c.dataset.runId && !seen.has(c.dataset.runId)) c.remove();
  });

  // Empty state.
  if (live.length === 0) {
    list.innerHTML = '<div class="run-empty">No pipelines running — start one from New.</div>';
  }

  // Header counts.
  const needs = live.filter((r) => r.pendingQuestion).length;
  const sub = $('#running-sub');
  if (sub) {
    sub.textContent =
      `${live.length} pipeline${live.length === 1 ? '' : 's'} executing · ${needs} need${needs === 1 ? 's' : ''} your input`;
  }
  const pill = $('#running-status-pill');
  if (pill) {
    pill.classList.toggle('hidden', needs === 0);
    const txt = pill.querySelector('.pill-text');
    const label = `${needs} need${needs === 1 ? 's' : ''} input`;
    if (txt) txt.textContent = label;
    else {
      // Preserve a leading .pdot if present; replace only the trailing text.
      const dot = pill.querySelector('.pdot');
      pill.textContent = '';
      if (dot) pill.appendChild(dot);
      pill.append(document.createTextNode(' ' + label));
    }
  }
}

function updateNavCounts() {
  const c = $('#nav-running-count');
  if (c) c.textContent = String(liveRuns().length);
}

// ---------------------------------------------------------------------------
// Router: sidebar nav (+ responsive top-nav) toggle between the three views.
// ---------------------------------------------------------------------------
const views = $$('.view');
const navLinks = $$('.nav a[data-nav], .topnav a[data-nav]');
const VIEW_NAMES = ['new', 'running', 'history'];

function showView(name) {
  views.forEach((v) => v.classList.toggle('hidden', v.dataset.view !== name));
  navLinks.forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
  if (name === 'running') renderRunningView();
  if (name === 'history') {
    const d = selectedProjectPath();
    if (d) loadHistory(d);
  }
}

// Nav clicks only update the hash; the single hashchange listener drives
// showView so each navigation runs it exactly once (no double /api/runs fetch).
navLinks.forEach((a) =>
  a.addEventListener('click', (e) => {
    e.preventDefault();
    location.hash = a.dataset.nav;
  })
);

window.addEventListener('hashchange', () => {
  const h = location.hash.slice(1);
  if (VIEW_NAMES.includes(h)) showView(h);
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
syncSourceToggle();
setWsStatus(false);
loadProjects();
connectWS();
const bootHash = location.hash.slice(1);
showView(VIEW_NAMES.includes(bootHash) ? bootHash : 'new');
updateNavCounts();
