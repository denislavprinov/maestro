// maestro UI client. Vanilla ESM, no framework, no build step.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
const state = {
  ws: null,
  wsReady: false,
  runId: null, // currently-tracked run
  projectDir: '',
  pendingQuestion: null, // last unanswered question {id, kind, ...}
  status: 'idle',
};

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------
const el = {
  wsDot: $('#ws-dot'),
  wsLabel: $('#ws-label'),

  form: $('#run-form'),
  projectDir: $('#projectDir'),
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

  runStatus: $('#run-status'),
  stopBtn: $('#stop-btn'),
  steps: $('#steps'),

  questionCard: $('#question-card'),
  questionTitle: $('#question-title'),
  questionKind: $('#question-kind'),
  questionBody: $('#question-body'),

  log: $('#log'),
  autoscroll: $('#autoscroll'),
  clearLog: $('#clear-log'),

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
// Log window
// ---------------------------------------------------------------------------
function appendLog({ source, level, text, ts }) {
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
  if (msg.kind === 'gate') {
    renderGate(msg);
  } else {
    renderClarify(msg);
  }
  showQuestionCard(true);
}

function showQuestionCard(show) {
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
  el.stopBtn.disabled = true;
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
  el.stopBtn.disabled = true;
  el.startBtn.disabled = false;
  appendLog({ source: 'system', level: 'error', text: `error: ${msg.message || 'unknown error'}`, ts: Date.now() });
}

function setRunStatus(status) {
  state.status = status;
  el.runStatus.textContent = status;
  el.runStatus.className = 'badge ' + statusClass(status);
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

el.projectDir.addEventListener('change', () => {
  const dir = el.projectDir.value.trim();
  if (dir) {
    state.projectDir = dir;
    loadHistory(dir);
  }
});

// ---------------------------------------------------------------------------
// Start a run
// ---------------------------------------------------------------------------
el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  setFormMsg('', '');

  const projectDir = el.projectDir.value.trim();
  if (!projectDir) return setFormMsg('Project folder is required.', 'err');

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
  // fresh canvas
  el.log.innerHTML = '';
  resetSteps();
  showQuestionCard(false);
  hideViewer();
  setRunStatus('starting');
  setActiveStep('preflight');
  el.stopBtn.disabled = false;

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
// Stop
// ---------------------------------------------------------------------------
el.stopBtn.addEventListener('click', async () => {
  if (!state.runId) return;
  el.stopBtn.disabled = true;
  try {
    const res = await fetch('/api/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: state.runId }),
    });
    if (!res.ok) {
      const err = await safeJson(res);
      appendLog({ source: 'ui', level: 'error', text: `stop failed: ${err.error || res.status}`, ts: Date.now() });
      el.stopBtn.disabled = false;
    } else {
      appendLog({ source: 'ui', level: 'system', text: 'stop requested', ts: Date.now() });
      setRunStatus('stopped');
      showQuestionCard(false);
    }
  } catch (e) {
    appendLog({ source: 'ui', level: 'error', text: `stop error: ${e.message}`, ts: Date.now() });
    el.stopBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Install agents
// ---------------------------------------------------------------------------
el.installBtn.addEventListener('click', async () => {
  const projectDir = el.projectDir.value.trim();
  if (!projectDir) return setFormMsg('Enter the project folder first.', 'err');
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
// Log controls
// ---------------------------------------------------------------------------
el.clearLog.addEventListener('click', () => {
  el.log.innerHTML = '';
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
el.refreshHistory.addEventListener('click', () => {
  const dir = el.projectDir.value.trim();
  if (dir) loadHistory(dir);
  else setFormMsg('Enter the project folder to load history.', 'err');
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
// boot
// ---------------------------------------------------------------------------
syncSourceToggle();
setWsStatus(false);
setRunStatus('idle');
connectWS();
