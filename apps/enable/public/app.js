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
let baselineDims = null;
let ws = null;
let currentRunId = null;
let currentHistoryId = null;    // set when viewing a past run from disk (no live socket)

// ---------- screen switching ----------
function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === id);
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

// ---------- run ----------
async function start(projectDir, answers) {
  const mock = document.querySelector('#mock-toggle').checked;
  const sourceBranch = document.querySelector('#source-branch')?.value || undefined;
  resetProgress();
  show('progress');
  let runId;
  try {
    const res = await fetch('/api/enable/run', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectDir, answers, mock, sourceBranch }) });
    if (!res.ok) { showError((await res.json().catch(() => ({}))).error || `run failed (${res.status})`); return; }
    ({ runId } = await res.json());
  } catch (err) { showError(String(err.message || err)); return; }

  if (ws) { try { ws.close(); } catch {} }   // drop the previous run's socket
  currentRunId = runId;
  currentHistoryId = null;                     // a live run supersedes any disk view
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
      if (ev.kind === 'baseline') { baseline = ev.score; baselineDims = ev.dimensions || null; renderRing(ev.score, null); }
      if (ev.kind === 'cycle')    { setPassLabel(ev.cycle); if (ev.score != null) renderRing(ev.score, baseline); }
      if (ev.kind === 'final')    renderResults(ev);
      break;
    case 'done':     if (ev.status === 'error') showError('The run ended with an error.'); break;
    case 'error':    showError(ev.message); break;
  }
}

// ---------- progress rendering ----------
function resetProgress() {
  baseline = null;
  baselineDims = null;
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
  document.querySelector('#result-branch').textContent = r.branch ? `Branch: ${r.branch}` : '';
  if (currentRunId) loadChanges(`/api/enable/runs/${currentRunId}/changes`);
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
    // A real run shows its score; a dry run has none by design (mock never scores),
    // so label it "dry run" rather than a bare status word that reads as a failure.
    const scoreHtml = r && r.score != null
      ? (r.baselineScore != null ? `${Math.round(r.baselineScore)} → ${Math.round(r.score)}` : `${Math.round(r.score)}`)
      : (h.mock ? '<span class="hist-mock">dry run</span>' : esc(h.status || ''));
    li.innerHTML = `<span class="hist-project">${esc(h.projectName || h.title || '')}</span>
      <span class="hist-when">${when}</span><span class="hist-score">${scoreHtml}</span>`;
    li.addEventListener('click', () => showHistoryDetail(h.id));
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
  currentHistoryId = id;                      // .md preview reads from this run's dir
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

  document.querySelector('#browse-btn').addEventListener('click', openPicker);
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
  document.querySelector('#project-select').addEventListener('change', refreshBranches);
  document.querySelector('#project-path').addEventListener('change', refreshBranches);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !picker.hidden) closePicker();
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
    raw.hidden = !raw.hidden;
    document.querySelector('#details-toggle').textContent = raw.hidden ? 'Show details' : 'Hide details';
  });
}

document.addEventListener('DOMContentLoaded', init);
