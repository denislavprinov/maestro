// maestro UI client. Vanilla ESM, no framework, no build step.

const $ = (sel, root = document) => (root || document).querySelector(sel);
const $$ = (sel, root = document) => [...(root || document).querySelectorAll(sel)];

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
const state = {
  ws: null,
  wsReady: false,
  runId: null, // currently-tracked run
  projectDir: '',
  projects: [], // saved {name, path, exists} registry, loaded from /api/projects
  config: { steps: {}, customModels: [] }, // per-project model/effort selections
  models: [], // predefined + custom, from /api/config
  efforts: [], // effort levels, from /api/config
  pendingQuestion: null, // last unanswered question {id, kind, ...}
  status: 'idle',
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
    setWsStatus(true);
    if (state.runId) {
      try {
        ws.send(JSON.stringify({ type: 'subscribe', runId: state.runId }));
      } catch {
        /* ignore */
      }
    }
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
// Server message router. We only act on events for the run we're tracking.
// ---------------------------------------------------------------------------
function handleServerMessage(msg) {
  if (!msg || !msg.type) return;

  if (msg.type === 'hello') {
    // server greeting; nothing required.
    return;
  }

  // Only react to events for the active run.
  if (msg.runId && state.runId && msg.runId !== state.runId) return;
  if (!state.runId && msg.runId) state.runId = msg.runId;

  switch (msg.type) {
    case 'phase':
      onPhase(msg);
      break;
    case 'log':
      appendLog(msg);
      break;
    case 'question':
      onQuestion(msg);
      break;
    case 'artifact':
      onArtifact(msg);
      break;
    case 'state':
      onState(msg);
      break;
    case 'done':
      onDone(msg);
      break;
    case 'error':
      onError(msg);
      break;
    default:
      break;
  }
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

function onPhase(msg) {
  const key = normalizePhase(msg.phase);
  if (key) setActiveStep(key, msg.cycle, msg.status);
  // Also surface phase transitions in the log for visibility.
  const cyc = msg.cycle ? ` #${msg.cycle}` : '';
  const st = msg.status ? ` (${msg.status})` : '';
  appendLog({ source: 'phase', level: 'phase', text: `${msg.phase}${cyc}${st}`, ts: Date.now() });

  if (key === 'done' || (msg.phase && String(msg.phase).toLowerCase().includes('done'))) {
    markAllDoneUpTo('done');
  }
}

// Furthest step index reached this run. The review->fix loop legitimately emits
// implement passes between reviews; without this, the tracker would un-mark the
// already-completed Review step and appear to jump backward each fix cycle.
let maxStepIdx = -1;

function setActiveStep(key, cycle, status) {
  const idx = STEP_ORDER.indexOf(key);
  if (idx > maxStepIdx) maxStepIdx = idx;
  $$('.step', el.steps).forEach((node) => {
    const step = node.dataset.step;
    const sIdx = STEP_ORDER.indexOf(step);
    node.classList.remove('active', 'done');
    // Mark done everything strictly before the furthest step reached so a later
    // implement fix-pass does not visually regress completed steps.
    if (sIdx >= 0 && sIdx < maxStepIdx) node.classList.add('done');
  });
  const active = $(`.step[data-step="${key}"]`, el.steps);
  if (active) {
    if (status === 'done' || status === 'complete' || status === 'passed') {
      active.classList.add('done');
    } else {
      active.classList.add('active');
    }
    const cyEl = $('.cycle', active);
    if (cyEl) cyEl.textContent = cycle ? `#${cycle}` : '';
  }
}

function markAllDoneUpTo(key) {
  const idx = STEP_ORDER.indexOf(key);
  $$('.step', el.steps).forEach((node) => {
    const sIdx = STEP_ORDER.indexOf(node.dataset.step);
    node.classList.remove('active');
    if (sIdx <= idx) node.classList.add('done');
  });
}

function resetSteps() {
  maxStepIdx = -1;
  $$('.step', el.steps).forEach((node) => {
    node.classList.remove('active', 'done');
    const cyEl = $('.cycle', node);
    if (cyEl) cyEl.textContent = '';
  });
}

// ---------------------------------------------------------------------------
// Per-step model + effort config
// ---------------------------------------------------------------------------
async function loadConfig(projectDir) {
  if (!projectDir) return;
  try {
    const res = await fetch(`/api/config?projectDir=${encodeURIComponent(projectDir)}`);
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
function appendLog({ source, level, text, ts }) {
  // The global log surface was removed; per-card logging arrives in Task 3.
  // Guard so any stray call (e.g. from a WS message) cannot throw.
  if (!el.log) return;
  if (text === undefined || text === null) return;
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
  el.log.appendChild(line);

  // cap rendered lines to keep DOM light
  const MAX = 4000;
  while (el.log.childElementCount > MAX) el.log.removeChild(el.log.firstChild);

  if (el.autoscroll.checked) el.log.scrollTop = el.log.scrollHeight;
}

function fmtTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function onArtifact(msg) {
  appendLog({
    source: 'artifact',
    level: 'artifact',
    text: `${msg.kind || 'file'}: ${msg.path || ''}`,
    ts: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// State snapshot
// ---------------------------------------------------------------------------
function onState(msg) {
  if (msg.status) setRunStatus(msg.status);
  // If snapshot carries phase/cycle, reflect it.
  if (msg.phase) {
    const key = normalizePhase(msg.phase);
    if (key) setActiveStep(key, msg.cycle, msg.phaseStatus);
  }
}

// ---------------------------------------------------------------------------
// Questions (clarify) and gates
// ---------------------------------------------------------------------------
function onQuestion(msg) {
  state.pendingQuestion = msg;
  setRunStatus('waiting');
  // The global question card was removed; per-run qpanel rendering is Task 3.
  // Bail before touching the (gone) question DOM so a real WS question can't throw.
  if (!el.questionCard) return;
  if (msg.kind === 'gate') {
    renderGate(msg);
  } else {
    renderClarify(msg);
  }
  showQuestionCard(true);
}

function showQuestionCard(show) {
  // Global question card removed; per-run qpanel arrives in Task 3.
  if (!el.questionCard) return;
  el.questionCard.classList.toggle('hidden', !show);
  if (show) el.questionCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderClarify(msg) {
  el.questionTitle.textContent = 'Clarification needed';
  el.questionKind.textContent = 'clarify';
  el.questionKind.className = 'badge waiting';
  el.questionBody.innerHTML = '';

  const questions = Array.isArray(msg.questions) ? msg.questions : [];
  // Per-question selected choice store.
  const selections = new Map();

  if (questions.length === 0) {
    const p = document.createElement('p');
    p.className = 'gate-intro';
    p.textContent = 'The planner asked for input but provided no questions. You may submit an empty answer to continue.';
    el.questionBody.appendChild(p);
  }

  questions.forEach((q, qi) => {
    const qid = q.id != null ? q.id : `q${qi}`;
    const block = document.createElement('div');
    block.className = 'q-block';

    const qh = document.createElement('p');
    qh.className = 'q-question';
    qh.textContent = q.question || `Question ${qi + 1}`;
    block.appendChild(qh);

    const opts = document.createElement('div');
    opts.className = 'q-options';
    // Filter empty option slots: the clarify contract pads to 3 slots with '',
    // so a question with 1-2 real options would otherwise render blank buttons.
    const options = (Array.isArray(q.options) ? q.options : []).filter((o) => o && o.trim());
    options.forEach((opt) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'q-option';
      b.textContent = opt;
      b.addEventListener('click', () => {
        selections.set(qid, opt);
        // clear free text when an option is picked
        if (free) free.value = '';
        $$('.q-option', opts).forEach((o) => o.classList.remove('selected'));
        b.classList.add('selected');
      });
      opts.appendChild(b);
    });
    block.appendChild(opts);

    // free-text alternative
    const lbl = document.createElement('label');
    lbl.className = 'q-free-label';
    lbl.textContent = q.allowFreeText === false ? 'Other (free text):' : 'Or type your own answer:';
    block.appendChild(lbl);

    const freeRow = document.createElement('div');
    freeRow.className = 'q-free';
    const free = document.createElement('input');
    free.type = 'text';
    free.placeholder = 'Type a custom answer...';
    free.addEventListener('input', () => {
      if (free.value.trim()) {
        selections.set(qid, free.value);
        $$('.q-option', opts).forEach((o) => o.classList.remove('selected'));
      } else {
        selections.delete(qid);
      }
    });
    freeRow.appendChild(free);
    block.appendChild(freeRow);

    // stash references for submit
    block._qid = qid;
    block._question = q.question || '';
    block._getChoice = () => (selections.has(qid) ? selections.get(qid) : (free.value.trim() || ''));
    el.questionBody.appendChild(block);
  });

  const row = document.createElement('div');
  row.className = 'q-submit-row';
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'btn btn-primary';
  submit.textContent = 'Submit answers';
  submit.addEventListener('click', () => {
    const answers = $$('.q-block', el.questionBody).map((b) => ({
      id: b._qid,
      question: b._question,
      choice: b._getChoice(),
    }));
    sendAnswer(msg.id, { answers });
  });
  row.appendChild(submit);
  el.questionBody.appendChild(row);
}

function renderGate(msg) {
  el.questionTitle.textContent = 'Cycle gate';
  el.questionKind.textContent = 'gate';
  el.questionKind.className = 'badge waiting';
  el.questionBody.innerHTML = '';

  const intro = document.createElement('p');
  intro.className = 'gate-intro';
  intro.textContent =
    'The maximum number of cycles was reached and there are still open critical/major issues. Choose how to proceed.';
  el.questionBody.appendChild(intro);

  const issues = Array.isArray(msg.issues) ? msg.issues : [];
  if (issues.length) {
    const ul = document.createElement('ul');
    ul.className = 'issues';
    issues.forEach((iss) => {
      const li = document.createElement('li');
      const sev = (iss.severity || 'minor').toLowerCase();
      li.className = `issue sev-${sev}`;

      const head = document.createElement('div');
      head.className = 'issue-head';
      const sevTag = document.createElement('span');
      sevTag.className = 'issue-sev';
      sevTag.textContent = sev;
      const title = document.createElement('span');
      title.className = 'issue-title';
      title.textContent = iss.title || '(untitled issue)';
      head.append(sevTag, title);
      li.appendChild(head);

      if (iss.detail) {
        const d = document.createElement('p');
        d.className = 'issue-detail';
        d.textContent = iss.detail;
        li.appendChild(d);
      }
      if (iss.location) {
        const loc = document.createElement('div');
        loc.className = 'issue-loc';
        loc.textContent = iss.location;
        li.appendChild(loc);
      }
      ul.appendChild(li);
    });
    el.questionBody.appendChild(ul);
  } else {
    const none = document.createElement('p');
    none.className = 'gate-intro';
    none.textContent = 'No issue details were provided.';
    el.questionBody.appendChild(none);
  }

  const actions = document.createElement('div');
  actions.className = 'gate-actions';

  const continueBtn = document.createElement('button');
  continueBtn.type = 'button';
  continueBtn.className = 'btn';
  continueBtn.textContent = "Don't have another cycle and continue";
  continueBtn.addEventListener('click', () => sendAnswer(msg.id, { decision: 'continue' }));

  const anotherBtn = document.createElement('button');
  anotherBtn.type = 'button';
  anotherBtn.className = 'btn btn-primary';
  anotherBtn.textContent = 'I approve another cycle';
  anotherBtn.addEventListener('click', () => sendAnswer(msg.id, { decision: 'another' }));

  actions.append(continueBtn, anotherBtn);
  el.questionBody.appendChild(actions);
}

async function sendAnswer(id, payload) {
  if (!state.runId || !id) return;
  // optimistic: hide panel + show running
  showQuestionCard(false);
  state.pendingQuestion = null;
  setRunStatus('running');
  try {
    const res = await fetch('/api/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: state.runId, id, payload }),
    });
    if (!res.ok) {
      const err = await safeJson(res);
      appendLog({ source: 'ui', level: 'error', text: `answer failed: ${err.error || res.status}`, ts: Date.now() });
    }
  } catch (e) {
    appendLog({ source: 'ui', level: 'error', text: `answer error: ${e.message}`, ts: Date.now() });
  }
}

// ---------------------------------------------------------------------------
// Done / error
// ---------------------------------------------------------------------------
function onDone(msg) {
  setRunStatus(msg.status || 'done');
  markAllDoneUpTo('done');
  showQuestionCard(false);
  if (el.stopBtn) el.stopBtn.disabled = true;
  el.startBtn.disabled = false;
  appendLog({
    source: 'system',
    level: 'system',
    text: `pipeline ${msg.status || 'done'}${msg.pipelineDir ? ' -> ' + msg.pipelineDir : ''}`,
    ts: Date.now(),
  });
  // refresh history to show the saved pipeline
  if (state.projectDir) loadHistory(state.projectDir);
}

function onError(msg) {
  setRunStatus('error');
  if (el.stopBtn) el.stopBtn.disabled = true;
  el.startBtn.disabled = false;
  appendLog({ source: 'system', level: 'error', text: `error: ${msg.message || 'unknown error'}`, ts: Date.now() });
}

function setRunStatus(status) {
  // The global run-status badge was removed; per-run status lives on each card
  // in Task 3. Keep state.status for any legacy readers and no-op the (gone) DOM.
  state.status = status;
}

function statusClass(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'running' || s === 'starting') return 'running';
  if (s === 'done' || s === 'complete' || s === 'completed' || s === 'success') return 'done';
  if (s === 'error' || s === 'stopped' || s === 'aborted' || s === 'failed') return 'error';
  if (s === 'waiting') return 'waiting';
  return '';
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
    state.config = { steps: {}, customModels: [] };
    state.models = [];
    renderStepConfigs(); // clear the selectors
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
    el.history.innerHTML = '<li class="empty">Select a project to load history.</li>';
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

  const body = {
    projectDir,
    title: el.title.value.trim() || undefined,
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

    // begin tracking the new run
    beginRun(data.runId, projectDir);
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

function beginRun(runId, projectDir) {
  state.runId = runId;
  state.projectDir = projectDir;
  state.pendingQuestion = null;
  // fresh canvas (global log/stepper removed; per-card rendering arrives in Task 3)
  if (el.log) el.log.innerHTML = '';
  resetSteps();
  showQuestionCard(false);
  hideViewer();
  setRunStatus('starting');
  setActiveStep('preflight');
  if (el.stopBtn) el.stopBtn.disabled = false;

  appendLog({ source: 'system', level: 'system', text: `run ${runId} started in ${projectDir}`, ts: Date.now() });

  // make sure WS is subscribed (covers the buffered-replay case)
  if (state.ws && state.wsReady) {
    try {
      state.ws.send(JSON.stringify({ type: 'subscribe', runId }));
    } catch {
      /* ignore */
    }
  }
}

function setFormMsg(text, kind) {
  el.formMsg.textContent = text;
  el.formMsg.className = 'form-msg' + (kind ? ' ' + kind : '');
}

// ---------------------------------------------------------------------------
// Stop / clear-log: the global Stop button and Live-log clear control were
// removed in the shell rewrite. Per-card Stop and per-card log clearing arrive
// in Task 3 (wired against each run card's own controls).
// ---------------------------------------------------------------------------

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
    renderHistory(projectDir, data.pipelines || []);
  } catch (e) {
    renderHistoryError(e.message);
  }
}

function renderHistory(projectDir, pipelines) {
  el.history.innerHTML = '';
  if (!pipelines.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No saved pipelines yet for this folder.';
    el.history.appendChild(li);
    return;
  }
  pipelines.forEach((p) => {
    const li = document.createElement('li');
    li.className = 'history-item';

    const title = document.createElement('div');
    title.className = 'h-title';
    title.textContent = p.title || p.id || '(untitled)';

    const meta = document.createElement('div');
    meta.className = 'h-meta';
    const status = document.createElement('span');
    status.className = 'h-status ' + statusClass(p.status);
    status.textContent = p.status || 'unknown';
    const when = document.createElement('span');
    when.textContent = fmtDate(p.startedAt || p.mtime);
    const idSpan = document.createElement('span');
    idSpan.textContent = p.id || '';
    meta.append(status, when, idSpan);

    li.append(title, meta);
    li.addEventListener('click', () => viewPipeline(projectDir, p.id, p.title));
    el.history.appendChild(li);
  });
}

function renderHistoryError(message) {
  el.history.innerHTML = '';
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = `Could not load history: ${message}`;
  el.history.appendChild(li);
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
// Multi-run engine (stubbed — full per-card rendering arrives in Task 3)
// ---------------------------------------------------------------------------
const runs = new Map();

function renderRunningView() {
  /* stub — Task 3 renders one card per active run into #run-list */
}

function updateNavCounts() {
  const c = $('#nav-running-count');
  if (c) c.textContent = String(runs.size);
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
