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
  workflowId: 'wf_default', // currently selected workflow in New Pipeline
  agents: {}, // registry { [key]: AgentMeta }, lazily loaded from /api/agents
  workflowCache: {}, // { [id]: WorkflowTemplate } from GET /api/workflows/:id
  stepDefaults: {}, // { [key]: { fanOut } } sidecar defaults from /api/config steps
  historyAll: [],    // full /api/history dataset; client-side filter cache
  historyFilter: '', // active projectKey filter for History; '' === All Projects
  ghAvailable: false,// gh CLI availability, from the last /api/history load

  // --- Workspaces ---
  workspaces: [],            // GET /api/workspaces read-model
  selectedWorkspaceId: '',   // '' === none; set ONLY in workspace target mode
  runTarget: 'project',      // 'project' | 'workspace' — New Pipeline target toggle
  // --- Creation wizard (ephemeral; reset on wizard close) ---
  wizard: {
    step: 1, name: '', selectedPaths: [], scanId: '', description: '',
    graphifyUsed: null, abort: null, editingId: '',
  },
};

// UI tracker step roles, in order. (Mirrors the server's AGENT_STEPS keys; the
// server is authoritative — see loadConfig, which also receives data.steps.)
const STEP_ROLES = ['clarify', 'planner', 'refiner', 'implementer', 'reviewer'];

import {
  topology,
  metaLine,
  distinctAgents,
  defaultTopologyFromTemplate,
  mergePalette,
  canConnect,
  EMBEDDED_AGENTS,
} from './composer-core.mjs';
import { logLineClass } from './log-line.mjs';

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
  sourceBranch: $('#sourceBranch'),
  featureBranch: $('#featureBranch'),
  sourceRadios: $$('input[name="source"]'),
  promptPane: $('#prompt-pane'),
  markdownPane: $('#markdown-pane'),
  prompt: $('#prompt'),
  promptMarkdown: $('#promptMarkdown'),
  mdFile: $('#mdFile'),
  mdFileName: $('#mdFileName'),
  extras: $('#extras'),
  extrasNote: $('#extrasNote'),
  mock: $('#mock'),
  startBtn: $('#start-btn'),
  formMsg: $('#form-msg'),

  pipelineConfig: $('#pipeline-config'),
  workflowSelect: $('#workflowSelect'),
  wfDefaultStages: $('#wf-default-stages'),
  wfNodeConfig: $('#wf-node-config'),
  wfFeedbackConfig: $('#wf-feedback-config'),

  history: $('#history'),
  historyFilter: $('#historyFilter'),
  refreshHistory: $('#refresh-history'),
  navHistoryCount: $('#nav-history-count'),
  navWorkspacesCount: $('#nav-workspaces-count'),

  // Target selector (New Pipeline)
  targetSeg: $('#target-seg'),
  targetRadios: $$('input[name="target"]'),
  targetProjectPane: $('#target-project-pane'),
  targetWorkspacePane: $('#target-workspace-pane'),
  workspaceSelect: $('#workspaceSelect'),
  wsMembers: $('#ws-members'),
  sourceBranchHint: $('#sourceBranchHint'),
  sourceBranchWrap: $('#sourceBranchWrap'),
  wsSourceBranches: $('#ws-source-branches'),

  // Workspaces management view
  wsCreateBtn: $('#ws-create-btn'),
  wsMsg: $('#ws-msg'),
  wsList: $('#ws-list'),

  // Wizard
  wizName: $('#wiz-name'),
  wizProjects: $('#wiz-projects'),
  wizStep1Hint: $('#wiz-step1-hint'),
  wizStartScan: $('#wiz-start-scan'),
  wizStatus: $('#wiz-status'),
  wizProgress: $('#wiz-progress'),
  wizPhases: $('#wiz-phases'),
  wizAbort: $('#wiz-abort'),
  wizDesc: $('#wiz-desc'),
  wizGraphifyNote: $('#wiz-graphify-note'),
  wizMsg: $('#wiz-msg'),
  wizRescan: $('#wiz-rescan'),
  wizSave: $('#wiz-save'),
  wizClose: $('#wiz-close'),
  wizTitle: $('#wiz-title'),

  viewerCard: $('#viewer-card'),
  viewerTitle: $('#viewer-title'),
  viewer: $('#viewer'),
  viewerClose: $('#viewer-close'),

  settingsRoot: $('#settingsRoot'),
  settingsRootDefault: $('#settingsRootDefault'),
  settingsSave: $('#settingsSave'),
  settingsReset: $('#settingsReset'),
  settingsMsg: $('#settingsMsg'),
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

  // Scan events are tagged by scanId (not runId) and ride the same broadcast
  // socket. Handle them BEFORE the !msg.runId early-return below.
  if (msg.type === 'scan-progress' || msg.type === 'scan-done' || msg.type === 'scan-error') {
    onScanEvent(msg);
    return;
  }

  // History PR-enrichment batches are token-tagged (not runId-tagged) and ride the
  // same broadcast socket. Handle them BEFORE the !msg.runId early-return below.
  if (msg.type === 'history-pr') {
    onHistoryPr(msg);
    return;
  }

  // Tagged per-run event. Ignore anything without a runId.
  if (!msg.runId) return;
  // A 'subagent' delta attaches to an existing run; it must never MATERIALIZE one.
  // A sub-agent with no parent run is meaningless, and auto-creating a card here is
  // exactly what produced the phantom "(untitled)" pipeline. Other event types may
  // legitimately create a card for a run this tab didn't start (CLI / another tab),
  // and `state` snapshots reconcile r.subAgents anyway, so nothing is lost.
  if ((msg.type === 'subagent' || msg.type === 'asset') && !runs.has(msg.runId)) return;
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
    case 'subagent':
      onSubagent(r, msg);
      break;
    case 'asset':
      onAsset(r, msg);
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
    const rr = upsertRun({
      runId: r0.runId,
      title: r0.title,
      projectDir: r0.projectDir,
      status: r0.status,
      startedAt: r0.startedAt,
      pendingQuestion: r0.pendingQuestion || null,
    });
    // Seed the run's stepper from the hello summary so the live card resolves
    // sub-agents to their real (s0_0-keyed) nodes BEFORE any subagent delta paints
    // — closing the window where r.stepper is null and the graph falls back to the
    // legacy default (mismatched ids → no squares + a raw "s0_0" dropdown group).
    if (r0.stepper && rr.stepper == null) {
      rr.stepper = r0.stepper;
      if (rr.el) rebuildStepperDom(rr);
    }

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
  // Background-load history on the first connect so the sidebar count + PR states
  // populate even when boot lands on another view (e.g. New pipeline). Reconnects
  // skip this; an open History view still re-loads to refresh its data.
  if (cur === 'history' || !historyBooted) loadHistoryView();
  historyBooted = true;
}

function currentView() {
  const h = location.hash.slice(1);
  return VIEW_NAMES.includes(h) ? h : 'new';
}

// ---------------------------------------------------------------------------
// Steps tracker
// ---------------------------------------------------------------------------

// Normalize a core phase name to one of our tracker step keys.
// Order matters: more specific phases ("refine", "review", "implement") are
// matched before the generic "plan"/"clarify" fallback, because names like
// "plan-refine" contain the substring "plan".
function normalizePhase(phase) {
  if (!phase) return null;
  const p = String(phase).toLowerCase();
  if (p.includes('preflight')) return 'preflight';
  if (p.includes('manual-web')) return 'manual-web';
  if (p.includes('manual-checklist') || p.includes('manual-test')) return 'manual-checklist';
  if (p.includes('refine')) return 'refine';
  if (p.includes('review')) return 'review';
  if (p.includes('implement')) return 'implement';
  if (p.includes('done') || p.includes('complete') || p.includes('finish')) return 'done';
  if (p.includes('clarify')) return 'clarify';
  if (p.includes('plan')) return 'plan';
  return null;
}

// Legacy default stepper, used when a run predates state.stepper (old history)
// or before the first 'state' event arrives. Node ids = uiPhase keys so old
// per-step costs/durations (bucketed by phase) still attribute correctly.
const CLIENT_DEFAULT_STEPPER = {
  version: 1,
  steps: [
    { kind: 'preflight', nodes: [{ id: 'preflight', label: 'Preflight', sub: 'checks' }] },
    { kind: 'agents', nodes: [{ id: 'clarify',   uiPhase: 'clarify',   label: 'Clarify',   color: 'red',    cycles: false }] },
    { kind: 'agents', nodes: [{ id: 'plan',      uiPhase: 'plan',      label: 'Plan',      color: 'violet', cycles: false }] },
    { kind: 'agents', nodes: [{ id: 'refine',    uiPhase: 'refine',    label: 'Refine',    color: 'green',  cycles: true  }] },
    { kind: 'agents', nodes: [{ id: 'implement', uiPhase: 'implement', label: 'Implement', color: 'amber',  cycles: false }] },
    { kind: 'agents', nodes: [{ id: 'review',    uiPhase: 'review',    label: 'Review',    color: 'blue',   cycles: true  }] },
    { kind: 'done', nodes: [{ id: 'done', label: 'Done', sub: 'complete' }] },
  ],
  feedbacks: [],
};

// Pick the manifest to render: prefer a persisted/emitted one, else the legacy
// default. Defensive against malformed shapes.
function manifestFor(stepper) {
  if (stepper && Array.isArray(stepper.steps) && stepper.steps.length) return stepper;
  return CLIENT_DEFAULT_STEPPER;
}

// Stable node-id signature of a manifest. Used to detect a manifest REPLACEMENT
// (e.g. a decomposed run rewrites the implementer node into per-phase/per-task
// nodes) so the live view can re-swap + rebuild mid-run.
function manifestSig(stepper) {
  const m = manifestFor(stepper);
  return (Array.isArray(m.steps) ? m.steps : [])
    .map((cell) => (Array.isArray(cell.nodes) ? cell.nodes.map((n) => n.id).join(',') : ''))
    .join('|');
}

// Resolve an incoming phase/state event to a cell index + node id within a run's
// manifest. nodeId (node phase events) pins the exact node; bookend/legacy events
// match by phase: preflight/done by kind, everything else by uiPhase.
function locateInManifest(manifest, msg) {
  const m = manifestFor(manifest);
  if (msg.nodeId) {
    for (let i = 0; i < m.steps.length; i++) {
      if (m.steps[i].nodes.some((n) => n.id === msg.nodeId)) return { cellIdx: i, nodeId: msg.nodeId };
    }
  }
  const key = normalizePhase(msg.phase);
  if (key === 'preflight') return { cellIdx: 0, nodeId: 'preflight' };
  if (key === 'done') return { cellIdx: m.steps.length - 1, nodeId: 'done' };
  for (let i = 0; i < m.steps.length; i++) {
    const hit = m.steps[i].nodes.find((n) => n.uiPhase === key);
    if (hit) return { cellIdx: i, nodeId: hit.id };
  }
  return { cellIdx: -1, nodeId: null };
}

// Map a phase status string + run status to a stepper node kind.
function nodeKindFor(r, status) {
  if (r.pendingQuestion != null) return 'pause';
  if (r.status === 'stopped') return 'stop';
  if (['done', 'complete', 'passed', 'finish'].includes(status)) return 'done';
  return 'now';
}

// Apply one phase/state transition to the run's live node-status map.
// The scalar trackers (phaseKey/cycle/phaseStatus) drive the foot chip + status
// pill and are kept in sync even when the phase isn't locatable in this run's
// manifest (e.g. a manual-web phase on the legacy default manifest) — only the
// cell-level node-status map needs a resolved cell + node id.
function advanceRun(r, msg) {
  r.phaseKey = normalizePhase(msg.phase) || r.phaseKey;
  if (msg.cycle) r.cycle = msg.cycle;
  r.phaseStatus = msg.status || '';
  const { cellIdx, nodeId } = locateInManifest(r.stepper, msg);
  if (cellIdx < 0 || !nodeId) return;
  if (cellIdx > r.maxCellIdx) r.maxCellIdx = cellIdx;
  if (msg.cycle) r.nodeCycle[nodeId] = Math.max(r.nodeCycle[nodeId] || 0, Number(msg.cycle) || 0);
  r.nodeStatus[nodeId] = nodeKindFor(r, msg.status || '');
}

// Replace a live card's stepper DOM when the manifest first arrives/changes.
function rebuildStepperDom(r) {
  const host = r.el && r.el.querySelector('.run-flow');
  if (host) buildRunGraph(host, r.stepper);
}

// ---------------------------------------------------------------------------
// Run/history node-graph (composer-style). buildRunGraph builds the static
// .run-flow skeleton; paintRunGraph tints it + repaints wires via the shared
// composerPaintWires. Walks the stepper manifest and emits composer .node markup.
// ---------------------------------------------------------------------------

// Resolve a manifest node to its agent meta (icon/displayName/description/color).
// Manifest nodes carry .key (set by buildStepperManifest); bookends (preflight/
// done) have no key -> a neutral cog so they still render an icon.
//
// IMPORTANT: read composer.agents[key] RAW (not composerAgent(key)). composerAgent
// returns a non-undefined default {displayName:key,...} that would shadow the
// EMBEDDED_AGENTS fallback. Raw access yields undefined when the live registry
// isn't loaded yet, so the `|| EMBEDDED_AGENTS[key]` fallback fires. Do not simplify.
const RUN_BOOKEND_ICON = '<circle cx="12" cy="12" r="3.2"/><path d="M12 4.5v2M12 17.5v2M4.5 12h2M17.5 12h2M6.6 6.6l1.4 1.4M16 16l1.4 1.4M17.4 6.6L16 8M8 16l-1.4 1.4" stroke-linecap="round"/>';
function runNodeAgent(node) {
  const key = node && node.key;
  const live = key && composer.agents && composer.agents[key];
  const embedded = key && EMBEDDED_AGENTS[key];
  const meta = live || embedded || {};
  return {
    icon: meta.icon || RUN_BOOKEND_ICON,
    color: node.color || meta.color || 'blue',
    label: node.label || meta.displayName || node.id,
    sub: node.sub || meta.description || '',
  };
}

// Visible status caption under the node label. pending -> the node's description.
const STAT_TEXT = { done: 'completed', active: 'running…', paused: 'awaiting input', stopped: 'stopped here', pending: '' };

// Settled-status badge markup (check / two-bar / X). active+pending have none.
const STAT_BADGE = {
  done: '<div class="nstat done"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg></div>',
  paused: '<div class="nstat paused"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><rect x="7" y="5" width="3.4" height="14" rx="1"/><rect x="13.6" y="5" width="3.4" height="14" rx="1"/></svg></div>',
  stopped: '<div class="nstat stopped"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg></div>',
};

// Visible "model · effort" sub-line for a run-graph node, mirroring the New-
// pipeline config caption (.step-current): friendly model label + raw effort.
// Bookend cells (Preflight/Done) have no uiPhase and run no model -> no line.
// A step with neither model nor effort inherits the global default -> "default"
// (per-field "default" when only one is set). The "·" is U+00B7, matching the
// composer separator. NOTE: the blank wording is "default" (clarification Q1),
// which intentionally differs from the composer's "default model"/"default effort".
function nodeModelLine(node) {
  if (!node || !node.uiPhase) return '';
  const model = node.model || '';
  const effort = node.effort || '';
  if (!model && !effort) return 'default';
  const m = modelById(model);
  const modelLabel = model ? (m ? m.label : model) : 'default';
  return `${modelLabel} · ${effort || 'default'}`;
}

// Sub-agent square strip for a run-graph node. One <span.sq> per sub-agent
// (.on iff that sub is still `running`), plus an exact ×N count. Squares are
// render-capped (the count text stays exact); no subs -> empty string so a
// node without sub-agents gets no border row. Pulse is CSS-only (.sq.on).
const SUB_SQUARE_CAP = 24;
function subFanHtml(subs) {
  const list = Array.isArray(subs) ? subs : [];
  if (list.length === 0) return '';
  const squares = list
    .slice(0, SUB_SQUARE_CAP)
    .map((s) => `<span class="sq${s && s.status === 'running' ? ' on' : ''}"></span>`)
    .join('');
  return `<div class="fan">${squares}<span class="fl">×${list.length}</span></div>`;
}

// Build one run-graph node element. status ∈ done|active|paused|stopped|pending.
// isSelf => the node is its own self-cycle target (gets the .iterates ring).
function runNode(node, status, isSelf) {
  const ag = runNodeAgent(node);
  const d = document.createElement('div');
  d.className = `node run-node is-${status}` + (isSelf ? ' iterates' : '');
  d.dataset.id = node.id;
  d.style.setProperty('--c', COMPOSER_COLORS[ag.color] || '#ccc');
  const statusText = STAT_TEXT[status] != null ? STAT_TEXT[status] : '';
  // model · effort is now a VISIBLE sub-line under cost/time (was a hover tooltip).
  const meLine = nodeModelLine(node);
  d.innerHTML =
    `<div class="nic" style="background:${COMPOSER_TINTS[ag.color] || '#eee'};color:${COMPOSER_COLORS[ag.color] || '#888'}">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">${ag.icon}</svg></div>` +
    `<div class="nmeta"><b>${escapeHtml(ag.label)}</b>` +
      `<small class="nstatus">${escapeHtml(statusText || (status === 'pending' ? (node.sub || ag.sub || '') : ''))}</small>` +
      `<div class="nrun"><span class="dur"></span><span class="cost"></span></div>` +
      (meLine ? `<small class="nmodel">${escapeHtml(meLine)}</small>` : '') +
    `</div>` +
    (STAT_BADGE[status] || '');
  return d;
}

// The set of node ids in a manifest, in column order, as a stable signature.
function runGraphNodeIds(manifest) {
  const ids = [];
  manifest.steps.forEach((cell) => cell.nodes.forEach((n) => ids.push(n.id)));
  return ids;
}

// Build (or rebuild) the .run-flow skeleton into `host`. Idempotent: if the
// host already holds a graph for the SAME ordered node-id set, leave the DOM
// (and its running CSS animations) intact. Trailing <svg class="wires"> is the
// shared renderer's target.
function buildRunGraph(host, manifest) {
  const m = manifestFor(manifest);
  const ids = runGraphNodeIds(m);
  if (host.dataset.graphSig === ids.join('|') && host.querySelector('svg.wires')) return;
  host.dataset.graphSig = ids.join('|');
  host.dataset.wiresSig = ''; // force a wire repaint after a structural rebuild
  host.innerHTML = '';

  const selfTargets = new Set(
    (Array.isArray(m.feedbacks) ? m.feedbacks : [])
      .filter((fb) => fb && fb.from === fb.to)
      .map((fb) => fb.from),
  );

  host.appendChild(Object.assign(document.createElement('div'), { className: 'strip' }));
  m.steps.forEach((cell, i) => {
    const col = document.createElement('div');
    col.className = 'col';
    col.dataset.cellIdx = String(i);
    const tag = document.createElement('div');
    tag.className = 'col-tag';
    tag.innerHTML = (cell.label ? escapeHtml(cell.label) : `Step ${i + 1}`) + (cell.nodes.length > 1 ? ' · <em>parallel</em>' : '');
    col.appendChild(tag);
    for (const node of cell.nodes) col.appendChild(runNode(node, 'pending', selfTargets.has(node.id)));
    host.appendChild(col);
  });
  host.appendChild(Object.assign(document.createElement('div'), { className: 'strip' }));

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'wires');
  host.appendChild(svg);
}

// Final per-node loop count the renderer consumes directly: a node that ran k
// cycles fired its loop k-1 times. nodeCycle[id] = max cycle observed (default 1).
function loopCounts(manifest, nodeCycle) {
  const nc = nodeCycle || {};
  const out = {};
  runGraphNodeIds(manifestFor(manifest)).forEach((id) => {
    out[id] = Math.max(0, (nc[id] || 1) - 1);
  });
  return out;
}

// manifest.steps (cells with .nodes) -> the [[{id}…]…] shape composerPaintWires
// walks for sequential + feedback wires.
function manifestStepsForWires(manifest) {
  return manifestFor(manifest).steps.map((cell) => cell.nodes.map((n) => ({ id: n.id })));
}

// Tint the run-graph from a view-adapter and (signature-gated) repaint wires.
// view = { statusOf(id)->status, activeId|null, cycles:{id:count(FINAL)},
//          live:boolean, durText(id)->str, costText(id)->str,
//          subsOf?(id)->Array<{status}> (optional; sub-agent squares) }.
const RUN_STATUSES = ['is-pending', 'is-done', 'is-active', 'is-paused', 'is-stopped'];
function paintRunGraph(host, manifest, view) {
  const m = manifestFor(manifest);
  const doneSet = new Set();
  runGraphNodeIds(m).forEach((id) => {
    const status = view.statusOf(id) || 'pending';
    if (status === 'done') doneSet.add(id);
    const el = host.querySelector(`.run-node[data-id="${id}"]`);
    if (!el) return;

    el.classList.remove(...RUN_STATUSES);
    el.classList.add('is-' + status);

    const statusEl = el.querySelector('.nstatus');
    if (statusEl) {
      const txt = STAT_TEXT[status];
      statusEl.textContent = (txt != null && txt !== '') ? txt : (status === 'pending' ? (statusEl.dataset.sub || statusEl.textContent || '') : '');
    }

    // Swap the settled-status badge (.nstat). Remove any existing, then re-add.
    const old = el.querySelector('.nstat');
    if (old) old.remove();
    if (STAT_BADGE[status]) el.insertAdjacentHTML('beforeend', STAT_BADGE[status]);

    const durEl = el.querySelector('.dur');
    if (durEl) durEl.textContent = view.durText(id) || '';
    const costEl = el.querySelector('.cost');
    if (costEl) costEl.textContent = view.costText(id) || '';

    // Sub-agent square strip (graph view only; optional adapter). Idempotent:
    // drop the old strip, inject the current one. Empty -> no strip / no row.
    const oldFan = el.querySelector('.fan');
    if (oldFan) oldFan.remove();
    const fanHtml = view.subsOf ? subFanHtml(view.subsOf(id)) : '';
    if (fanHtml) el.insertAdjacentHTML('beforeend', fanHtml);
  });

  // Signature-gated wire repaint: avoid restarting CSS glow / marching-ants
  // every tick. Repaint only when activeId, the done-set, the loop counts, or
  // the topology change since the last paint.
  const cycles = view.cycles || {};
  const sig = JSON.stringify([
    view.live ? (view.activeId || null) : null,
    [...doneSet].sort(),
    Object.keys(cycles).sort().map((k) => `${k}:${cycles[k]}`),
    host.dataset.graphSig || '',
  ]);
  if (host.dataset.wiresSig === sig) return;
  host.dataset.wiresSig = sig;

  const svg = host.querySelector('svg.wires');
  if (!svg) return;
  const steps = manifestStepsForWires(m);
  const feedbacks = Array.isArray(m.feedbacks) ? m.feedbacks : [];
  const paint = (window.__np && window.__np.composerPaintWires) || composerPaintWires;
  const ns = (host.dataset.ns ||= 'rg-' + Math.random().toString(36).slice(2, 8));
  paint(host, svg, steps, feedbacks, {
    ns,
    runMode: true,
    activeId: view.live ? (view.activeId || null) : null,
    doneSet,
    cycles,
  });
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
    stepper: null,        // run's own stepper manifest (from 'state'); null => legacy default
    nodeStatus: {},       // { nodeId|bookendId: 'done'|'now'|'pause'|'stop' } live cell state
    nodeCycle: {},        // { nodeId: max cycle observed } -> drives loop badges
    maxCellIdx: -1,       // highest reached cell index (drives "earlier cells = done")
    phaseKey: 'preflight',
    cycle: 0,
    phaseStatus: '',
    costByNode: {},       // { nodeId|uiPhase: usd } for the live stepper
    totalCostUsd: 0,   // pipeline total for the card meta line
    steps: [],         // raw steps[] from the latest state snapshot (for live timers)
    pendingQuestion,
    logLines: [],
    subAgents: [],     // Array<record> — sub-agent lifecycle for this run (see onSubagent/onState)
    assets: [],        // Array<record> — asset invocations (Skill/Agent/graphify); see onAsset/onState
    el: null,
    _finished: false,
  };
}

// Upsert a run model. Only assigns DEFINED keys from the partial, and callers
// must never pass logLines/el in a partial — those heavy/DOM
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
  advanceRun(r, msg);
  if (normalizePhase(msg.phase) === 'done') {
    r.maxCellIdx = manifestFor(r.stepper).steps.length - 1;
    r.phaseKey = 'done';
  }
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

// Minimal HTML escape for text interpolated into node innerHTML.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

// Format a duration in ms as a compact human string. Twin of fmtUsd: non-finite
// or negative -> ''. <60s -> 'Ns'; <1h -> 'Mm Ss'; else 'Hh Mm'. Math.round
// is half-up (500ms -> '1s').
function fmtDuration(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return '';
  const s = Math.round(v / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Live ms for one step: finalized activeMs plus the running tail when live.
// History passes live=false so a dangling runningSince never contributes.
function liveStepMs(step, now, live = true) {
  const base = Number(step?.activeMs) || 0;
  return live && step?.runningSince != null ? base + Math.max(0, now - step.runningSince) : base;
}

// Live total = sum of all steps' live ms (finalized + running tails). Running only.
function liveTotalMs(steps, now = Date.now()) {
  let sum = 0;
  for (const s of Array.isArray(steps) ? steps : []) {
    if (s && s.activeMs != null) sum += liveStepMs(s, now, true);
  }
  return sum;
}

// A step's stepper bucket key: its node id when present (new runs), else the
// normalized phase (legacy runs, whose default-manifest node ids ARE uiPhases).
function stepBucketKey(s) {
  return (s && typeof s.nodeId === 'string' && s.nodeId) ? s.nodeId : normalizePhase(s && s.phase);
}

// Per-node active-ms bucket, keyed by stepBucketKey.
function durByNode(steps, now = Date.now(), live = true) {
  const out = {};
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || s.activeMs == null || !Number.isFinite(Number(s.activeMs))) continue;
    const key = stepBucketKey(s);
    if (key) out[key] = (out[key] || 0) + liveStepMs(s, now, live);
  }
  return out;
}

// Per-node cost bucket, keyed by stepBucketKey.
function costByNode(steps) {
  const out = {};
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || s.costUsd == null) continue;
    const c = Number(s.costUsd);
    if (!Number.isFinite(c) || c < 0) continue;
    const key = stepBucketKey(s);
    if (key) out[key] = (out[key] || 0) + c;
  }
  return out;
}

// A single node's sub-agents (for its graph card), preserving insertion order.
// Pure view-adapter consumed by the render layer; r.subAgents is maintained by
// onSubagent (deltas) + onState (authoritative snapshot).
function subAgentsOf(r, nodeId) {
  const list = r && Array.isArray(r.subAgents) ? r.subAgents : [];
  return list.filter((s) => s && s.nodeId === nodeId);
}

// Find the manifest node with this id across all cells (null if absent).
function findManifestNode(stepper, nodeId) {
  const m = manifestFor(stepper);
  for (const cell of m.steps) for (const n of cell.nodes) if (n.id === nodeId) return n;
  return null;
}

// Sub-agents to render on a graph node. Exact nodeId match first; if none, fall
// back to the node's uiPhase — covers the window before the real s0_0-keyed stepper
// arrives, when the graph is built from the legacy uiPhase-keyed default (its node
// ids ARE uiPhases, and the sub-agents carry uiPhase). `src` = live run r or
// history state st (both expose .subAgents + .stepper).
function subAgentsForNode(src, nodeId) {
  const exact = subAgentsOf(src, nodeId);
  if (exact.length) return exact;
  const node = findManifestNode(src && src.stepper, nodeId);
  if (node && node.uiPhase) {
    const list = src && Array.isArray(src.subAgents) ? src.subAgents : [];
    return list.filter((s) => s && s.uiPhase === node.uiPhase);
  }
  return exact;
}

// Group sub-agents by nodeId for display (the DB keys by step_key, but the UI
// groups by node — §7). Map<nodeId, {subs, spawned, active}>; active = running.
// Records with no nodeId are skipped (cannot be placed on a card).
function subsByNode(subAgents) {
  const out = new Map();
  for (const s of Array.isArray(subAgents) ? subAgents : []) {
    if (!s || s.nodeId == null) continue;
    let g = out.get(s.nodeId);
    if (!g) { g = { subs: [], spawned: 0, active: 0 }; out.set(s.nodeId, g); }
    g.subs.push(s);
    g.spawned += 1;
    if (s.status === 'running') g.active += 1;
  }
  return out;
}

// {nodeId: Array<sub>} — the .subs arrays from subsByNode, the shape the pill/tree
// helpers (paintSubsBar/subsPillText/renderSubsTree) consume. Bridges the C-layer
// Map grouping to the D-layer object-of-arrays consumers.
function subsByNodeArrays(subAgents) {
  return Object.fromEntries([...subsByNode(subAgents)].map(([k, g]) => [k, g.subs]));
}

// ── "Assets used" panel helpers (Skills / Agents / graphify) ────────────────
// Dedup asset invocations by (kind, name) into ordered groups with a count and
// the underlying items (for drill-down). graphify-via-Skill and graphify-via-Bash
// both normalise to (graphify, graphify) and collapse into one group.
function assetRollup(assets) {
  const order = [], by = new Map();
  for (const a of (assets || [])) {
    const k = a.kind + ' ' + a.name;
    if (!by.has(k)) { by.set(k, { kind: a.kind, name: a.name, count: 0, items: [] }); order.push(k); }
    const g = by.get(k); g.count++; g.items.push(a);
  }
  return order.map((k) => by.get(k));
}
// Collapsed-pill summary: total invocations + distinct (kind,name) assets.
function assetsPillText(assets) {
  const total = (assets || []).length;
  if (!total) return { text: 'No assets used', empty: true };
  const distinct = new Set((assets || []).map((a) => a.kind + ' ' + a.name)).size;
  return { text: `${total} invocation${total === 1 ? '' : 's'} · ${distinct} asset${distinct === 1 ? '' : 's'}`, empty: false };
}
const ASSET_KIND_LABEL = { skill: 'Skill', agent: 'Agent', graphify: 'graphify' };

// Paint the "Assets used" disclosure (button pill + drill-down panel). Mirrors
// paintSubsBar: idempotent click binding, always visible once a run exists,
// reuses escapeHtml. Empty -> greyed pill + empty-state line.
function paintAssetsPanel(barEl, assets) {
  if (!barEl) return;
  const rollup = assetRollup(assets);
  barEl.hidden = false;                                  // always present once a run exists
  const btn = barEl.querySelector('.btn-assets');
  const count = barEl.querySelector('.ab-count');
  const panel = barEl.querySelector('.assets-panel');
  const pill = assetsPillText(assets);
  count.textContent = pill.text;
  count.classList.toggle('grey', pill.empty);
  if (!btn.dataset.bound) {                              // bind once
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!open));
      panel.hidden = open;
    });
  }
  panel.innerHTML = rollup.map((g) => `
    <div class="assets-row" data-kind="${g.kind}">
      <span class="a-dot ${g.kind}"></span>
      <span class="a-kind">${escapeHtml(ASSET_KIND_LABEL[g.kind] || g.kind)}</span>
      <b class="a-name">${escapeHtml(g.name)}</b>
      <span class="a-count">×${g.count}</span>
      <ul class="a-items">${g.items.map((it) =>
        `<li>${escapeHtml(it.detail || '')}${it.uiPhase ? ` <em>(${escapeHtml(it.uiPhase)})</em>` : ''}</li>`).join('')}</ul>
    </div>`).join('') || '<div class="assets-empty">No Skills, Agents or graphify were invoked.</div>';
}

// Group key separator for (nodeId, cycle) dropdown groups. | never occurs
// in a nodeId (alphanumerics + underscore) or an integer, so split is unambiguous.
const CYCLE_KEY_SEP = '|';

// {`${nodeId}|${cycle}`: Array<sub>} — like subsByNodeArrays but split per
// cycle so refine/review loops show one dropdown group per cycle (records carry
// `cycle`). Insertion order = encounter order (already (started_at,id)-sorted from
// the DB / push order live). Skips records with no nodeId.
function subsByNodeCycleArrays(subAgents) {
  const out = {};
  for (const s of Array.isArray(subAgents) ? subAgents : []) {
    if (!s || s.nodeId == null) continue;
    const key = `${s.nodeId}${CYCLE_KEY_SEP}${s.cycle ?? 0}`;
    (out[key] ||= []).push(s);
  }
  return out;
}

// Map<nodeId, Set<cycle>> — distinct cycles each node spawned sub-agents in.
// Drives whether a group header gets a "· cycle N" suffix. Record-driven: the
// suffix appears when a node actually has sub-agents across >1 cycle, independent
// of any manifest `cycles` flag.
function cyclesPerNode(subAgents) {
  const m = new Map();
  for (const s of Array.isArray(subAgents) ? subAgents : []) {
    if (!s || s.nodeId == null) continue;
    let set = m.get(s.nodeId);
    if (!set) { set = new Set(); m.set(s.nodeId, set); }
    set.add(s.cycle ?? 0);
  }
  return m;
}

// Composite-key (nodeId|cycle) -> display label. Resolves the node label by
// nodeId, then by uiPhase (id-agnostic fallback when the real stepper is absent),
// then the raw id. Appends "· cycle N" only when that node spans >1 cycle (so
// single-cycle steps like Plan render exactly as before).
function cycleAwareLabel(stepper, subAgents) {
  const byId = nodeLabelLookup(stepper);              // nodeId -> label (raw id fallback)
  const m = manifestFor(stepper);
  const phaseToLabel = {};                            // uiPhase -> label
  m.steps.forEach((cell) => cell.nodes.forEach((n) => { if (n.uiPhase) phaseToLabel[n.uiPhase] = n.label || n.uiPhase; }));
  const idToPhase = {};                               // nodeId -> uiPhase (from records)
  for (const s of Array.isArray(subAgents) ? subAgents : []) {
    if (s && s.nodeId != null && s.uiPhase != null) idToPhase[s.nodeId] = s.uiPhase;
  }
  const multi = cyclesPerNode(subAgents);
  return (key) => {
    const i = String(key).indexOf(CYCLE_KEY_SEP);
    const nodeId = i >= 0 ? String(key).slice(0, i) : String(key);
    const cycle = i >= 0 ? (Number(String(key).slice(i + 1)) || 0) : 0;
    let label = byId(nodeId);
    if (label === nodeId && idToPhase[nodeId] && phaseToLabel[idToPhase[nodeId]]) {
      label = phaseToLabel[idToPhase[nodeId]];
    }
    const set = multi.get(nodeId);
    if (set && set.size > 1) label += ` · cycle ${cycle}`;
    return label;
  };
}

function onState(r, msg) {
  if (msg.status) r.status = msg.status;
  if (msg.startedAt) r.startedAt = msg.startedAt;
  if (msg && msg.branch && msg.branch.feature) {
    r.branchFeature = msg.branch.feature;
  }
  // Swap the manifest when it FIRST arrives OR when its node-id signature changes
  // (a decomposed run rewrites the implementer node into per-phase/per-task nodes
  // mid-run). Rebuild the stepper DOM so subsequent paints address the right nodes.
  if (msg.stepper && (r.stepper == null || manifestSig(msg.stepper) !== manifestSig(r.stepper))) {
    r.stepper = msg.stepper;
    if (r.el) rebuildStepperDom(r);
  }
  if (Array.isArray(msg.steps)) {
    r.steps = msg.steps;
    r.costByNode = costByNode(msg.steps);
  }
  if (typeof msg.totalCostUsd === 'number') r.totalCostUsd = msg.totalCostUsd;
  // Sub-agents: the state snapshot is authoritative (covers late-join/replay and
  // any missed `subagent` delta). Replace wholesale when present; a snapshot that
  // omits the field (older runs / partial snapshots) leaves the delta-built array.
  r.subAgents = msg.subAgents || r.subAgents;
  r.assets = msg.assets || r.assets;
  if (msg.phase) advanceRun(r, msg);
  maybeResume(r);
  paintRunCard(r);
}

// Per-run sub-agent lifecycle delta. Upsert into r.subAgents by `id`: a spawn
// inserts/updates the record; a finish updates status + finishedAt + telemetry.
// Then repaint via the same path onState/onPhase use (paintRunCard -> paintStepper),
// so the graph card the render layer builds reflects the change immediately. The
// authoritative full set still arrives on the `state` snapshot (see onState).
function onSubagent(r, msg) {
  if (!msg || !msg.id) return;
  let rec = r.subAgents.find((s) => s.id === msg.id);
  if (!rec) {
    rec = { id: msg.id };
    r.subAgents.push(rec);
  }
  // Merge only DEFINED fields (a finish frame may omit spawn-time fields like
  // label/nodeId/stepKey; never overwrite a known value with undefined).
  for (const k of ['label', 'nodeId', 'uiPhase', 'stepIndex', 'cycle', 'stepKey', 'status', 'startedAt', 'durationMs', 'tokens', 'costUsd']) {
    if (msg[k] !== undefined) rec[k] = msg[k];
  }
  if (msg.transition === 'finish') {
    if (msg.status === undefined) rec.status = rec.status === 'running' || rec.status == null ? 'finished' : rec.status;
    rec.finishedAt = msg.finishedAt !== undefined ? msg.finishedAt
      : (msg.ts != null ? new Date(msg.ts).toISOString() : new Date().toISOString());
  }
  paintRunCard(r);
}

// Upsert one asset-invocation delta by tool_use id (mirrors onSubagent; the full
// `state` snapshot remains the reconcile source of truth via onState).
function onAsset(r, msg) {
  if (!msg || !msg.id) return;
  if (!Array.isArray(r.assets)) r.assets = [];
  const i = r.assets.findIndex((a) => a.id === msg.id);
  const rec = { id: msg.id, kind: msg.kind, name: msg.name, detail: msg.detail,
                nodeId: msg.nodeId, uiPhase: msg.uiPhase, stepIndex: msg.stepIndex,
                cycle: msg.cycle, stepKey: msg.stepKey, invokedAt: msg.invokedAt };
  if (i === -1) r.assets.push(rec); else r.assets[i] = { ...r.assets[i], ...rec };
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
    state.stepDefaults = {};
    if (Array.isArray(data.steps)) {
      for (const s of data.steps) if (s && s.key) state.stepDefaults[s.key] = { fanOut: !!s.fanOut };
    }
  } catch {
    /* keep last-known config */
  }
  // Seed the active workflow from per-project run-config (activeWorkflowId),
  // then populate the dropdown + render the chosen workflow's config. This
  // supersedes the bare renderStepConfigs() call: the default branch still calls
  // renderStepConfigs() internally for backward-compat.
  if (state.config.activeWorkflowId) state.workflowId = state.config.activeWorkflowId;
  await loadWorkflowsInto(state.workflowId);
}

// ---------------------------------------------------------------------------
// Pipeline Composer — /api/workflows + /api/agents client wrappers
// ---------------------------------------------------------------------------
async function fetchAgents() {
  try {
    const res = await fetch('/api/agents');
    if (!res.ok) return null;
    return await safeJson(res);
  } catch {
    return null; // composer falls back to the embedded registry
  }
}

async function listWorkflows() {
  try {
    const res = await fetch('/api/workflows');
    const data = await safeJson(res);
    if (!res.ok) return [];
    return Array.isArray(data.workflows) ? data.workflows : [];
  } catch {
    return [];
  }
}

async function getWorkflow(id) {
  try {
    const res = await fetch(`/api/workflows/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return await safeJson(res);
  } catch {
    return null;
  }
}

async function saveWorkflow({ name, steps, feedbacks }) {
  const res = await fetch('/api/workflows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, steps, feedbacks }),
  });
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data.error || `save failed (${res.status})`);
  return data.workflow;
}

async function deleteWorkflow(id) {
  const res = await fetch(`/api/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data.error || `delete failed (${res.status})`);
  return true;
}

// ---------------------------------------------------------------------------
// Pipeline Composer module (ported from docs/pipeline-composer/mockups).
// Pure serialization lives in composer-core.mjs; this is DOM wiring only.
// Manual-only behaviors (no jsdom layout / no HTML5 DnD): paintWires geometry,
// drag pills onto strips/cols, hover-loop link mode, read-only preview paint.
// SELF-LOOP NOTE: a SAME-NODE self-loop (fb.from===fb.to, e.g. the default's
// fb_refine s1_0->s1_0) is created/removed via the node's top-left self-cycle
// toggle (.selfloop), NOT the bottom-right link button — that one only draws edges
// to DISTINCT nodes (composerAddFeedback still rejects from===to). paintWires
// special-cases from===to to draw a small violet lobe beneath the node with NO
// delete-X (the toggle owns removal; cross-node amber loops keep their X). Manual
// checklist: Reset shows the Refine node with its self-cycle toggle lit (violet ring)
// and a violet self-loop arc beneath it; clicking the toggle removes both, clicking
// again restores them.
// ---------------------------------------------------------------------------
const COMPOSER_COLORS = { green: '#5BAE5B', peach: '#EFA63C', red: '#E76A5A', blue: '#5BA6CC', violet: '#8C7FD6', amber: '#E6962A' };
const COMPOSER_TINTS = { green: '#E2F3DF', peach: '#FCEEDA', red: '#FBE3E0', blue: '#DEEFF7', violet: '#EAE6F8', amber: '#FCE8C8' };
const COMPOSER_SEQ = '#B7B7BC';

let _composerReady = false;
const composer = {
  agents: {},          // key -> {key,displayName,description,color,icon}
  steps: [],           // Array<Array<{id,key}>> (local ids)
  feedbacks: [],       // Array<{from,to}> (local ids)
  saved: [],           // WorkflowTemplate[] from the server
  linkFrom: null,
  dragKey: null,
  uid: 1,
  els: {},
};
const composerMk = (key) => ({ id: 'n' + composer.uid++, key });
const composerAgent = (key) => composer.agents[key] || { displayName: key, description: '', color: 'blue', icon: '' };

// Test hook: expose the composer state + the mutators the jsdom tests drive
// directly (mirrors the window.__np convention). composerRefresh/composerAddFeedback
// are hoisted function declarations, so they are bound by reference here.
if (typeof window !== 'undefined') {
  window.__composer = composer;
  window.__composerRefresh = composerRefresh;
  window.__composerAddFeedback = composerAddFeedback;
}

async function initComposer() {
  if (_composerReady) { composerDrawWires(); return; }
  _composerReady = true;
  composer.els = {
    flow: document.getElementById('composer-flow'),
    wires: document.getElementById('composer-wires'),
    palette: document.getElementById('composer-palette'),
    banner: document.getElementById('composer-link-banner'),
    linkText: document.getElementById('composer-link-text'),
    list: document.getElementById('composer-saved-list'),
    count: document.getElementById('composer-saved-count'),
  };
  if (!composer.els.flow) return;

  // toolbar + global listeners (bound once)
  document.getElementById('composer-reset').addEventListener('click', () => { composerExitLink(); composerReset(); });
  document.getElementById('composer-clear').addEventListener('click', () => { composerExitLink(); composer.steps = []; composer.feedbacks = []; composerRefresh(); });
  document.getElementById('composer-save').addEventListener('click', composerSave);
  document.getElementById('composer-link-cancel').addEventListener('click', composerExitLink);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') composerExitLink(); });
  composer.els.wires.addEventListener('click', (e) => {
    const g = e.target.closest('.fb-del'); if (!g) return;
    composer.feedbacks.splice(+g.dataset.fb, 1); composerRefresh();
  });
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(composerDrawWires, 80); });
  if (window.ResizeObserver) new window.ResizeObserver(() => composerDrawWires()).observe(composer.els.flow);

  // palette from the registry (or embedded fallback)
  const agentsRes = await fetchAgents();
  const pal = mergePalette(agentsRes);
  composer.agents = {};
  pal.forEach((a) => { composer.agents[a.key] = a; });
  composerBuildPalette(pal);

  // initial canvas = the saved default workflow (4-step)
  await composerReset();
  await composerLoadSaved();
}

/* ---- palette ---- */
function composerBuildPalette(pal) {
  const palette = composer.els.palette;
  palette.innerHTML = '';
  pal.forEach((ag) => {
    const p = document.createElement('div');
    p.className = 'agent-pill';
    p.draggable = true;
    p.dataset.key = ag.key;
    p.innerHTML = `<span class="pdotc" style="background:${COMPOSER_COLORS[ag.color] || '#ccc'}"></span>${ag.displayName}`;
    p.addEventListener('dragstart', (e) => {
      composer.dragKey = ag.key; p.classList.add('dragging');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', ag.key); }
    });
    p.addEventListener('dragend', () => {
      composer.dragKey = null; p.classList.remove('dragging');
      document.querySelectorAll('.over').forEach((x) => x.classList.remove('over'));
    });
    palette.appendChild(p);
  });
}

/* ---- node ---- */
function composerNodeEl(a) {
  const ag = composerAgent(a.key);
  const selfOn = composer.feedbacks.some((f) => f.from === a.id && f.to === a.id);
  const d = document.createElement('div');
  d.className = 'node'; d.dataset.id = a.id; d.style.setProperty('--c', COMPOSER_COLORS[ag.color] || '#ccc');
  d.innerHTML =
    `<div class="selfloop${selfOn ? ' on' : ''}" title="${selfOn ? 'Remove self-cycle' : 'Self-cycle — re-run this step on blocking issues'}" aria-pressed="${selfOn}">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 3v5h5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 21v-5h-5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>` +
    `<div class="nic" style="background:${COMPOSER_TINTS[ag.color] || '#eee'};color:${COMPOSER_COLORS[ag.color] || '#888'}">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">${ag.icon}</svg></div>` +
    `<div class="nmeta"><b>${ag.displayName}</b><small>${ag.description}</small></div>` +
    `<div class="nx" title="Remove agent">✕</div>` +
    `<div class="loop" title="Draw a feedback loop from this agent">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 9a5 5 0 0 1 5-5h9" stroke-linecap="round"/><path d="M14 1l3 3-3 3" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 15a5 5 0 0 1-5 5H7" stroke-linecap="round"/><path d="M10 23l-3-3 3-3" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;
  d.querySelector('.selfloop').addEventListener('click', (e) => { e.stopPropagation(); composerToggleSelf(a.id); });
  d.querySelector('.nx').addEventListener('click', (e) => { e.stopPropagation(); composerRemoveNode(a.id); });
  d.querySelector('.loop').addEventListener('click', (e) => { e.stopPropagation(); composerToggleLink(a.id); });
  d.addEventListener('click', () => { if (composer.linkFrom && composer.linkFrom !== a.id) { composerAddFeedback(composer.linkFrom, a.id); composerExitLink(); } });
  return d;
}

/* ---- drop helpers ---- */
function composerAllow(e) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; }
// Transient governance message: reuse the link-banner els (link mode is mutually
// exclusive with dragging). Falls back to console when no banner is mounted (jsdom).
function composerToast(msg) {
  const banner = composer.els.banner, text = composer.els.linkText;
  if (banner && text) { text.textContent = msg; banner.hidden = false; setTimeout(() => { banner.hidden = true; }, 2200); }
  else if (typeof console !== 'undefined') console.warn('[composer]', msg); // jsdom/no-banner fallback
}
function composerMakeStrip(index, full) {
  const s = document.createElement('div');
  s.className = 'strip' + (full ? ' full' : '');
  s.addEventListener('dragover', (e) => { composerAllow(e); s.classList.add('over'); });
  s.addEventListener('dragleave', () => s.classList.remove('over'));
  s.addEventListener('drop', (e) => {
    e.preventDefault(); s.classList.remove('over');
    if (!composer.dragKey) return;
    const key = composer.dragKey;
    const prev = composer.steps[index - 1] || [];
    const next = composer.steps[index] || [];
    const badPrev = prev.find((n) => !canConnect(n.key, key, composer.agents).ok);
    const badNext = next.find((n) => !canConnect(key, n.key, composer.agents).ok);
    if (badPrev) { composerToast(canConnect(badPrev.key, key, composer.agents).reason); composer.dragKey = null; return; }
    if (badNext) { composerToast(canConnect(key, badNext.key, composer.agents).reason); composer.dragKey = null; return; }
    composer.steps.splice(index, 0, [composerMk(key)]); composer.dragKey = null; composerRefresh();
  });
  return s;
}
function composerMakeCol(stepIdx) {
  const col = document.createElement('div');
  col.className = 'col';
  const tag = document.createElement('div'); tag.className = 'col-tag';
  tag.innerHTML = `Step ${stepIdx + 1}` + (composer.steps[stepIdx].length > 1 ? ' · <em>parallel</em>' : '');
  col.appendChild(tag);
  composer.steps[stepIdx].forEach((a) => col.appendChild(composerNodeEl(a)));
  const hint = document.createElement('div'); hint.className = 'par-hint'; hint.textContent = '+ run in parallel';
  col.appendChild(hint);
  col.addEventListener('dragover', (e) => { composerAllow(e); col.classList.add('over'); });
  col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); });
  col.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation(); col.classList.remove('over');
    if (!composer.dragKey) return;
    const key = composer.dragKey;
    const prev = composer.steps[stepIdx - 1] || [];
    const next = composer.steps[stepIdx + 1] || [];
    const badPrev = prev.find((n) => !canConnect(n.key, key, composer.agents).ok);
    const badNext = next.find((n) => !canConnect(key, n.key, composer.agents).ok);
    if (badPrev || badNext) {
      const v = badPrev ? canConnect(badPrev.key, key, composer.agents) : canConnect(key, badNext.key, composer.agents);
      composerToast(v.reason); composer.dragKey = null; return;
    }
    composer.steps[stepIdx].push(composerMk(key)); composer.dragKey = null; composerRefresh();
  });
  return col;
}

/* ---- render ---- */
function composerRefresh() {
  const flow = composer.els.flow;
  [...flow.querySelectorAll(':scope > .strip, :scope > .col, :scope > .empty-flow')].forEach((e) => e.remove());
  if (composer.steps.length === 0) {
    flow.appendChild(composerMakeStrip(0, true));
    const empty = document.createElement('div'); empty.className = 'empty-flow';
    empty.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 12h14M12 5v14" stroke-linecap="round"/></svg>' +
      'Drag an agent here to begin<small>Place agents left-to-right for sequence · stack them for parallel steps</small>';
    flow.appendChild(empty);
  } else {
    for (let i = 0; i < composer.steps.length; i++) { flow.appendChild(composerMakeStrip(i)); flow.appendChild(composerMakeCol(i)); }
    flow.appendChild(composerMakeStrip(composer.steps.length));
  }
  const hint = document.getElementById('composer-decomposer-hint');
  if (hint) {
    const hasDecomposer = composer.steps.some((col) => col.some((n) => n.key === 'decomposer'));
    hint.hidden = !hasDecomposer;
  }
  requestAnimationFrame(composerDrawWires);
}

/* ---- mutations ---- */
function composerRemoveNode(id) {
  for (let i = 0; i < composer.steps.length; i++) {
    const j = composer.steps[i].findIndex((a) => a.id === id);
    if (j >= 0) { composer.steps[i].splice(j, 1); if (composer.steps[i].length === 0) composer.steps.splice(i, 1); break; }
  }
  composer.feedbacks = composer.feedbacks.filter((f) => f.from !== id && f.to !== id);
  if (composer.linkFrom === id) composerExitLink();
  composerRefresh();
}
function composerAddFeedback(from, to) {
  if (from === to) return;
  const flat = composer.steps.flat();
  const fromKey = flat.find((n) => n.id === from)?.key;
  const toKey = flat.find((n) => n.id === to)?.key;
  const verdict = canConnect(fromKey, toKey, composer.agents);
  if (!verdict.ok) { composerToast(verdict.reason); return; }
  if (!composer.feedbacks.some((f) => f.from === from && f.to === to)) composer.feedbacks.push({ from, to });
  composerRefresh();
}
// Self-cycle toggle: add/remove a SAME-NODE feedback (from===to). The composer's
// link button rejects from===to, so this is the only way to set a self-loop. It
// re-runs the step on its own blocking issues (the default's fb_refine).
function composerToggleSelf(id) {
  const node = composer.steps.flat().find((n) => n.id === id);
  const key = node?.key;
  const verdict = canConnect(key, key, composer.agents);
  if (!verdict.ok) { composerToast(`${(composer.agents[key]?.displayName) || key} can’t loop to itself`); return; }
  const i = composer.feedbacks.findIndex((f) => f.from === id && f.to === id);
  if (i >= 0) composer.feedbacks.splice(i, 1);
  else composer.feedbacks.push({ from: id, to: id });
  composerRefresh();
}

/* ---- feedback linking mode ---- */
function composerToggleLink(id) { if (composer.linkFrom === id) composerExitLink(); else composerEnterLink(id); }
function composerEnterLink(id) {
  composer.linkFrom = id;
  composer.els.banner.hidden = false;
  const a = composer.steps.flat().find((n) => n.id === id);
  composer.els.linkText.textContent = `Loop from "${composerAgent(a.key).displayName}" → click a target agent`;
  composer.els.flow.querySelectorAll('.node').forEach((n) => {
    n.classList.toggle('linking', n.dataset.id === id);
    n.classList.toggle('link-target', n.dataset.id !== id);
  });
}
function composerExitLink() {
  composer.linkFrom = null;
  if (composer.els.banner) composer.els.banner.hidden = true;
  if (composer.els.flow) composer.els.flow.querySelectorAll('.node').forEach((n) => n.classList.remove('linking', 'link-target'));
}

/* ---- wires (shared renderer; ns-namespaced markers) ---- */
function composerPaintWires(flowEl, wiresEl, steps, feedbacks, opts) {
  opts = opts || {};
  const ns = opts.ns || 'main';
  if (flowEl.offsetParent === null) return; // view hidden — skip
  // Canonical loop-count rule (Phase D applies this when BUILDING opts.cycles;
  // the renderer itself reads the finished count from opts.cycles[fb.from]).
  const loopCount = (fb, nodeCycle) => Math.max(0, (nodeCycle[fb.from] || 1) - 1);
  const loopBadge = (cx, cy, color, n) =>
    `<g class="loop-badge"><title>${n} cycle${n === 1 ? '' : 's'}</title>` +
    `<circle cx="${cx}" cy="${cy}" r="11.5" fill="${color}" stroke="${color}" stroke-width="1.6"/>` +
    `<text x="${cx}" y="${cy + 0.5}" text-anchor="middle" dominant-baseline="central" ` +
    `font-size="11.5" font-weight="700" fill="#fff">${n}×</text></g>`;
  const rect = (id) => {
    const el = flowEl.querySelector(`.node[data-id="${id}"]`); if (!el) return null;
    const fr = flowEl.getBoundingClientRect(), r = el.getBoundingClientRect();
    return { x: r.left - fr.left, y: r.top - fr.top, w: r.width, h: r.height };
  };
  const W = flowEl.scrollWidth, H = flowEl.scrollHeight;
  wiresEl.setAttribute('width', W); wiresEl.setAttribute('height', H);
  wiresEl.style.width = W + 'px'; wiresEl.style.height = H + 'px';
  let s = `<defs>` +
    `<marker id="arrSeq-${ns}" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0 0L9 4.5L0 9z" fill="${COMPOSER_SEQ}"/></marker>` +
    `<marker id="arrSeqDone-${ns}" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0 0L9 4.5L0 9z" fill="${COMPOSER_COLORS.green}"/></marker>` +
    `<marker id="arrFb-${ns}" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0 0L9 4.5L0 9z" fill="${COMPOSER_COLORS.amber}"/></marker>` +
    `<marker id="arrSelf-${ns}" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0 0L9 4.5L0 9z" fill="${COMPOSER_COLORS.violet}"/></marker></defs>`;
  for (let i = 0; i < steps.length - 1; i++) {
    steps[i].forEach((a) => {
      steps[i + 1].forEach((b) => {
        const ra = rect(a.id), rb = rect(b.id); if (!ra || !rb) return;
        const x1 = ra.x + ra.w, y1 = ra.y + ra.h / 2, x2 = rb.x, y2 = rb.y + rb.h / 2;
        const dx = Math.max(36, (x2 - x1) * 0.5);
        const bothDone = opts.doneSet && opts.doneSet.has(a.id) && opts.doneSet.has(b.id);
        const seqStroke = bothDone ? COMPOSER_COLORS.green : COMPOSER_SEQ;
        const seqMk = bothDone ? `arrSeqDone-${ns}` : `arrSeq-${ns}`;
        s += `<path d="M${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}" fill="none" stroke="${seqStroke}" stroke-width="2" stroke-dasharray="6 7" marker-end="url(#${seqMk})"/>`;
      });
    });
  }
  const posOf = (id) => { for (const st of steps) { const i = st.findIndex((a) => a.id === id); if (i >= 0) return { len: st.length, i }; } return { len: 1, i: 0 }; };
  let maxBottom = 0;
  steps.flat().forEach((a) => { const r = rect(a.id); if (r) maxBottom = Math.max(maxBottom, r.y + r.h); });
  feedbacks.forEach((fb, idx) => {
    const ra = rect(fb.from), rb = rect(fb.to); if (!ra || !rb) return;
    if (fb.from === fb.to) {
      // same-node self-cycle: a BIG violet lobe hanging beneath the node so the
      // cycle badge reads clearly. No delete-X — the node's top-left self-cycle
      // toggle owns add/remove (composer); run/history pass cycles for the badge.
      const cx = ra.x + ra.w / 2, by = ra.y + ra.h, b = 40;
      const fbCls = opts.runMode ? (fb.from === opts.activeId ? ' class="wire-live"' : ' class="wire-dim"') : '';
      s += `<path d="M${cx - 26} ${by} C ${cx - 40} ${by + b}, ${cx + 40} ${by + b}, ${cx + 26} ${by}"${fbCls} fill="none" stroke="${COMPOSER_COLORS.violet}" stroke-width="2" stroke-dasharray="2 7" stroke-linecap="round" marker-end="url(#arrSelf-${ns})"/>`;
      if (opts.cycles && !opts.del) {
        const n = opts.cycles[fb.from] || 0;
        if (n >= 1) s += loopBadge(cx, by + b * 0.82, COMPOSER_COLORS.violet, n);
      }
      return;
    }
    const p = posOf(fb.from);
    const below = p.len > 1 && p.i === p.len - 1;
    let sx, sy, tx, ty, rail, mx, my;
    if (below) {
      sx = ra.x + ra.w / 2; sy = ra.y + ra.h; tx = rb.x + rb.w / 2; ty = rb.y + rb.h;
      rail = maxBottom + Math.max(46, Math.abs(sx - tx) * 0.12);
      my = rail - (rail - Math.max(sy, ty)) * 0.18;
    } else {
      sx = ra.x + ra.w / 2; sy = ra.y; tx = rb.x + rb.w / 2; ty = rb.y;
      rail = Math.min(sy, ty) - Math.max(46, Math.abs(sx - tx) * 0.16);
      my = rail + (Math.min(sy, ty) - rail) * 0.18;
    }
    mx = (sx + tx) / 2;
    const fbCls = opts.runMode ? (fb.from === opts.activeId ? ' class="wire-live"' : ' class="wire-dim"') : '';
    s += `<path d="M${sx} ${sy} C ${sx} ${rail}, ${tx} ${rail}, ${tx} ${ty}"${fbCls} fill="none" stroke="${COMPOSER_COLORS.amber}" stroke-width="2" stroke-dasharray="2 7" stroke-linecap="round" marker-end="url(#arrFb-${ns})"/>`;
    if (opts.del) {
      s += `<g class="fb-del" data-fb="${idx}" style="cursor:pointer;pointer-events:auto">` +
        `<circle cx="${mx}" cy="${my}" r="9.5" fill="#fff" stroke="${COMPOSER_COLORS.amber}" stroke-width="1.5"/>` +
        `<path d="M${mx - 3.2} ${my - 3.2}L${mx + 3.2} ${my + 3.2}M${mx + 3.2} ${my - 3.2}L${mx - 3.2} ${my + 3.2}" stroke="${COMPOSER_COLORS.amber}" stroke-width="1.7" stroke-linecap="round"/></g>`;
    } else if (opts.cycles) {
      const n = opts.cycles[fb.from] || 0;
      if (n >= 1) s += loopBadge(mx, my, COMPOSER_COLORS.amber, n);
    }
  });
  wiresEl.innerHTML = s;
}
function composerDrawWires() {
  if (!composer.els.flow) return;
  composerPaintWires(composer.els.flow, composer.els.wires, composer.steps, composer.feedbacks, { ns: 'main', del: true });
}

/* ---- toolbar actions (server-wired) ---- */
async function composerReset() {
  const tpl = await getWorkflow('wf_default');
  const model = defaultTopologyFromTemplate(tpl, composerMk);
  composer.steps = model.steps;
  composer.feedbacks = model.feedbacks;
  composerRefresh();
}
async function composerSave() {
  if (!composer.steps.length) return;
  composerExitLink();
  const name = (window.prompt('Name this pipeline:', '') || '').trim();
  if (!name) return;
  const body = topology(composer.steps, composer.feedbacks); // {steps,feedbacks} with contract ids
  const saveBtn = document.getElementById('composer-save');
  let saved;
  try {
    saved = await saveWorkflow({ name, steps: body.steps, feedbacks: body.feedbacks });
  } catch (e) {
    appendLog({ source: 'ui', level: 'error', text: `save pipeline: ${e.message}`, ts: Date.now() });
    return;
  }
  await composerLoadSaved();
  // The server list is [Default, ...saved] — Default is ALWAYS first, so do NOT blindly
  // expand the first .pl-item (v1 bug: it auto-expanded Default, not the new pipeline).
  // Expand the row we just saved — match by returned id, then by name; if neither
  // matches, expand nothing rather than the wrong Default preview.
  const items = [...composer.els.list.querySelectorAll('.pl-item')];
  const row = (saved && saved.id && items.find((el) => el.dataset.id === saved.id))
    || items.find((el) => (el.querySelector('.pl-name')?.textContent || '').trim() === name);
  if (row) row.querySelector('.pl-row').click();
  const html = saveBtn.innerHTML;
  saveBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg> Saved';
  saveBtn.style.background = 'var(--green-ink)';
  setTimeout(() => { saveBtn.innerHTML = html; saveBtn.style.background = ''; }, 1400);
}

async function composerLoadSaved() {
  composer.saved = await listWorkflows();
  composerRenderList();
}

function composerRoNode(a) {
  const ag = composerAgent(a.key);
  const d = document.createElement('div');
  d.className = 'node'; d.dataset.id = a.id; d.style.setProperty('--c', COMPOSER_COLORS[ag.color] || '#ccc');
  d.innerHTML =
    `<div class="nic" style="background:${COMPOSER_TINTS[ag.color] || '#eee'};color:${COMPOSER_COLORS[ag.color] || '#888'}">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">${ag.icon}</svg></div>` +
    `<div class="nmeta"><b>${ag.displayName}</b><small>${ag.description}</small></div>`;
  return d;
}

function composerRenderRO(host, item) {
  const tag = document.createElement('div'); tag.className = 'pl-readonly-tag';
  tag.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3" stroke-linecap="round"/></svg> Read-only preview';
  host.appendChild(tag);
  const scroll = document.createElement('div'); scroll.className = 'ro-scroll';
  const f = document.createElement('div'); f.className = 'flow ro-flow';
  const w = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); w.setAttribute('class', 'wires');
  f.appendChild(w);
  for (let i = 0; i < item.steps.length; i++) {
    f.appendChild(Object.assign(document.createElement('div'), { className: 'strip' }));
    const col = document.createElement('div'); col.className = 'col';
    const ct = document.createElement('div'); ct.className = 'col-tag';
    ct.innerHTML = `Step ${i + 1}` + (item.steps[i].length > 1 ? ' · <em>parallel</em>' : '');
    col.appendChild(ct);
    item.steps[i].forEach((a) => col.appendChild(composerRoNode(a)));
    f.appendChild(col);
  }
  f.appendChild(Object.assign(document.createElement('div'), { className: 'strip' }));
  scroll.appendChild(f); host.appendChild(scroll);
  const paint = () => composerPaintWires(f, w, item.steps, item.feedbacks, { ns: item.id });
  requestAnimationFrame(() => requestAnimationFrame(paint));
  setTimeout(paint, 60);
}

function composerRenderList() {
  const listEl = composer.els.list, cntEl = composer.els.count;
  listEl.innerHTML = '';
  cntEl.textContent = composer.saved.length + (composer.saved.length === 1 ? ' pipeline' : ' pipelines');
  if (!composer.saved.length) {
    listEl.innerHTML = '<div class="pl-empty">No saved pipelines yet — build one above and hit "Save pipeline".</div>';
    return;
  }
  composer.saved.forEach((item) => {
    const used = distinctAgents(item.steps);
    const chips = used.map((k) => {
      const ag = composerAgent(k);
      return `<span class="pl-chip"><span class="d" style="background:${COMPOSER_COLORS[ag.color] || '#ccc'}"></span>${ag.displayName}</span>`;
    }).join('');
    const meta = metaLine(item.steps, item.feedbacks).replace(
      / · (\d+ feedback loops?)$/, ' · <em>$1</em>',
    );
    const wrap = document.createElement('div'); wrap.className = 'pl-item'; wrap.dataset.id = item.id;
    const isDefault = item.id === 'wf_default';
    wrap.innerHTML =
      `<div class="pl-row">` +
        `<svg class="pl-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
        `<div class="pl-main">` +
          `<div class="pl-name">${item.name}</div>` +
          `<div class="pl-meta">${meta}</div>` +
          `<div class="pl-chips">${chips}</div>` +
        `</div>` +
        (isDefault ? '' : `<button type="button" class="pl-del" title="Delete pipeline"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`) +
      `</div>` +
      `<div class="pl-body"></div>`;
    listEl.appendChild(wrap);
    const row = wrap.querySelector('.pl-row');
    const del = wrap.querySelector('.pl-del');
    const body = wrap.querySelector('.pl-body');
    if (del) del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!window.confirm(`Delete "${item.name}"? This cannot be undone.`)) return;
      try { await deleteWorkflow(item.id); } catch (err) {
        appendLog({ source: 'ui', level: 'error', text: `delete pipeline: ${err.message}`, ts: Date.now() }); return;
      }
      await composerLoadSaved();
    });
    row.addEventListener('click', () => {
      const open = wrap.classList.toggle('open');
      if (open) {
        if (!body.dataset.rendered) { composerRenderRO(body, item); body.dataset.rendered = '1'; }
        else {
          const f = body.querySelector('.ro-flow'), w = body.querySelector('.wires');
          if (f && w) requestAnimationFrame(() => composerPaintWires(f, w, item.steps, item.feedbacks, { ns: item.id }));
        }
      }
    });
  });
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

// ---------------------------------------------------------------------------
// New-Pipeline workflow config: PURE helpers (no DOM, no fetch). These flatten a
// workflow's topology + the per-project run-config into row data the renderers
// paint. Exposed on window.__np so jsdom unit tests can exercise them directly.
// ---------------------------------------------------------------------------

// Flatten workflow.steps[][] into an ordered list of node rows, joining each
// node's role `key` to its registry metadata (label/color) and overlaying the
// run-config's saved {model,effort} for that node-instance id. Order = outer
// (sequential) then inner (parallel) — exactly the dispatch order.
function buildNodeConfigRows(workflow, registry, runConfig) {
  const steps = Array.isArray(workflow && workflow.steps) ? workflow.steps : [];
  const reg = registry || {};
  const nodes = (runConfig && runConfig.nodes) || {};
  const rows = [];
  steps.forEach((group, stepIndex) => {
    const members = Array.isArray(group) ? group : [];
    members.forEach((node) => {
      if (!node || !node.id) return;
      const meta = reg[node.key] || null;
      const saved = nodes[node.id] || {};
      const metaFan = meta && typeof meta.fanOut === 'boolean' ? meta.fanOut : false;
      rows.push({
        nodeId: node.id,
        key: node.key,
        label: (meta && meta.displayName) || node.key || node.id,
        color: (meta && meta.color) || '',
        stepIndex,
        parallel: members.length > 1,
        model: typeof saved.model === 'string' ? saved.model : '',
        effort: typeof saved.effort === 'string' ? saved.effort : '',
        fanOut: typeof saved.fanOut === 'boolean' ? saved.fanOut : metaFan,
      });
    });
  });
  return rows;
}

// Flatten workflow.feedbacks into row data for the per-loop cycle-count inputs,
// overlaying the run-config's saved maxCycles (default 3 when unset). Resolves each
// loop's endpoints (node ids like "s2_0") to human agent names via the registry +
// workflow.steps, and precomputes the directional `label`:
//   - normal loop:  "<toName> ← <fromName>"   (feedback points to <- from)
//   - self loop:    "<name> ↺ (self loop)"    (from === to)
// A "(step N)" suffix (1-based) disambiguates an endpoint whose display name is shared
// by more than one node in the workflow. Unknown ids fall back to the raw id.
function buildFeedbackRows(workflow, registry, runConfig) {
  const steps = Array.isArray(workflow && workflow.steps) ? workflow.steps : [];
  const fbs = Array.isArray(workflow && workflow.feedbacks) ? workflow.feedbacks : [];
  const reg = registry || {};
  const saved = (runConfig && runConfig.feedbacks) || {};

  // node id -> { name, step } (1-based) + a display-name frequency map so the
  // "(step N)" suffix is added only when a name is non-unique.
  const byId = new Map();
  const nameCount = new Map();
  steps.forEach((group, stepIndex) => {
    (Array.isArray(group) ? group : []).forEach((node) => {
      if (!node || !node.id) return;
      const meta = reg[node.key] || null;
      const name = (meta && meta.displayName) || node.key || node.id; // mirror buildNodeConfigRows
      byId.set(node.id, { name, step: stepIndex + 1 });
      nameCount.set(name, (nameCount.get(name) || 0) + 1);
    });
  });

  // Endpoint label: display name, disambiguated with "(step N)" when that name is
  // shared by >1 node. Ids absent from steps fall back to the raw id (never blank).
  const labelFor = (nodeId) => {
    const info = byId.get(nodeId);
    if (!info) return nodeId;
    return (nameCount.get(info.name) || 0) > 1 ? `${info.name} (step ${info.step})` : info.name;
  };

  return fbs.map((fb) => {
    const rc = saved[fb.id] || {};
    const n = Number(rc.maxCycles);
    const fromLabel = labelFor(fb.from);
    const toLabel = labelFor(fb.to);
    const selfLoop = fb.from === fb.to;
    const label = selfLoop ? `${toLabel} ↺ (self loop)` : `${toLabel} ← ${fromLabel}`;
    return {
      fbId: fb.id,
      from: fb.from,
      to: fb.to,
      fromLabel,
      toLabel,
      selfLoop,
      label,
      maxCycles: Number.isFinite(n) && n >= 1 ? n : 3,
    };
  });
}

// First effort a model supports (used to seed a node's effort caption when none
// is saved). '' when the model is unknown or advertises no efforts.
function defaultEffortFor(modelId) {
  const m = modelById(modelId);
  return m && Array.isArray(m.efforts) && m.efforts.length ? m.efforts[0] : '';
}

// Test hook: expose the pure helpers (and a couple of collaborators the tests
// reuse) without leaking them into the app's runtime contract.
if (typeof window !== 'undefined') {
  window.__np = Object.assign(window.__np || {}, {
    composer, composerRefresh,
    buildNodeConfigRows,
    buildFeedbackRows,
    defaultEffortFor,
    renderModelEffortPair,
    renderNodeRows,
    renderWorkflowConfig,
    _setModels: (m) => { state.models = Array.isArray(m) ? m : []; },
    manifestFor,
    manifestSig,
    makeRun,
    onSubagent,
    onState,
    getRun: (id) => runs.get(id),
    durByNode,
    costByNode,
    subsByNode,
    subsByNodeArrays,
    subsByNodeCycleArrays,
    cyclesPerNode,
    cycleAwareLabel,
    subAgentsOf,
    findManifestNode,
    subAgentsForNode,
    composerPaintWires,
    buildRunGraph,
    runNode,
    nodeModelLine,
    loopCounts,
    paintRunGraph,
    histNodeCycle,
    renderHistClarifyReviews,
    subFanHtml,
    subsPillText,
    paintSubsBar,
    assetRollup,
    assetsPillText,
    paintAssetsPanel,
    subGroupStatus,
    renderSubsTree,
    nodeLabelLookup,
  });
}

// Paint one model+effort select pair (and its caption) from a saved selection
// {model,effort}. Shared by the legacy default-stage rows and the dynamic
// per-node rows so the dropdown contents + effort filtering live in one place.
function renderModelEffortPair(modelSel, effortSel, caption, sel = {}) {
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

  modelSel.disabled = false;
  effortSel.disabled = !model; // no model picked => effort is meaningless

  if (caption) {
    const mLabel = model ? model.label : 'default model';
    caption.textContent = `${mLabel} · ${effortSel.value || 'default effort'}`;
  }
}

function renderStepConfigs() {
  // The Default workflow's four rows are keyed by data-role; paint each from the
  // legacy per-role config (state.config.steps). Config always edits the NEXT
  // run, so selectors are never locked.
  for (const role of STEP_ROLES) {
    const modelSel = document.querySelector(`.step-model[data-role="${role}"]`);
    const effortSel = document.querySelector(`.step-effort[data-role="${role}"]`);
    const caption = document.querySelector(`.step-current[data-role="${role}"]`);
    if (!modelSel || !effortSel) continue;
    renderModelEffortPair(modelSel, effortSel, caption, state.config.steps[role] || {});
    const fanCb = document.querySelector(`.step-fanout[data-role="${role}"]`);
    if (fanCb) {
      const savedFan = (state.config.steps[role] || {}).fanOut;
      const defFan = (state.stepDefaults[role] || {}).fanOut || false;
      fanCb.checked = typeof savedFan === 'boolean' ? savedFan : defFan;
    }
  }
}

// ---------------------------------------------------------------------------
// New-Pipeline workflow selector. Populates #workflowSelect from
// GET /api/workflows; on change, renders per-node model/effort pickers + per-
// feedback cycle inputs for the chosen workflow (or the legacy default stages).
// ---------------------------------------------------------------------------

// --- API wrappers (existing fetch()/safeJson style) ---
async function listWorkflowsApi() {
  try {
    const res = await fetch('/api/workflows');
    const data = await safeJson(res);
    return res.ok && Array.isArray(data.workflows) ? data.workflows : [];
  } catch { return []; }
}

async function getWorkflowApi(id) {
  if (state.workflowCache[id]) return state.workflowCache[id];
  try {
    const res = await fetch(`/api/workflows/${encodeURIComponent(id)}`);
    const data = await safeJson(res);
    if (!res.ok || !data || !Array.isArray(data.steps)) return null;
    state.workflowCache[id] = data;
    return data;
  } catch { return null; }
}

async function getAgentsApi() {
  if (Object.keys(state.agents).length) return state.agents;
  try {
    const res = await fetch('/api/agents');
    const data = await safeJson(res);
    const list = res.ok && Array.isArray(data.agents) ? data.agents : [];
    state.agents = Object.fromEntries(list.map((a) => [a.key, a]));
    return state.agents;
  } catch { return state.agents; }
}

// Fill #workflowSelect with Default + saved names, preserving/falling back to
// the active selection (state.workflowId), then render that workflow's config.
async function loadWorkflowsInto(selectId) {
  const sel = el.workflowSelect;
  if (!sel) return;
  const workflows = await listWorkflowsApi();
  const list = workflows.length ? workflows : [{ id: 'wf_default', name: 'Default' }];
  const want = selectId || state.workflowId || 'wf_default';
  sel.innerHTML = '';
  list.forEach((wf) => sel.appendChild(option(wf.id, wf.name || wf.id)));
  // Fall back to default if the wanted id is gone (e.g. a deleted workflow).
  state.workflowId = list.some((wf) => wf.id === want) ? want : 'wf_default';
  sel.value = state.workflowId;
  await renderWorkflowConfig(state.workflowId);
}

// Render the config UI for one workflow. Default -> show the legacy 4 stage rows
// and hide the dynamic containers. Saved -> fetch topology + registry, render a
// node row per node and a cycle input per feedback.
async function renderWorkflowConfig(workflowId) {
  const isDefault = !workflowId || workflowId === 'wf_default';
  if (el.wfDefaultStages) el.wfDefaultStages.classList.toggle('hidden', !isDefault);
  if (el.wfNodeConfig) el.wfNodeConfig.classList.toggle('hidden', isDefault);
  if (el.wfFeedbackConfig) el.wfFeedbackConfig.classList.toggle('hidden', isDefault);

  if (isDefault) {
    if (el.wfNodeConfig) el.wfNodeConfig.innerHTML = '';
    if (el.wfFeedbackConfig) el.wfFeedbackConfig.innerHTML = '';
    renderStepConfigs(); // legacy per-role rows
    return;
  }

  const [wf, registry] = await Promise.all([getWorkflowApi(workflowId), getAgentsApi()]);
  if (!wf) {
    if (el.wfNodeConfig) el.wfNodeConfig.innerHTML = '<div class="hint">Could not load this workflow.</div>';
    if (el.wfFeedbackConfig) el.wfFeedbackConfig.innerHTML = '';
    return;
  }
  const runConfig = (state.config.workflows && state.config.workflows[workflowId]) || { nodes: {}, feedbacks: {} };
  renderNodeRows(buildNodeConfigRows(wf, registry, runConfig));
  renderFeedbackRows(buildFeedbackRows(wf, registry, runConfig));
}

// Build one .stage-cfg row per node into #wf-node-config, keyed by data-node-id.
// Mirrors the legacy markup (acc bar + meta + picks + caption) so it reuses the
// existing .stage-cfg styles and renderModelEffortPair.
function renderNodeRows(rows) {
  const host = el.wfNodeConfig;
  if (!host) return;
  host.innerHTML = '';
  rows.forEach((row) => {
    const card = document.createElement('div');
    card.className = 'stage-cfg';

    const acc = document.createElement('div');
    acc.className = 'acc' + (row.color ? ' ' + row.color : '');
    card.appendChild(acc);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const b = document.createElement('b');
    b.textContent = row.label;
    const small = document.createElement('small');
    small.textContent = row.parallel ? `Step ${row.stepIndex + 1} · parallel` : `Step ${row.stepIndex + 1}`;
    meta.append(b, small);
    card.appendChild(meta);

    const picks = document.createElement('div');
    picks.className = 'picks';
    const mWrap = document.createElement('div');
    mWrap.className = 'select-wrap';
    const modelSel = document.createElement('select');
    modelSel.className = 'step-model select';
    modelSel.dataset.nodeId = row.nodeId;
    modelSel.setAttribute('aria-label', `${row.label} model`);
    mWrap.appendChild(modelSel);
    const eWrap = document.createElement('div');
    eWrap.className = 'select-wrap';
    const effortSel = document.createElement('select');
    effortSel.className = 'step-effort select';
    effortSel.dataset.nodeId = row.nodeId;
    effortSel.setAttribute('aria-label', `${row.label} effort`);
    eWrap.appendChild(effortSel);
    const fanWrap = document.createElement('label');
    fanWrap.className = 'fanout-toggle';
    const fanCb = document.createElement('input');
    fanCb.type = 'checkbox';
    fanCb.className = 'step-fanout';
    fanCb.dataset.nodeId = row.nodeId;
    fanCb.checked = !!row.fanOut;
    const fanTxt = document.createElement('span');
    fanTxt.textContent = 'Fan-out';
    fanWrap.append(fanCb, fanTxt);
    picks.append(mWrap, eWrap, fanWrap);
    card.appendChild(picks);

    const caption = document.createElement('small');
    caption.className = 'step-current';
    caption.dataset.nodeId = row.nodeId;
    card.appendChild(caption);

    renderModelEffortPair(modelSel, effortSel, caption, { model: row.model, effort: row.effort });
    host.appendChild(card);
  });
}

// Build one cycle-count input per feedback into #wf-feedback-config, keyed by
// data-fb-id. Shows the loop's direction (to <- from) as a label.
function renderFeedbackRows(rows) {
  const host = el.wfFeedbackConfig;
  if (!host) return;
  host.innerHTML = '';
  if (!rows.length) return;

  const h = document.createElement('div');
  h.className = 'hint';
  h.style.margin = '10px 0 6px';
  h.textContent = 'Feedback loops — max cycles before gating to you.';
  host.appendChild(h);

  rows.forEach((row) => {
    const field = document.createElement('div');
    field.className = 'field';
    field.style.marginBottom = '10px';

    const label = document.createElement('label');
    label.textContent = `${row.label} — max cycles`;
    label.setAttribute('for', `fb-${row.fbId}`);
    field.appendChild(label);

    const input = document.createElement('input');
    input.id = `fb-${row.fbId}`;
    input.className = 'input';
    input.type = 'number';
    input.min = '1';
    input.value = String(row.maxCycles);
    input.dataset.fbId = row.fbId;
    field.appendChild(input);

    host.appendChild(field);
  });
}

// Workflow change: remember the selection and re-render its config.
if (el.workflowSelect) {
  el.workflowSelect.addEventListener('change', async () => {
    state.workflowId = el.workflowSelect.value || 'wf_default';
    saveActiveWorkflow(state.workflowId);
    await renderWorkflowConfig(state.workflowId);
  });
}

async function saveStep(role, model, effort, fanOut) {
  const projectDir = selectedProjectPath();
  if (!projectDir) return;
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, step: role, model, effort, fanOut }),
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

// Persist one node's model/effort to the per-project run-config for the active
// workflow (CONV-2): PATCH /api/config { projectDir, workflowId, nodes:{ [nodeId]:{model,effort} } }.
async function saveNode(workflowId, nodeId, model, effort, fanOut) {
  const projectDir = selectedProjectPath();
  if (!projectDir) return;
  try {
    const res = await fetch('/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, workflowId, nodes: { [nodeId]: { model, effort, fanOut } } }),
    });
    const data = await safeJson(res);
    if (!res.ok) {
      appendLog({ source: 'ui', level: 'error', text: `config: ${data.error || res.status}`, ts: Date.now() });
      return;
    }
    if (data.config) state.config = data.config;
  } catch (e) {
    appendLog({ source: 'ui', level: 'error', text: `config error: ${e.message}`, ts: Date.now() });
  }
}

// Persist one feedback loop's cycle count (CONV-2): PATCH /api/config
// { projectDir, workflowId, feedbacks:{ [fbId]:{maxCycles} } }.
async function saveFeedback(workflowId, fbId, maxCycles) {
  const projectDir = selectedProjectPath();
  if (!projectDir) return;
  try {
    const res = await fetch('/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, workflowId, feedbacks: { [fbId]: { maxCycles } } }),
    });
    const data = await safeJson(res);
    if (!res.ok) {
      appendLog({ source: 'ui', level: 'error', text: `config: ${data.error || res.status}`, ts: Date.now() });
      return;
    }
    if (data.config) state.config = data.config;
  } catch (e) {
    appendLog({ source: 'ui', level: 'error', text: `config error: ${e.message}`, ts: Date.now() });
  }
}

// Persist the active workflow selection (CONV-2): PATCH /api/config { projectDir, activeWorkflowId }.
async function saveActiveWorkflow(workflowId) {
  const projectDir = selectedProjectPath();
  if (!projectDir) return;
  try {
    const res = await fetch('/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, activeWorkflowId: workflowId }),
    });
    const data = await safeJson(res);
    if (res.ok && data.config) state.config = data.config;
  } catch {
    /* selection is best-effort; ignore transient errors */
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

// Delegated change handler for all config controls inside #pipeline-config:
//  - legacy default-stage selects carry data-role (persist via saveStep);
//  - dynamic node selects carry data-node-id (persist via saveNode);
//  - feedback cycle inputs carry data-fb-id (persist via saveFeedback).
el.pipelineConfig.addEventListener('change', (e) => {
  const t = e.target;

  // Feedback cycle inputs (number inputs, not selects).
  if (t instanceof HTMLInputElement && t.dataset.fbId) {
    const n = Math.max(1, Math.round(Number(t.value) || 1));
    t.value = String(n); // normalize the field
    saveFeedback(state.workflowId, t.dataset.fbId, n);
    return;
  }

  // Fan-out toggles (checkboxes). Send the row's current model/effort alongside
  // fanOut so the replace-on-model/effort setters don't wipe them.
  if (t instanceof HTMLInputElement && t.type === 'checkbox' && t.classList.contains('step-fanout')) {
    const fanOut = !!t.checked;
    if (t.dataset.nodeId) {
      const nodeId = t.dataset.nodeId;
      const modelSel = el.wfNodeConfig.querySelector(`.step-model[data-node-id="${nodeId}"]`);
      const effortSel = el.wfNodeConfig.querySelector(`.step-effort[data-node-id="${nodeId}"]`);
      saveNode(state.workflowId, nodeId, modelSel ? modelSel.value : '', effortSel ? effortSel.value : '', fanOut);
    } else if (t.dataset.role) {
      const cur = state.config.steps[t.dataset.role] || {};
      saveStep(t.dataset.role, cur.model || '', cur.effort || '', fanOut);
    }
    return;
  }

  if (!(t instanceof HTMLSelectElement)) return;

  // Dynamic per-node selects (saved workflow).
  if (t.dataset.nodeId) {
    const nodeId = t.dataset.nodeId;
    if (t.classList.contains('step-model')) {
      if (t.value === '__add__') return addModelFlowNode(nodeId);
      // New model -> reset effort + re-render this row's effort options.
      saveNode(state.workflowId, nodeId, t.value, '');
      const effortSel = el.wfNodeConfig.querySelector(`.step-effort[data-node-id="${nodeId}"]`);
      const caption = el.wfNodeConfig.querySelector(`.step-current[data-node-id="${nodeId}"]`);
      if (effortSel) renderModelEffortPair(t, effortSel, caption, { model: t.value, effort: '' });
    } else if (t.classList.contains('step-effort')) {
      const modelSel = el.wfNodeConfig.querySelector(`.step-model[data-node-id="${nodeId}"]`);
      const model = modelSel ? modelSel.value : '';
      saveNode(state.workflowId, nodeId, model, t.value);
      const caption = el.wfNodeConfig.querySelector(`.step-current[data-node-id="${nodeId}"]`);
      if (caption) {
        const m = modelById(model);
        caption.textContent = `${m ? m.label : 'default model'} · ${t.value || 'default effort'}`;
      }
    }
    return;
  }

  // Legacy default-stage selects (data-role).
  const role = t.dataset.role;
  if (!role) return;
  if (t.classList.contains('step-model')) {
    if (t.value === '__add__') return addModelFlow(role);
    saveStep(role, t.value, '');
  } else if (t.classList.contains('step-effort')) {
    const model = (state.config.steps[role] || {}).model || '';
    saveStep(role, model, t.value);
  }
});

// "+ Add model…" picked on a per-node select: add the custom model, then select
// it for that node (mirrors addModelFlow for the legacy role selects).
async function addModelFlowNode(nodeId) {
  const projectDir = selectedProjectPath();
  if (!projectDir) { renderWorkflowConfig(state.workflowId); return; }
  const id = (window.prompt('New model id (e.g. claude-opus-4-8 or a fine-tune id):') || '').trim();
  if (!id) { renderWorkflowConfig(state.workflowId); return; }
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
      renderWorkflowConfig(state.workflowId);
      return;
    }
    state.models = Array.isArray(data.models) ? data.models : state.models;
    await saveNode(state.workflowId, nodeId, id, ''); // select the new model (effort reset)
    renderWorkflowConfig(state.workflowId);           // repaint with the new model in the list
  } catch (e) {
    appendLog({ source: 'ui', level: 'error', text: `add model error: ${e.message}`, ts: Date.now() });
    renderWorkflowConfig(state.workflowId);
  }
}

// ---------------------------------------------------------------------------
// Log window
// ---------------------------------------------------------------------------
const MAX_LOG_LINES = 4000;

// Build one .log-line node from a normalized log record. (Same DOM shape the
// old global appendLog produced: ts/src/msg spans + lvl class.)
function buildLogLine({ source, level, text, ts, sub }) {
  const line = document.createElement('div');
  line.className = logLineClass(level, sub);

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
  const rec = { ts: msg.ts != null ? msg.ts : Date.now(), source: msg.source, level: msg.level, text, sub: !!msg.sub };
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
  return s === 'done' || s === 'error' || s === 'stopped' || s === 'aborted' || s === 'failed' || s === 'complete' || s === 'completed' || s === 'interrupted';
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

  // Card drops out of the live view (liveRuns excludes terminal statuses).
  renderRunningView();
  updateNavCounts();
  // History is machine-wide + decoupled from the project picker now; if the user
  // is looking at it, force-refetch so the just-finished pipeline surfaces with no
  // stale-cache flash (and re-triggers Phase-2 PR enrichment).
  if (currentView() === 'history') loadHistoryView({ force: true });

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
    loadConfig(path);        // (per-project history load removed — History is independent now)
    refreshBranches(path);
  } else {
    state.projectDir = '';
    // No project yet: still load the built-in models so the picker isn't empty.
    loadConfig('');
    refreshBranches('');
  }
}

// Seed any branch <select> with a single placeholder option. Empty value === "let
// the server default to current HEAD". Returns the option for in-place updates.
// We always seed one so the select is never blank (m3) and always communicates
// state — loading, the auto default, or an error (m2).
function seedBranchPlaceholder(select, text) {
  if (!select) return null;
  select.innerHTML = '';
  const opt = document.createElement('option');
  opt.value = '';
  opt.textContent = text;
  select.appendChild(opt);
  return opt;
}

// Populate any branch <select> from /api/branches for `projectDir`, pre-selecting
// the repo's current branch (HEAD). Empty value still falls back to HEAD on submit.
async function populateBranchSelect(select, projectDir) {
  if (!select) return;
  if (!projectDir) { seedBranchPlaceholder(select, 'current branch (auto)'); return; }
  const placeholder = seedBranchPlaceholder(select, 'Loading branches…');
  try {
    const r = await fetch(`/api/branches?projectDir=${encodeURIComponent(projectDir)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const branches = Array.isArray(data.branches) ? data.branches : [];
    if (!branches.length) { placeholder.textContent = 'current branch (auto)'; return; }
    // Rebuild: explicit "auto" first, then every branch (current pre-selected).
    seedBranchPlaceholder(select, 'current branch (auto)');
    for (const b of branches) {
      const opt = document.createElement('option');
      opt.value = b; opt.textContent = b;
      if (b === data.current) opt.selected = true;
      select.appendChild(opt);
    }
  } catch {
    // m2: surface the failure instead of leaving a silently-empty select. The
    // empty value still makes the server fall back to HEAD on submit.
    placeholder.textContent = 'current branch (auto — branch list unavailable)';
  }
}

// Back-compat shim for the single #sourceBranch (existing call sites in
// onProjectChanged are unchanged). setBranchPlaceholder is no longer needed
// (its callers move to seedBranchPlaceholder / are removed in setRunTarget).
function refreshBranches(projectDir) { return populateBranchSelect(el.sourceBranch, projectDir); }

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

// ===========================================================================
// WORKSPACES — target selector, management view, creation wizard, scan WS.
// All workspace paths are opt-in; project-mode behavior is byte-identical.
// ===========================================================================
const LAST_TARGET_KEY = 'maestro.runTarget';
const LAST_WORKSPACE_KEY = 'maestro.lastWorkspace';

const wsBasename = (p) => {
  if (!p) return '';
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
};

// ---- Target selector (New Pipeline) ----------------------------------------

// Toggle Project vs Workspace target. Persists the choice; in workspace mode
// lazy-loads options and re-points the config panel at the built-in models.
function setRunTarget(target) {
  const t = target === 'workspace' ? 'workspace' : 'project';
  state.runTarget = t;
  localStorage.setItem(LAST_TARGET_KEY, t);

  // Segmented buttons + hidden radios (source of truth read at submit).
  $$('#target-seg button[data-target]').forEach((b) => {
    const on = b.dataset.target === t;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const radio = (el.targetRadios || []).find((r) => r.value === t);
  if (radio) radio.checked = true;

  // Panes are mutually exclusive; only the visible pane's value is read at submit.
  if (el.targetProjectPane) el.targetProjectPane.classList.toggle('hidden', t !== 'project');
  if (el.targetWorkspacePane) el.targetWorkspacePane.classList.toggle('hidden', t !== 'workspace');

  // Source-branch field: in workspace mode swap the single dropdown for one
  // per-project dropdown each defaulting to that project's current branch (HEAD).
  if (t === 'workspace') {
    // Per-project source branches: hide the single dropdown, show one per member.
    if (el.sourceBranchWrap) el.sourceBranchWrap.classList.add('hidden');
    if (el.sourceBranchHint) el.sourceBranchHint.textContent = "Pick a source branch per project. Each defaults to that project's current branch.";
    // Config panel: no projectDir → built-in models/efforts; workflow picker still works.
    loadConfig('');
    ensureWorkspaceOptions();
  } else {
    // Restore the single project-driven dropdown; clear the per-project list.
    if (el.sourceBranchWrap) el.sourceBranchWrap.classList.remove('hidden');
    if (el.wsSourceBranches) { el.wsSourceBranches.classList.add('hidden'); el.wsSourceBranches.innerHTML = ''; }
    if (el.sourceBranchHint) el.sourceBranchHint.textContent = "The new worktree is created off this branch. Defaults to the project's current branch.";
    // Restore the project-driven branch list + config for the selected project.
    onProjectChanged();
  }
}

// Render the member chips for the currently-selected workspace.
function renderWorkspaceMembers() {
  const host = el.wsMembers;
  if (!host) return;
  host.innerHTML = '';
  const ws = state.workspaces.find((w) => w && w.id === state.selectedWorkspaceId);
  if (!ws || !Array.isArray(ws.projectPaths)) return;
  ws.projectPaths.forEach((p, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const missing = Array.isArray(ws.exists) && ws.exists[i] === false;
    if (missing) chip.classList.add('missing');
    chip.textContent = wsBasename(p) + (missing ? ' (missing)' : '');
    host.appendChild(chip);
  });
}

// Render one source-branch dropdown per member of the selected workspace, each
// keyed by projectKey and defaulted to that project's current branch (HEAD).
function renderWorkspaceSourceBranches() {
  const host = el.wsSourceBranches;
  if (!host) return;
  host.innerHTML = '';
  const ws = state.workspaces.find((w) => w && w.id === state.selectedWorkspaceId);
  if (!ws || !Array.isArray(ws.projectPaths) || !ws.projectPaths.length) {
    host.classList.add('hidden');
    return;
  }
  host.classList.remove('hidden');
  ws.projectPaths.forEach((p, i) => {
    const key = (Array.isArray(ws.projectKeys) && ws.projectKeys[i]) || '';
    const missing = Array.isArray(ws.exists) && ws.exists[i] === false;

    const row = document.createElement('div');
    row.className = 'ws-src-row';

    const name = document.createElement('span');
    name.className = 'ws-src-name';
    name.textContent = wsBasename(p) + (missing ? ' (missing)' : '');

    const wrap = document.createElement('div');
    wrap.className = 'select-wrap';
    const sel = document.createElement('select');
    sel.className = 'select ws-src-select';
    sel.dataset.projectKey = key;
    wrap.appendChild(sel);

    row.appendChild(name);
    row.appendChild(wrap);
    host.appendChild(row);

    if (missing) {
      sel.disabled = true;
      seedBranchPlaceholder(sel, 'current branch (auto)');
    } else {
      populateBranchSelect(sel, p); // async; defaults to HEAD per the clarification
    }
  });
}

// Populate #workspaceSelect from state.workspaces (loading them if empty).
// Workspaces with any missing member are rendered disabled "+ (incomplete)".
// Restores LAST_WORKSPACE_KEY when valid.
async function ensureWorkspaceOptions() {
  const sel = el.workspaceSelect;
  if (!sel) return;
  if (!state.workspaces.length) await loadWorkspaces();

  sel.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.disabled = true;
  placeholder.textContent = state.workspaces.length ? 'Select a workspace…' : 'No workspaces yet';
  sel.appendChild(placeholder);

  const want = state.selectedWorkspaceId || localStorage.getItem(LAST_WORKSPACE_KEY) || '';
  let restored = false;
  for (const w of state.workspaces) {
    if (!w || !w.id) continue;
    const incomplete = Array.isArray(w.exists) && w.exists.some((e) => !e);
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.dataset.name = w.name || '';
    opt.textContent = (w.name || w.id) + (incomplete ? ' (incomplete)' : '');
    if (incomplete) opt.disabled = true;
    sel.appendChild(opt);
    if (!incomplete && w.id === want) { opt.selected = true; restored = true; }
  }
  if (restored) {
    state.selectedWorkspaceId = want;
    localStorage.setItem(LAST_WORKSPACE_KEY, want);
  } else {
    state.selectedWorkspaceId = '';
    placeholder.selected = true;
  }
  renderWorkspaceMembers();
  renderWorkspaceSourceBranches();
}

if (el.targetSeg) {
  $$('#target-seg button[data-target]').forEach((btn) => {
    btn.addEventListener('click', () => setRunTarget(btn.dataset.target));
  });
}
if (el.workspaceSelect) {
  el.workspaceSelect.addEventListener('change', () => {
    state.selectedWorkspaceId = el.workspaceSelect.value || '';
    if (state.selectedWorkspaceId) localStorage.setItem(LAST_WORKSPACE_KEY, state.selectedWorkspaceId);
    renderWorkspaceMembers();
    renderWorkspaceSourceBranches();
  });
}

// ---- Workspaces data load --------------------------------------------------

// Fetch /api/workspaces into state.workspaces. Clears a stale remembered
// selection (and falls back to project target) when its id is gone. Degrades
// gracefully to [] when the route 404s / errors.
async function loadWorkspaces() {
  try {
    const res = await fetch('/api/workspaces');
    const data = await safeJson(res);
    state.workspaces = res.ok && Array.isArray(data.workspaces) ? data.workspaces : [];
  } catch {
    state.workspaces = [];
  }
  // Stale selection guard: a remembered workspace id not in the fetched list is
  // cleared, and we fall back to project target.
  const remembered = localStorage.getItem(LAST_WORKSPACE_KEY) || '';
  if (remembered && !state.workspaces.some((w) => w && w.id === remembered)) {
    localStorage.removeItem(LAST_WORKSPACE_KEY);
    if (state.selectedWorkspaceId === remembered) state.selectedWorkspaceId = '';
    if (state.runTarget === 'workspace') setRunTarget('project');
  }
  return state.workspaces;
}

function updateWorkspacesCount() {
  if (el.navWorkspacesCount) el.navWorkspacesCount.textContent = String(state.workspaces.length);
}

// ---- Workspaces management view --------------------------------------------

async function loadWorkspacesView() {
  await loadWorkspaces();
  renderWorkspaces();
  updateWorkspacesCount();
}

function setWsMsg(text, kind) {
  if (!el.wsMsg) return;
  el.wsMsg.textContent = text || '';
  el.wsMsg.className = 'form-msg' + (kind ? ' ' + kind : '');
}

function renderWorkspaces() {
  const host = el.wsList;
  if (!host) return;
  host.innerHTML = '';
  if (!state.workspaces.length) {
    host.appendChild(histEmpty('No workspaces yet — create one to scan a set of projects.'));
    return;
  }
  for (const w of state.workspaces) host.appendChild(buildWorkspaceCard(w));
}

// Build one workspace card from the template. The description is markdown shown
// VERBATIM in a <pre> (no renderer — matches the #viewer pattern; .textContent
// only, never innerHTML).
function buildWorkspaceCard(w) {
  const tpl = $('#ws-card-tpl');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.workspaceId = w.id || '';

  const nameEl = node.querySelector('.ws-name');
  if (nameEl) nameEl.textContent = w.name || w.id || '(unnamed)';

  const projEl = node.querySelector('.ws-projects');
  if (projEl) projEl.textContent = (Array.isArray(w.projectPaths) ? w.projectPaths.map(wsBasename) : []).join(' · ');

  const stale = node.querySelector('.ws-stale');
  if (stale) stale.hidden = !(Array.isArray(w.exists) && w.exists.some((e) => !e));

  const descView = node.querySelector('.ws-desc-view');
  if (descView) descView.textContent = w.description || '(no description yet — re-scan to generate one)';

  return node;
}

// Delegated actions on the workspaces list.
if (el.wsList) {
  el.wsList.addEventListener('click', (e) => {
    const card = e.target.closest && e.target.closest('.ws-card');
    if (!card) return;
    const id = card.dataset.workspaceId;
    const w = state.workspaces.find((x) => x && x.id === id);

    if (e.target.closest('.ws-edit')) { e.stopPropagation(); openWsEdit(card, w); return; }
    if (e.target.closest('.ws-desc-cancel')) { e.stopPropagation(); closeWsEdit(card, w); return; }
    if (e.target.closest('.ws-desc-save')) { e.stopPropagation(); saveWsDescription(card, w); return; }
    if (e.target.closest('.ws-rescan')) { e.stopPropagation(); rescanWorkspace(w); return; }
    if (e.target.closest('.ws-delete')) { e.stopPropagation(); deleteWorkspaceCard(card, w); return; }

    // Header click toggles the detail pane.
    if (e.target.closest('.ws-head')) toggleWsDetail(card);
  });
  el.wsList.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    const head = e.target.closest && e.target.closest('.ws-head');
    if (!head) return;
    e.preventDefault();
    toggleWsDetail(head.closest('.ws-card'));
  });
}

function toggleWsDetail(card) {
  if (!card) return;
  const head = card.querySelector('.ws-head');
  const detail = card.querySelector('.ws-detail');
  if (!head || !detail) return;
  const open = head.getAttribute('aria-expanded') === 'true';
  head.setAttribute('aria-expanded', String(!open));
  detail.hidden = open;
}

function openWsEdit(card, w) {
  if (!card || !w) return;
  const detail = card.querySelector('.ws-detail');
  const head = card.querySelector('.ws-head');
  if (detail && head && detail.hidden) { detail.hidden = false; head.setAttribute('aria-expanded', 'true'); }
  const pane = card.querySelector('.ws-desc-edit');
  const input = card.querySelector('.ws-desc-input');
  if (input) input.value = w.description || '';
  if (pane) pane.hidden = false;
  if (input) input.focus();
}

function closeWsEdit(card) {
  const pane = card && card.querySelector('.ws-desc-edit');
  if (pane) pane.hidden = true;
}

// Save an edited description: PATCH /api/workspaces/:id { description }. JSON-safe
// (JSON.stringify); the textarea value is read via .value, written via .textContent.
async function saveWsDescription(card, w) {
  if (!card || !w) return;
  const input = card.querySelector('.ws-desc-input');
  const description = input ? input.value : '';
  const saveBtn = card.querySelector('.ws-desc-save');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const res = await fetch(`/api/workspaces/${encodeURIComponent(w.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
    });
    const data = await safeJson(res);
    if (!res.ok) { setWsMsg(data.error || `HTTP ${res.status}`, 'err'); return; }
    const updated = data.workspace || { ...w, description };
    const i = state.workspaces.findIndex((x) => x && x.id === w.id);
    if (i >= 0) state.workspaces[i] = updated;
    setWsMsg('Description saved.', 'ok');
    renderWorkspaces();
  } catch (err) {
    setWsMsg(err.message, 'err');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

// Re-scan: POST /api/workspaces/:id/scan and jump into the wizard at Step 2 with
// editingId set, so Step 3 Save issues a PATCH (not a POST).
async function rescanWorkspace(w) {
  if (!w) return;
  state.wizard.editingId = w.id;
  state.wizard.name = w.name || '';
  state.wizard.selectedPaths = Array.isArray(w.projectPaths) ? [...w.projectPaths] : [];
  location.hash = 'workspace-create';
  // showView('workspace-create') runs enterWizard(); kick off the scan after.
  await startWizardScan();
}

// Delete: confirm, then DELETE. 200 removes the card + surfaces warnings; 409
// (live run/scan) keeps the card + surfaces data.error.
async function deleteWorkspaceCard(card, w) {
  if (!card || !w) return;
  if (!window.confirm(`Delete workspace "${w.name || w.id}"?\n\nThis removes its history store and best-effort branch cleanup. This cannot be undone.`)) return;
  const btn = card.querySelector('.ws-delete');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`/api/workspaces/${encodeURIComponent(w.id)}`, { method: 'DELETE' });
    const data = await safeJson(res);
    if (res.status === 409) { setWsMsg(data.error || 'Workspace has a live run or scan.', 'err'); if (btn) btn.disabled = false; return; }
    if (!res.ok) { setWsMsg(data.error || `HTTP ${res.status}`, 'err'); if (btn) btn.disabled = false; return; }
    state.workspaces = state.workspaces.filter((x) => !(x && x.id === w.id));
    if (state.selectedWorkspaceId === w.id) state.selectedWorkspaceId = '';
    if (localStorage.getItem(LAST_WORKSPACE_KEY) === w.id) localStorage.removeItem(LAST_WORKSPACE_KEY);
    const warnings = Array.isArray(data.warnings) ? data.warnings : [];
    setWsMsg(warnings.length ? `Deleted. Warnings: ${warnings.join('; ')}` : 'Workspace deleted.', warnings.length ? '' : 'ok');
    renderWorkspaces();
    updateWorkspacesCount();
  } catch (err) {
    setWsMsg(err.message, 'err');
    if (btn) btn.disabled = false;
  }
}

if (el.wsCreateBtn) el.wsCreateBtn.addEventListener('click', () => { location.hash = 'workspace-create'; });

// ---- Creation wizard -------------------------------------------------------

// Reset the ephemeral wizard state to defaults, preserving a re-scan's editingId
// + selectedPaths so Step 2/3 still know what they're scanning.
function resetWizard(preserveEditing = false) {
  const keepId = preserveEditing ? state.wizard.editingId : '';
  const keepPaths = preserveEditing ? state.wizard.selectedPaths : [];
  state.wizard = {
    step: 1, name: preserveEditing ? state.wizard.name : '', selectedPaths: keepPaths,
    scanId: '', description: '', graphifyUsed: null, abort: null, editingId: keepId,
  };
}

// enterWizard is idempotent: it does NOT reset if a scan is already live;
// otherwise it resets (preserving a re-scan's editingId/selectedPaths), loads the
// project list, and shows the current step.
async function enterWizard() {
  const liveScan = !!state.wizard.scanId || !!state.wizard.abort;
  if (!liveScan) {
    const editing = !!state.wizard.editingId;
    if (!editing) resetWizard(false);
  }
  if (el.wizTitle) el.wizTitle.textContent = state.wizard.editingId ? 'Re-scan workspace' : 'Create workspace';
  if (el.wizName) {
    el.wizName.value = state.wizard.name || '';
    el.wizName.disabled = !!state.wizard.editingId; // name immutable on re-scan
  }
  if (!state.projects.length) await loadProjects();
  renderWizardProjects();
  showWizardStep(state.wizard.step || 1);
}

// Toggle the three wizard step panes.
function showWizardStep(step) {
  state.wizard.step = step;
  for (let i = 1; i <= 3; i++) {
    const pane = document.getElementById(`wiz-step-${i}`);
    if (pane) pane.classList.toggle('hidden', i !== step);
  }
}

// Render one checkbox per onboarded project (disabled for !exists). Pre-checks
// anything already in selectedPaths (re-scan). Enables Start only at 2+.
function renderWizardProjects() {
  const host = el.wizProjects;
  if (!host) return;
  host.innerHTML = '';
  const projects = Array.isArray(state.projects) ? state.projects : [];
  const usable = projects.filter((p) => p && p.exists);

  if (el.wizStep1Hint) {
    el.wizStep1Hint.textContent = usable.length < 2
      ? 'Onboard at least two projects (in New Pipeline) to create a workspace.'
      : 'Select two or more projects to scan their interconnections.';
  }

  projects.forEach((p) => {
    if (!p || !p.path) return;
    const row = document.createElement('label');
    row.className = 'wiz-proj' + (p.exists ? '' : ' missing');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'wiz-proj-cb';
    cb.value = p.path;
    cb.disabled = !p.exists;
    cb.checked = state.wizard.selectedPaths.includes(p.path);
    cb.addEventListener('change', () => {
      const set = new Set(state.wizard.selectedPaths);
      if (cb.checked) set.add(p.path); else set.delete(p.path);
      state.wizard.selectedPaths = [...set];
      syncWizardStartEnabled();
    });
    const txt = document.createElement('span');
    txt.textContent = p.exists ? p.name : `${p.name} (missing)`;
    row.append(cb, txt);
    host.appendChild(row);
  });
  syncWizardStartEnabled();
}

function syncWizardStartEnabled() {
  if (el.wizStartScan) el.wizStartScan.disabled = state.wizard.selectedPaths.length < 2;
}

// Start (or restart) the scan. Validates name + 2+ projects, shows Step 2,
// creates an AbortController, POSTs (pre-persist for new / :id/scan for re-scan),
// stores scanId, and subscribes. The scan runs BEFORE the workspace is persisted.
async function startWizardScan() {
  const editing = !!state.wizard.editingId;
  const name = el.wizName ? el.wizName.value.trim() : state.wizard.name;
  state.wizard.name = name;
  if (!editing && !name) { showWizardStep(1); setStatusText(''); if (el.wizName) el.wizName.focus(); return; }
  if (state.wizard.selectedPaths.length < 2) { showWizardStep(1); return; }

  // Clear any prior scanId BEFORE the POST resolves, so a buffered/duplicate
  // scan-* for the OLD scan can never match (onScanEvent gates on scanId).
  state.wizard.scanId = '';

  // Reset Step 2 surface.
  setStatusText('Starting scan…');
  if (el.wizProgress) el.wizProgress.textContent = '';
  markScanPhase('');
  if (el.wizMsg) el.wizMsg.textContent = '';
  showWizardStep(2);

  const abort = new AbortController();
  state.wizard.abort = abort;

  const url = editing
    ? `/api/workspaces/${encodeURIComponent(state.wizard.editingId)}/scan`
    : '/api/workspaces/scan';
  const body = editing ? {} : { projectPaths: state.wizard.selectedPaths, name };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    const data = await safeJson(res);
    if (!res.ok || !data.scanId) {
      state.wizard.abort = null;
      setStatusText('');
      showWizardStep(1);
      setWizStep1Error(data.error || `Scan failed (${res.status})`);
      return;
    }
    state.wizard.scanId = data.scanId;
    subscribeScan(data.scanId);
  } catch (err) {
    if (err && err.name === 'AbortError') return; // user aborted; leave-guard handled state
    state.wizard.abort = null;
    setStatusText('');
    showWizardStep(1);
    setWizStep1Error(err.message);
  }
}

function setWizStep1Error(message) {
  if (el.wizStep1Hint) el.wizStep1Hint.textContent = `Scan error: ${message}`;
}

// Persist at Step 3 Save: new → POST /api/workspaces; re-scan → PATCH :id.
// On 200 reset + navigate to #workspaces. On 409 (dup name OR dup set) surface
// data.error verbatim and KEEP the user on Step 3 with their edited text intact.
async function saveWorkspace() {
  const description = el.wizDesc ? el.wizDesc.value : '';
  state.wizard.description = description;
  const editing = !!state.wizard.editingId;
  if (el.wizMsg) el.wizMsg.textContent = '';
  if (el.wizSave) el.wizSave.disabled = true;

  const url = editing
    ? `/api/workspaces/${encodeURIComponent(state.wizard.editingId)}`
    : '/api/workspaces';
  const method = editing ? 'PATCH' : 'POST';
  const body = editing
    ? { description }
    : { name: state.wizard.name, projectPaths: state.wizard.selectedPaths, description };

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await safeJson(res);
    if (res.status === 409) { setWizMsg(data.error || 'Duplicate workspace.', 'err'); return; }
    if (!res.ok) { setWizMsg(data.error || `HTTP ${res.status}`, 'err'); return; }
    resetWizard(false);
    await loadWorkspaces();
    updateWorkspacesCount();
    location.hash = 'workspaces';
  } catch (err) {
    setWizMsg(err.message, 'err');
  } finally {
    if (el.wizSave) el.wizSave.disabled = false;
  }
}

function setWizMsg(text, kind) {
  if (!el.wizMsg) return;
  el.wizMsg.textContent = text || '';
  el.wizMsg.className = 'form-msg' + (kind ? ' ' + kind : '');
}

// Abort a live scan: abort the fetch, unsubscribe, clear wizard scan state.
// Invoked by the leave-guard, #wiz-abort, and Cancel.
function abortWizardScan() {
  const scanId = state.wizard.scanId;
  if (state.wizard.abort) { try { state.wizard.abort.abort(); } catch { /* ignore */ } }
  if (scanId) {
    const ws = state.ws;
    if (ws && state.wsReady) { try { ws.send(JSON.stringify({ type: 'unsubscribe', scanId })); } catch { /* ignore */ } }
  }
  state.wizard.abort = null;
  state.wizard.scanId = '';
}

if (el.wizStartScan) el.wizStartScan.addEventListener('click', () => startWizardScan());
if (el.wizAbort) el.wizAbort.addEventListener('click', () => { abortWizardScan(); showWizardStep(1); });
if (el.wizRescan) el.wizRescan.addEventListener('click', () => startWizardScan());
if (el.wizSave) el.wizSave.addEventListener('click', () => saveWorkspace());
if (el.wizClose) el.wizClose.addEventListener('click', () => { location.hash = state.wizard.editingId ? 'workspaces' : 'new'; });
if (el.wizName) el.wizName.addEventListener('input', () => { state.wizard.name = el.wizName.value; });

// A11y: Escape in the wizard view triggers #wiz-close (which navigates away;
// the showView leave-guard aborts any live scan). Scoped to the wizard view so
// it never collides with the viewer-modal Escape handler.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (currentView() !== 'workspace-create') return;
  if (el.viewerCard && !el.viewerCard.classList.contains('hidden')) return; // modal owns Escape
  if (el.wizClose) el.wizClose.click();
});

// ---- Scan WebSocket wiring -------------------------------------------------

// Bind the live, CHANGING status text. .ws-loader carries role="status"
// aria-live="polite", so each update is announced.
function setStatusText(text) {
  if (el.wizStatus) el.wizStatus.textContent = text || '';
}

// Light up the phase track; phases progress graph → investigate → synthesize.
function markScanPhase(phase) {
  if (!el.wizPhases) return;
  el.wizPhases.querySelectorAll('[data-phase]').forEach((n) => {
    n.classList.toggle('active', !!phase && n.dataset.phase === phase);
  });
}

// Subscribe to a scan's buffered events on the shared socket.
function subscribeScan(scanId) {
  const ws = state.ws;
  if (ws && state.wsReady) { try { ws.send(JSON.stringify({ type: 'subscribe', scanId })); } catch { /* ignore */ } }
}

// Route a scan-* event. Ignores events for a different/aborted scan.
function onScanEvent(msg) {
  if (!msg || !msg.scanId || msg.scanId !== state.wizard.scanId) return; // stale/aborted scan
  if (msg.type === 'scan-progress') {
    setStatusText(msg.message || '');
    if (el.wizProgress && (msg.projectsTotal != null)) {
      el.wizProgress.textContent = `${msg.projectsDone || 0} / ${msg.projectsTotal} projects`;
    }
    markScanPhase(msg.phase || '');
    return;
  }
  if (msg.type === 'scan-done') {
    state.wizard.abort = null;
    state.wizard.description = typeof msg.description === 'string' ? msg.description : '';
    state.wizard.graphifyUsed = !!(msg.graphify && msg.graphify.used);
    if (el.wizDesc) el.wizDesc.value = state.wizard.description; // .value only — never innerHTML
    if (el.wizGraphifyNote) {
      el.wizGraphifyNote.textContent = state.wizard.graphifyUsed
        ? 'Generated with graphify-assisted analysis.'
        : 'Generated from source reading (graphify not available).';
    }
    showWizardStep(3);
    return;
  }
  if (msg.type === 'scan-error') {
    state.wizard.abort = null;
    state.wizard.scanId = '';
    showWizardStep(1);
    setWizStep1Error(msg.message || 'scan failed');
  }
}

// Test hook: expose the wizard helpers + workspace renderers for jsdom tests.
if (typeof window !== 'undefined') {
  window.__ws = {
    setRunTarget, ensureWorkspaceOptions, loadWorkspaces, loadWorkspacesView,
    renderWorkspaces, buildWorkspaceCard, enterWizard, showWizardStep,
    renderWizardProjects, startWizardScan, saveWorkspace, abortWizardScan,
    onScanEvent, subscribeScan, setStatusText, resetWizard,
    renderWorkspaceSourceBranches,
  };
}

// ---------------------------------------------------------------------------
// Start a run
// ---------------------------------------------------------------------------
el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  setFormMsg('', '');

  // Target branch (§5.4 mutual exclusivity): workspace mode sends {workspaceId}
  // and NO projectDir; project mode sends {projectDir} and NO workspaceId.
  const target = state.runTarget === 'workspace' ? 'workspace' : 'project';
  let projectDir = '';
  let workspaceId = '';
  let workspaceName = '';
  if (target === 'workspace') {
    workspaceId = (el.workspaceSelect && el.workspaceSelect.value) || '';
    if (!workspaceId) return setFormMsg('Select a workspace first (or create one).', 'err');
    const ws = state.workspaces.find((w) => w && w.id === workspaceId);
    workspaceName = (ws && ws.name) || '';
  } else {
    projectDir = selectedProjectPath();
    if (!projectDir) return setFormMsg('Select a project first (or add one).', 'err');
  }

  const source = (el.sourceRadios.find((r) => r.checked) || {}).value || 'prompt';
  const promptText = el.prompt.value.trim();
  const mdText = el.promptMarkdown.value.trim();
  const title = el.title.value.trim();

  const body = {
    title: title || undefined,
    workflowId: state.workflowId || 'wf_default',
    mock: el.mock.checked,
    sourceBranch: (el.sourceBranch && el.sourceBranch.value) || undefined,
    featureBranch: (el.featureBranch && el.featureBranch.value.trim()) || undefined,
  };
  if (target === 'workspace') {
    body.workspaceId = workspaceId;
    // Per-project source branches: { [projectKey]: branch }. Omit empties (the
    // "auto" placeholder) so the server falls back to each project's default.
    const byKey = {};
    if (el.wsSourceBranches) {
      el.wsSourceBranches.querySelectorAll('select.ws-src-select').forEach((s) => {
        const key = s.dataset.projectKey;
        const val = (s.value || '').trim();
        if (key && val) byKey[key] = val;
      });
    }
    if (Object.keys(byKey).length) body.sourceBranchByKey = byKey;
    // The single #sourceBranch is hidden in workspace mode — don't send it. (The
    // body literal sets `sourceBranch: ... || undefined`, so the key still EXISTS
    // with value undefined; delete it so `'sourceBranch' in body` is false.)
    delete body.sourceBranch;
  } else {
    body.projectDir = projectDir;
  }

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
    beginRun(data.runId, projectDir, title, target === 'workspace' ? { workspaceId, workspaceName } : {});
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

// Create the local run model for a run THIS tab just started and switch to the
// Running view. We do NOT send a subscribe here: live events arrive via the
// server's broadcast, and a subscribe would double-replay this run's buffer on
// the next hello.
// [v2/C2] beginRun is POSITIONAL. opts is an optional 4th arg carrying workspace
// attribution ({workspaceId, workspaceName}); in workspace mode the card label
// prefers the workspace name. Project mode passes {} and is byte-identical.
function beginRun(runId, projectDir, title, opts = {}) {
  const label = title || opts.workspaceName || '(untitled)';
  const r = upsertRun({
    runId,
    title: label,
    projectDir: projectDir || '',
    status: 'starting',
    local: true,
    workspaceId: opts.workspaceId || undefined,
    workspaceName: opts.workspaceName || undefined,
  });
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
// Settings view: the machine-wide Maestro root folder.
// ---------------------------------------------------------------------------
function setSettingsMsg(text, kind) {
  if (!el.settingsMsg) return;
  el.settingsMsg.textContent = text || '';
  el.settingsMsg.className = 'hint' + (kind ? ' ' + kind : '');
}

async function loadSettings() {
  if (!el.settingsRoot) return;
  try {
    const res = await fetch('/api/settings');
    const data = await safeJson(res);
    if (!res.ok) { setSettingsMsg(data.error || `HTTP ${res.status}`, 'err'); return; }
    el.settingsRoot.value = data.root || '';
    el.settingsRoot.placeholder = data.default || '';
    if (el.settingsRootDefault) el.settingsRootDefault.textContent = data.default ? `Default: ${data.default}` : '';
    setSettingsMsg('');
  } catch (e) { setSettingsMsg(e.message, 'err'); }
}

async function saveSettings(root) {
  if (!el.settingsSave) return;
  el.settingsSave.disabled = true;
  if (el.settingsReset) el.settingsReset.disabled = true;
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root }),
    });
    const data = await safeJson(res);
    if (!res.ok) { setSettingsMsg(data.error || `HTTP ${res.status}`, 'err'); return; }
    el.settingsRoot.value = data.root || '';
    el.settingsRoot.placeholder = data.default || '';
    setSettingsMsg('Saved. New runs use this root.');
    // The root relocates the project registry + workflows; reload projects so
    // the UI reflects what's available under the new root.
    loadProjects();
  } catch (e) { setSettingsMsg(e.message, 'err'); }
  finally {
    el.settingsSave.disabled = false;
    if (el.settingsReset) el.settingsReset.disabled = false;
  }
}

if (el.settingsSave) el.settingsSave.addEventListener('click', () => saveSettings((el.settingsRoot.value || '').trim()));
if (el.settingsReset) el.settingsReset.addEventListener('click', () => saveSettings(''));

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
// History
//
// The tab is driven entirely by GET /api/history (every project with pipelines
// on disk, onboarded or not). The project pills and per-project sticky sections
// are derived client-side from that single dataset; selecting a pill is a pure
// in-memory filter (no refetch). The chosen project is remembered for the
// History filter only — independent of the New-Pipeline project picker.
// ---------------------------------------------------------------------------
const HISTORY_FILTER_KEY = 'maestro.history.project'; // stores a projectKey; '' === All Projects

// Versioned localStorage cache for instant (stale-while-revalidate) first paint.
// Only stable FS + local-git skeleton fields are persisted — never the live `pr`
// (a gh fact that goes stale); Phase-2 fills PR state over the WS. Bump the .vN
// suffix on any shape change (there is no migration helper).
const HISTORY_CACHE_KEY = 'maestro.history.cache.v1';
const HISTORY_CACHE_VER = 1;
const HISTORY_CACHE_MAX = 500;   // cap persisted rows (rows are newest-first)

function readHistoryCache() {
  try {
    const raw = localStorage.getItem(HISTORY_CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);                              // try/catch mirrors the ws parse guard
    if (!c || c.v !== HISTORY_CACHE_VER || !Array.isArray(c.pipelines)) {
      localStorage.removeItem(HISTORY_CACHE_KEY);           // version/shape bust -> forget the bad blob
      return null;
    }
    return c;
  } catch { localStorage.removeItem(HISTORY_CACHE_KEY); return null; }  // parse bust
}

function writeHistoryCache(pipelines, ghAvailable) {
  try {
    const slim = pipelines.slice(0, HISTORY_CACHE_MAX).map(({ pr, ...rest }) => rest); // never persist live PR
    localStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify(
      { v: HISTORY_CACHE_VER, ts: Date.now(), ghAvailable: !!ghAvailable, pipelines: slim }));
  } catch { /* quota / serialization: skip cache, never throw */ }
}

// Refresh re-fetches /api/history with force:true (bypass the cache, always show
// the spinner + re-trigger Phase 2). Other callers (showView/onHello) stay
// cache-first. The active filter is preserved (it lives in localStorage).
el.refreshHistory.addEventListener('click', () => loadHistoryView({ force: true }));

let historyLoadToken = 0;                 // monotonically increasing; newest wins (per-tab)
let historyInFlight = null;               // AbortController for the current skeleton fetch
let historyBooted = false;                // first-connect guard: background-load history once

async function loadHistoryView({ force = false } = {}) {
  const token = ++historyLoadToken;       // any earlier resolved fetch/push is now stale
  if (historyInFlight) { try { historyInFlight.abort(); } catch {} }
  const ac = new AbortController();
  historyInFlight = ac;

  // (A1) Instant paint from cache — UNLESS this is a force-refresh.
  if (!force) {
    const cached = readHistoryCache();
    if (cached) {
      state.historyAll = cached.pipelines;
      state.ghAvailable = cached.ghAvailable;
      restoreHistoryFilter();
      paintHistory();                     // instant; cards show Create-PR in its neutral state
    }
  }
  setHistoryLoading(true);                // spinner + disable Refresh

  let res, data;
  try {
    res = await fetch('/api/history', { signal: ac.signal });
    data = await safeJson(res);
  } catch (e) {
    if (e.name === 'AbortError') return;                 // superseded; newer load owns the spinner
    if (token !== historyLoadToken) return;
    if (!state.historyAll.length) renderHistoryError(e.message);  // else keep the stale paint
    setHistoryLoading(false);
    return;
  }
  if (token !== historyLoadToken) return;                // a newer load won the race -> drop
  if (!res.ok) {
    if (!state.historyAll.length) renderHistoryError((data && data.error) || `HTTP ${res.status}`);
    setHistoryLoading(false);
    return;
  }
  const pipelines = Array.isArray(data.pipelines) ? data.pipelines : [];
  state.historyAll = pipelines;
  state.ghAvailable = !!data.ghAvailable;
  restoreHistoryFilter();
  paintHistory();                                        // fresh skeleton repaint
  if (pipelines.length) writeHistoryCache(pipelines, data.ghAvailable);  // never cache empty/error
  requestHistoryPr(token);                               // Phase 2: ask server to push gh enrichment
  // NOTE: the spinner intentionally stays ON here; onHistoryPr (or the watchdog) clears it.
}

// Restore the remembered filter, but only if that project still has history;
// otherwise fall back to All Projects (the default).
function restoreHistoryFilter() {
  const saved = localStorage.getItem(HISTORY_FILTER_KEY) || '';
  state.historyFilter = saved && state.historyAll.some((p) => p && p.projectKey === saved) ? saved : '';
}

// Loading affordance for Refresh: disable + spin the button and mark the list
// aria-busy. Mirrors the per-button busy idiom in setupPrButton/setupDeleteButton.
function setHistoryLoading(on) {
  const btn = el.refreshHistory;                         // #refresh-history
  if (btn) { btn.disabled = !!on; btn.classList.toggle('busy', !!on); }
  if (el.history) el.history.setAttribute('aria-busy', on ? 'true' : 'false');
}

// Phase-2 trigger + WS handler. The spinner stays on through PR enrichment and is
// cleared by the final batch, a failed/!ok POST, or the per-token watchdog — so it
// provably always clears even if the WS `done` batch is never delivered.
const HISTORY_PR_TIMEOUT_MS = 15000;
let historyPrWatchdog = null;

function clearHistoryPrWatchdog() {
  if (historyPrWatchdog) { clearTimeout(historyPrWatchdog); historyPrWatchdog = null; }
}

function requestHistoryPr(token) {
  clearHistoryPrWatchdog();
  historyPrWatchdog = setTimeout(() => {                       // terminal fallback
    if (token === historyLoadToken) { finalizeHistoryPr(); setHistoryLoading(false); }
    historyPrWatchdog = null;
  }, HISTORY_PR_TIMEOUT_MS);
  // In Node-backed test runners the timer would keep the event loop alive; unref it
  // there. In a real browser setTimeout returns a number, so this is a no-op.
  if (historyPrWatchdog && typeof historyPrWatchdog.unref === 'function') historyPrWatchdog.unref();

  fetch('/api/history/pr', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  })
    .then((r) => { if (!r || !r.ok) throw new Error(`history-pr ${r ? r.status : 'failed'}`); })
    .catch(() => {                                             // network error OR !res.ok
      if (token === historyLoadToken) { finalizeHistoryPr(); setHistoryLoading(false); clearHistoryPrWatchdog(); }
    });
}

// Dispatched from handleServerMessage for {type:'history-pr'} frames.
function onHistoryPr(msg) {
  if (!msg || msg.token !== historyLoadToken) return;        // stale batch from a superseded load -> drop
  const items = Array.isArray(msg.items) ? msg.items : [];
  for (const it of items) patchHistoryPr(it);                // model + DOM, in place
  if (msg.done) { finalizeHistoryPr(); setHistoryLoading(false); clearHistoryPrWatchdog(); }  // final batch clears the spinner
}

// Escape a value for use inside a quoted attribute selector. Prefers CSS.escape;
// the fallback escapes the chars that would break `[attr="..."]`.
function cssEscape(s) {
  s = String(s == null ? '' : s);
  return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\\]]/g, '\\$&');
}

// Rebuild the .hist-merge + .hist-pr nodes from the template so a re-patch (e.g. a
// Refresh after a link was already rendered) starts from the Create-PR BUTTON again:
// setupPrButton early-returns if it cannot find `.hist-pr` (a prior button->link
// swap did btn.replaceWith(link)), so that swap must be undone first. Cloning fresh
// nodes also drops any click listener a prior setupPrButton attached.
function resetPrCluster(card) {
  const aside = card.querySelector('.hist-aside');
  if (!aside) return;
  const tpl = $('#hist-card-tpl').content;
  const freshMerge = tpl.querySelector('.hist-merge').cloneNode(true);  // <span class="hist-merge" hidden>
  const freshPr = tpl.querySelector('.hist-pr').cloneNode(true);        // <button class="hist-pr btn-ghost" hidden>
  const curMerge = aside.querySelector('.hist-merge');
  const curPr = aside.querySelector('.hist-pr, .hist-pr-link');         // button OR the swapped-in link
  if (curMerge) curMerge.replaceWith(freshMerge); else aside.appendChild(freshMerge);
  if (curPr) curPr.replaceWith(freshPr); else aside.appendChild(freshPr);
}

function patchHistoryPr({ projectKey, id, pr }) {
  // 1) Update the in-memory model (by id AND projectKey) so a later paintHistory()
  //    (e.g. a filter click) does NOT revert the card to its pr-less state.
  const row = state.historyAll.find((r) => r && r.id === id && r.projectKey === projectKey);
  if (row) row.pr = pr || null;

  // 2) Patch ONLY the matching live card in place. NEVER call paintHistory() here —
  //    a full repaint blows away expand state + the lazily-fetched stepper.
  const sel = `.hist-card[data-pipeline-id="${cssEscape(id)}"][data-project-key="${cssEscape(projectKey)}"]`;
  const card = el.history.querySelector(sel);
  if (!card) return;                                         // off-screen (filtered out) — model is enough
  resetPrCluster(card);
  setupPrButton(card, row?.projectDir || null, row || { id, projectKey, pr }, state.ghAvailable);
  // No setMergePill: clarification B — merged-or-not is shown by the link swap inside
  // setupPrButton (OPEN->"View PR", MERGED->"Merged"); the .hist-merge pill stays hidden.
}

// Enrichment terminated (final WS batch, failed POST, or the watchdog): any entry
// still unresolved (pr === undefined) is treated as "no PR" so its control is
// revealed. Without this an eligible entry the server never sent a batch for — or a
// load where enrichment failed entirely — would stay hidden forever. Patches the
// visible card in place; off-screen rows get the model update and resolve on the
// next paint (e.g. a filter click). Callers already gate on the load token.
function finalizeHistoryPr() {
  for (const row of state.historyAll) {
    if (!row || row.pr !== undefined) continue;        // already resolved (object or null)
    row.pr = null;                                      // resolved: no open/merged PR
    const sel = `.hist-card[data-pipeline-id="${cssEscape(row.id)}"][data-project-key="${cssEscape(row.projectKey)}"]`;
    const card = el.history.querySelector(sel);
    if (!card) continue;                                // off-screen — model update is enough
    resetPrCluster(card);
    setupPrButton(card, row.projectDir || null, row, state.ghAvailable);
  }
}

// Distinct projects present in the dataset, in most-recent-activity order
// (listAllPipelines is newest-first, so first encounter === most recent pipeline).
function historyProjects() {
  const seen = new Map(); // projectKey -> { key, name, count, workspace }
  for (const p of state.historyAll) {
    if (!p || !p.projectKey) continue;
    const cur = seen.get(p.projectKey);
    if (cur) cur.count += 1;
    else {
      const isWs = p.target === 'workspace';
      // Workspace rows (projectKey="workspaces/<key>") prefer the workspace name.
      const name = isWs ? (p.workspaceName || p.projectName || p.projectKey) : (p.projectName || p.projectKey);
      seen.set(p.projectKey, { key: p.projectKey, name, count: 1, workspace: isWs });
    }
  }
  return [...seen.values()];
}

// The pinned pills toolbar has a dynamic height (pills wrap on narrow widths),
// so measure it and expose it as --hist-toolbar-h on the History view. The
// per-project sticky header reads it (top:var(--hist-toolbar-h)) to sit exactly
// below the toolbar instead of behind it.
let histToolbarRO = null;
function syncHistToolbarHeight() {
  const tb = el.historyFilter;
  if (!tb) return;
  const view = tb.closest('.view');
  if (view) view.style.setProperty('--hist-toolbar-h', tb.offsetHeight + 'px');
}
function ensureHistToolbarObserver() {
  // window.ResizeObserver matches the existing usage at app.js:766; absent under
  // jsdom, where the typeof guard makes this a no-op (offsetHeight is 0 there).
  if (histToolbarRO || !el.historyFilter || typeof ResizeObserver === 'undefined') return;
  histToolbarRO = new window.ResizeObserver(() => syncHistToolbarHeight());
  histToolbarRO.observe(el.historyFilter);
}

// Build the pill row: "All Projects" + one pill per project. Clicking sets the
// filter, persists it, and repaints.
function renderHistoryPills() {
  const host = el.historyFilter;
  if (!host) return;
  host.innerHTML = '';

  const mkPill = (key, label, count, isWs = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    const active = state.historyFilter === key;
    b.className = 'hist-pill' + (isWs ? ' ws' : '') + (active ? ' active' : '');
    b.dataset.projectKey = key;
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
    const txt = document.createElement('span');
    txt.textContent = label;
    b.appendChild(txt);
    b.appendChild(document.createTextNode(' ')); // keep label/count separable in textContent
    const c = document.createElement('span');
    c.className = 'pill-count';
    c.textContent = String(count);
    b.appendChild(c);
    b.addEventListener('click', () => setHistoryFilter(key));
    return b;
  };

  host.appendChild(mkPill('', 'All Projects', state.historyAll.length));
  for (const pr of historyProjects()) host.appendChild(mkPill(pr.key, pr.name, pr.count, pr.workspace));

  // Keep the sticky project header offset in sync with the toolbar's height
  // (also re-measures on resize, when pills wrap to more/fewer rows).
  ensureHistToolbarObserver();
  syncHistToolbarHeight();
}

// Switch the active project filter, persist it (so it survives reloads), repaint.
// Selecting All Projects clears the memory (the default needs no stored value).
function setHistoryFilter(key) {
  state.historyFilter = key || '';
  if (state.historyFilter) localStorage.setItem(HISTORY_FILTER_KEY, state.historyFilter);
  else localStorage.removeItem(HISTORY_FILTER_KEY);
  paintHistory();
}

// Repaint pills + the list from the in-memory dataset (no refetch).
function paintHistory() {
  // If the active filter's project is gone (e.g. its last pipeline was just
  // deleted in this session), fall back to All Projects so the view never
  // strands on an empty, unselectable filter.
  if (state.historyFilter && !state.historyAll.some((p) => p && p.projectKey === state.historyFilter)) {
    state.historyFilter = '';
    localStorage.removeItem(HISTORY_FILTER_KEY);
  }
  renderHistoryPills();
  renderHistory();
}

// Render #history from state.historyAll filtered by state.historyFilter.
//   All Projects ('')  -> per-project sections, each with a sticky header.
//   A specific project -> flat list (the active pill already names the project).
function renderHistory() {
  const host = el.history;
  host.innerHTML = '';
  const all = Array.isArray(state.historyAll) ? state.historyAll : [];
  const filter = state.historyFilter;
  const records = filter ? all.filter((p) => p && p.projectKey === filter) : all;

  if (el.navHistoryCount) el.navHistoryCount.textContent = String(records.length);

  if (!records.length) {
    host.appendChild(histEmpty(filter ? 'No saved pipelines for this project yet.' : 'No saved pipelines yet.'));
    return;
  }

  if (filter) {
    for (const p of records) host.appendChild(buildHistCard(p.projectDir || null, p, state.ghAvailable));
    return;
  }

  // All Projects: bucket by projectKey, preserving the newest-first group order.
  const groups = new Map(); // key -> { name, items: [] }
  for (const p of records) {
    const key = p && p.projectKey ? p.projectKey : '';
    let g = groups.get(key);
    if (!g) {
      // Workspace rows prefer the workspace name for the section header.
      const name = (p && p.target === 'workspace' && p.workspaceName)
        || (p && p.projectName) || key || '(unknown project)';
      g = { name, items: [] };
      groups.set(key, g);
    }
    g.items.push(p);
  }
  for (const g of groups.values()) host.appendChild(buildHistGroup(g));
}

// One per-project section: a sticky, non-collapsible header + that project's cards.
function buildHistGroup(group) {
  const wrap = document.createElement('section');
  wrap.className = 'hist-group';

  const head = document.createElement('div');
  head.className = 'hist-group-head';
  const name = document.createElement('span');
  name.textContent = group.name;
  const count = document.createElement('span');
  count.className = 'pill-count';
  count.textContent = String(group.items.length);
  head.append(name, ' ', count); // space keeps name/count separable in textContent
  wrap.appendChild(head);

  for (const p of group.items) wrap.appendChild(buildHistCard(p.projectDir || null, p, state.ghAvailable));
  return wrap;
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
  if (s === 'interrupted') return { cls: 'badge red', text: 'INTERRUPTED' };
  if (p.live || s === 'running' || s === 'starting') return { cls: 'badge running', text: 'RUNNING' };
  return { cls: 'badge', text: s ? s.toUpperCase() : 'UNKNOWN' };
}

// Render the +added / −removed line-count chip for a survived branch. Colors are
// class-driven (green add / red del). Nothing for branches that did not survive.
// NOTE: the minus glyph is U+2212 (−), not an ASCII hyphen; the jsdom test
// asserts it byte-for-byte, so keep this exact character.
function renderHistDiff(host, p) {
  if (!host) return;
  host.textContent = '';
  if (!p || !p.survived) return;
  const added = Number.isFinite(+p.added) ? +p.added : 0;
  const removed = Number.isFinite(+p.removed) ? +p.removed : 0;
  const add = document.createElement('span');
  add.className = 'diff-add';
  add.textContent = `+${added}`;
  const del = document.createElement('span');
  del.className = 'diff-del';
  del.textContent = `−${removed}`; // U+2212 minus
  host.append(add, del);
  host.title = `${added} added, ${removed} removed vs ${p.sourceBranch || 'source'}`;
}

// Wire the Create-PR button. Shown only when gh is available AND the feature
// branch survived AND we know its source. Click pushes + opens the PR, then
// swaps itself for a link and reveals the mergeability pill.
function setupPrButton(node, projectDir, p, ghAvailable) {
  const btn = node.querySelector('.hist-pr');
  const mergeEl = node.querySelector('.hist-merge');
  if (!btn) return;

  // A PR already open or merged for this branch -> never offer "Create PR";
  // replace the button with a link to that existing PR (reusing gh's URL). This
  // runs BEFORE the `survived` eligibility check, so a merged PR whose branch was
  // deleted (survived === false) still shows a "Merged" link.
  const pr = p.pr && typeof p.pr === 'object' ? p.pr : null;
  const prState = pr ? String(pr.state || '').toUpperCase() : '';
  if (pr && (prState === 'OPEN' || prState === 'MERGED') && pr.url) {
    const link = document.createElement('a');
    link.className = prState === 'MERGED' ? 'hist-pr-link merged' : 'hist-pr-link';
    link.href = pr.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = prState === 'MERGED' ? 'Merged' : 'View PR';
    // Clicking the link must not toggle the surrounding history card.
    link.addEventListener('click', (e) => e.stopPropagation());
    btn.replaceWith(link);
    return;
  }

  const eligible = ghAvailable && p.survived && p.branch && p.sourceBranch;
  if (!eligible) { btn.hidden = true; return; }

  // PR state not yet resolved for this entry (Phase-2 enrichment still in flight).
  // Keep the button hidden instead of flashing "Create PR" on an entry that may
  // already have an OPEN/MERGED PR. patchHistoryPr (per-entry result) or
  // finalizeHistoryPr (terminal) re-runs this with a resolved pr — object or null —
  // and reveals the correct control. Tri-state on entry.pr:
  //   undefined = pending, null = looked/none, object = found.
  if (p.pr === undefined) { btn.hidden = true; return; }

  btn.hidden = false;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation(); // never toggle the card when clicking the button
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Creating…';
    try {
      const res = await fetch('/api/pr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir: p.projectDir || projectDir, projectKey: p.projectKey, id: p.id }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      const link = document.createElement('a');
      link.className = 'hist-pr-link';
      link.href = data.url || '#';
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = data.existed ? 'View PR' : 'PR opened';
      btn.replaceWith(link);
      if (mergeEl) setMergePill(mergeEl, data.mergeable);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = label;
      btn.title = `Could not open PR: ${err.message}`;
    }
  });
}

// A history entry is deletable only when finished (never while live/running/created).
function isDeletableEntry(p) {
  if (!p || p.live) return false;
  const s = String(p.status || '').toLowerCase();
  return !['running', 'starting', 'created'].includes(s);
}

// Wire the Delete button in the expanded card. Shown only for finished entries.
// Confirms via window.confirm (the app's destructive-action convention), then
// DELETEs the pipeline and drops the card from the list.
function setupDeleteButton(node, projectDir, p) {
  const btn = node.querySelector('.hist-delete');
  if (!btn) return;
  if (!isDeletableEntry(p)) { btn.hidden = true; return; }
  btn.hidden = false;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation(); // never toggle the card
    const label = p.title || p.id || 'this entry';
    if (!window.confirm(
      `Delete "${label}"?\n\nThis removes the pipeline records and its local branch/worktree. ` +
      `The remote branch is kept. This cannot be undone.`)) return;
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = 'Deleting…';
    try {
      const qs = new URLSearchParams();
      // A workspace run routes by bare workspaceId; ?projectKey would carry the
      // slashed "workspaces/<wkey>" segment that DELETE /api/runs/:id rejects.
      if (p.target === 'workspace' && typeof p.projectKey === 'string') {
        qs.set('workspaceId', p.projectKey.replace(/^workspaces\//, ''));
      } else if (p.projectKey) {
        qs.set('projectKey', p.projectKey);
      } else {
        qs.set('projectDir', p.projectDir || projectDir);
      }
      const res = await fetch(`/api/runs/${encodeURIComponent(p.id)}?${qs.toString()}`, { method: 'DELETE' });
      const data = await safeJson(res);
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      // Drop from the in-memory dataset and repaint so the list, the per-project
      // section/count, and the pills all stay consistent (removing a project's
      // last pipeline also drops its pill).
      state.historyAll = state.historyAll.filter((r) => !(r && r.id === p.id && r.projectKey === p.projectKey));
      paintHistory();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = prev;
      btn.title = `Could not delete: ${err.message}`;
    }
  });
}

// Paint the post-PR mergeability pill. MERGEABLE -> green, CONFLICTING -> red,
// UNKNOWN -> amber "checking…" (GitHub computes mergeability asynchronously).
function setMergePill(el, mergeable) {
  const m = String(mergeable || 'UNKNOWN').toUpperCase();
  el.hidden = false;
  if (m === 'MERGEABLE') { el.className = 'hist-merge ok'; el.textContent = 'can merge'; }
  else if (m === 'CONFLICTING') { el.className = 'hist-merge bad'; el.textContent = 'conflicts'; }
  else { el.className = 'hist-merge unknown'; el.textContent = 'merge: checking…'; }
}

// Build one expandable history card from a (disk or live) record. The collapsed
// card shows only list-feed data (badge/title/timestamp); the tinted stepper is
// lazily fetched + rendered on first expand.
function buildHistCard(projectDir, p, ghAvailable = false) {
  const tpl = $('#hist-card-tpl');
  const node = tpl.content.firstElementChild.cloneNode(true);
  const id = p.id || '';
  node.dataset.pipelineId = id;
  node.dataset.projectKey = p.projectKey || ''; // composite key for the §3.6 in-place PR patch selector

  const badge = node.querySelector('.badge');
  if (badge) {
    const { cls, text } = historyBadge(p);
    badge.className = cls;
    badge.textContent = text;
  }

  const titleEl = node.querySelector('.h-meta b');
  const title = p.title || id || '(untitled)';
  if (titleEl) {
    titleEl.textContent = title; // project shown by the pill / section header
    titleEl.addEventListener('click', (e) => { e.stopPropagation(); viewPipeline(projectDir, id, p.title, p); });
  }
  const whenEl = node.querySelector('.h-meta small');
  if (whenEl) whenEl.textContent = fmtDate(p.startedAt || p.mtime);
  const timeEl = node.querySelector('.hist-time');
  if (timeEl) timeEl.textContent = typeof p.totalActiveMs === 'number' ? fmtDuration(p.totalActiveMs) : '';
  const totalEl = node.querySelector('.hist-total');
  if (totalEl) {
    totalEl.textContent = typeof p.totalCostUsd === 'number' ? fmtUsd(p.totalCostUsd) : '';
    totalEl.title = typeof p.totalCostUsd === 'number' ? estTitle(p.totalCostUsd) : '';
  }

  // Branch name under the date/cost (left column; hidden when empty via :empty).
  const branchEl = node.querySelector('.hist-branch');
  if (branchEl) branchEl.textContent = p.branch || '';

  // Right-side cluster (before the chevron): lines changed + Create-PR button.
  renderHistDiff(node.querySelector('.hist-diff'), p);
  setupPrButton(node, projectDir, p, ghAvailable);
  setupDeleteButton(node, projectDir, p);

  const head = node.querySelector('.hist-head');
  const detail = node.querySelector('.hist-detail');
  if (head && detail) {
    const toggle = () => toggleHistCard(projectDir, id, head, detail, p);
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); toggle(); }
    });
  }

  return node;
}

// Expand/collapse a history card. On the FIRST expand, lazily fetch the saved
// state and render the tinted stepper, caching it so re-expand doesn't refetch.
function toggleHistCard(projectDir, id, head, detail, record) {
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
  loadHistDetail(projectDir, id, detail, record);
}

// Fetch GET /api/runs/:id and tint this card's stepper from data.state. On
// failure, show a small inline notice and allow a retry on the next expand.
// Resolve the saved-pipeline detail URL ({state, auditMarkdown}) for a history
// record. A workspace run (target==='workspace', projectKey="workspaces/<wkey>")
// MUST use the workspace-aware route — the /api/history/:key/:id key regex
// forbids the slashed key (would 404). The two routes share readPipelineFromDir,
// so the response shape is identical. Single-project rows are byte-identical.
function historyDetailUrl(projectDir, id, record) {
  if (record && record.target === 'workspace' && typeof record.projectKey === 'string') {
    const wksId = record.projectKey.replace(/^workspaces\//, '');
    return `/api/workspaces/${encodeURIComponent(wksId)}/runs/${encodeURIComponent(id)}`;
  }
  if (record && record.projectKey) {
    return `/api/history/${encodeURIComponent(record.projectKey)}/${encodeURIComponent(id)}`;
  }
  return `/api/runs/${encodeURIComponent(id)}?projectDir=${encodeURIComponent(projectDir)}`;
}

async function loadHistDetail(projectDir, id, detail, record) {
  try {
    const url = historyDetailUrl(projectDir, id, record);
    const res = await fetch(url);
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
    const host = detail.querySelector('.run-flow');
    if (host) buildRunGraph(host, data.state.stepper); // null stepper -> legacy default
    paintHistStepper(detail, data.state);
    // Same Map->object projection as the live call-site (see paintRunCard).
    const histSubsBar = detail.querySelector('.subs-bar');
    if (histSubsBar) paintSubsBar(histSubsBar, subsByNodeCycleArrays(data.state.subAgents), cycleAwareLabel(data.state.stepper, data.state.subAgents));
    const histAssetsBar = detail.querySelector('.assets-bar');
    if (histAssetsBar) paintAssetsPanel(histAssetsBar, data.state.assets);
    renderHistClarifyReviews(detail, data.clarify);
    if (typeof data.state.totalCostUsd === 'number') {
      const card = detail.closest('.hist-card');
      const totalEl = card && card.querySelector('.hist-total');
      if (totalEl) {
        totalEl.textContent = fmtUsd(data.state.totalCostUsd);
        totalEl.title = estTitle(data.state.totalCostUsd);
      }
    }
    if (typeof data.state.totalActiveMs === 'number') {
      const card = detail.closest('.hist-card');
      const t = card && card.querySelector('.hist-time');
      if (t) t.textContent = fmtDuration(data.state.totalActiveMs);
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

// Render the saved clarify Q&A into a history card's .hist-detail (READ-ONLY — no
// option buttons, no free-text, no submit; History is a record, not an interaction).
// The section inserts BEFORE .hist-actions so Delete stays last. Idempotent: any prior
// section is removed first (a cached re-expand must never stack duplicates). Shape comes
// straight from readPipelineExtras:
// clarify={questions:[{id,question,options,allowFreeText}], answers:[{id,question,choice}]}.
function renderHistClarifyReviews(detail, clarify) {
  if (!detail) return;
  detail.querySelectorAll('.hist-clarify').forEach((n) => n.remove());
  const anchor = detail.querySelector('.hist-actions'); // insert section before Delete

  const questions = Array.isArray(clarify && clarify.questions) ? clarify.questions : [];
  const answers = Array.isArray(clarify && clarify.answers) ? clarify.answers : [];
  if (questions.length || answers.length) {
    detail.insertBefore(buildHistClarify(questions, answers), anchor);
  }
}

// Build the read-only clarify section: each question with its chosen answer.
function buildHistClarify(questions, answers) {
  const byId = new Map(answers.map((a) => [a.id, a]));
  const sec = document.createElement('section');
  sec.className = 'hist-clarify hist-section';
  const title = document.createElement('div');
  title.className = 'hist-section-title';
  title.textContent = 'Clarifying questions';
  sec.appendChild(title);

  questions.forEach((q, i) => {
    const block = document.createElement('div');
    block.className = 'qblock';
    const qtext = document.createElement('div');
    qtext.className = 'qtext';
    const qn = document.createElement('span');
    qn.className = 'qn';
    qn.textContent = String(i + 1);
    qtext.appendChild(qn);
    qtext.appendChild(document.createTextNode(typeof q.question === 'string' ? q.question : ''));
    block.appendChild(qtext);

    const ans = byId.get(q.id);
    const aLine = document.createElement('div');
    aLine.className = 'hist-answer';
    const chosen = ans && typeof ans.choice === 'string' ? ans.choice.trim() : '';
    aLine.textContent = chosen ? `Answer: ${chosen}` : 'Answer: (none)';
    block.appendChild(aLine);
    sec.appendChild(block);
  });
  return sec;
}

// Per-node max cycle from a saved run's steps[] (history's loop-count source).
function histNodeCycle(st) {
  const out = {};
  for (const s of Array.isArray(st && st.steps) ? st.steps : []) {
    if (!s) continue;
    const key = stepBucketKey(s);
    const c = Number(s.cycle);
    if (key && Number.isFinite(c)) out[key] = Math.max(out[key] || 0, c);
  }
  return out;
}

// Tint a history card's graph from saved state. Reached cell drives coloring
// (no live events). activeId=null, live=false -> no glow/marching-ants.
function paintHistStepper(detail, st) {
  const host = detail.querySelector('.run-flow');
  if (!host) return;
  const manifest = manifestFor(st.stepper);
  const status = String(st.status || '').toLowerCase();
  const halted = status === 'stopped' || status === 'error' || status === 'aborted' || status === 'failed' || status === 'interrupted';
  const isDone = status === 'done' || status === 'complete' || status === 'completed';
  const reached = histReachedCell(manifest, st);
  const durs = durByNode(st.steps, 0, false);
  const costs = costByNode(st.steps);

  const cellOf = {};
  manifest.steps.forEach((cell, i) => cell.nodes.forEach((n) => { cellOf[n.id] = i; }));

  paintRunGraph(host, manifest, {
    statusOf: (id) => {
      const cellIdx = cellOf[id] != null ? cellOf[id] : -1;
      if (isDone) return 'done';
      if (cellIdx < reached) return 'done';
      if (cellIdx === reached) return halted ? 'stopped' : 'done';
      return 'pending';
    },
    activeId: null,
    cycles: loopCounts(manifest, histNodeCycle(st)),
    live: false,
    durText: (id) => { const d = durs[id]; return d != null ? fmtDuration(d) : ''; },
    costText: (id) => { const c = costs[id]; return c != null ? fmtUsd(c) : ''; },
    subsOf: (id) => subAgentsForNode(st, id),
  });
}

// Highest cell index the saved run reached. Uses steps[].nodeId when present
// (new runs), else the scalar phase mapped through the manifest (old runs).
function histReachedCell(manifest, st) {
  let reached = -1;
  const steps = Array.isArray(st.steps) ? st.steps : [];
  for (const s of steps) {
    const loc = locateInManifest(manifest, { nodeId: s.nodeId, phase: s.phase });
    if (loc.cellIdx > reached) reached = loc.cellIdx;
  }
  if (reached < 0 && st.phase) {
    reached = locateInManifest(manifest, { phase: st.phase }).cellIdx;
  }
  return reached;
}

function renderHistoryError(message) {
  el.history.innerHTML = '';
  el.history.appendChild(histEmpty(`Could not load history: ${message}`));
}

async function viewPipeline(projectDir, id, title, record) {
  if (!id) return;
  try {
    const url = historyDetailUrl(projectDir, id, record);
    const res = await fetch(url);
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

const PHASE_LABEL = { preflight: 'Preflight', clarify: 'Clarify', plan: 'Plan', refine: 'Refine', implement: 'Implement', review: 'Review', 'manual-checklist': 'Manual tests', 'manual-web': 'Manual web UI', done: 'Done' };

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
    case 'plan-review': return { family: 'violet', text: 'Plan Review' };
    default: return { family: 'peach', text: 'Running' };
  }
}

function buildRunCard(r) {
  const tpl = $('#run-card-tpl');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.runId = r.runId;

  // Build the graph from the run's manifest. r.stepper may be null -> legacy default.
  const stepHost = node.querySelector('.run-flow');
  if (stepHost) buildRunGraph(stepHost, r.stepper);

  const titleEl = node.querySelector('.run-title');
  if (titleEl) titleEl.textContent = r.title;
  const metaEl = node.querySelector('.rm-text');
  if (metaEl) {
    const branchTxt = r.branchFeature ? ` · ${r.branchFeature}` : '';
    metaEl.textContent = `${projectName(r.projectDir)} · started ${startedLabel(r.startedAt)}${branchTxt}`;
  }

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

// Running -> graph status per node. done if its cell is behind the frontier or
// nodeStatus says done; at the frontier: stop->stopped, pause->paused, now->active;
// else pending. terminalDone (run status 'done') forces all-done.
function runStatusOf(r, nodeId, cellIdx, terminalDone, halted) {
  if (terminalDone) return 'done';
  if (cellIdx < r.maxCellIdx) return 'done';
  if (cellIdx > r.maxCellIdx) return 'pending';
  // Frontier cell.
  const k = r.nodeStatus[nodeId];
  if (k === 'done') return 'done';
  // A halted run (stopped/error/aborted/failed) shows its frontier node as
  // stopped even if the last live phase left it 'now' — the halt arrives as a
  // bare state event with no node-level phase to mark the cell.
  if (halted) return 'stopped';
  if (k === 'stop') return 'stopped';
  if (k === 'pause') return 'paused';
  if (k === 'now') return 'active';
  return 'pending';
}

// Pill text + colour from a {nodeId: Array<{status}>} grouping. "active" =
// subs still running; a finished/historical run has none -> grey "N sub-agents".
function subsPillText(byNode) {
  const groups = byNode && typeof byNode === 'object' ? Object.values(byNode) : [];
  let spawned = 0;
  let active = 0;
  for (const list of groups) {
    if (!Array.isArray(list)) continue;
    spawned += list.length;
    for (const s of list) if (s && s.status === 'running') active += 1;
  }
  return active > 0
    ? { text: `${spawned} spawned · ${active} active`, active: true }
    : { text: `${spawned} sub-agents`, active: false };
}

// Paint the "Sub-agents" pill + (lazily) its tree panel from a by-node grouping.
// Hidden entirely when there are no sub-agents. The disclosure (aria-expanded +
// [hidden] + chevron rotate) mirrors toggleHistCard. Idempotent: the click
// handler is bound once (dataset guard), the count/text repaint every call.
function paintSubsBar(barEl, byNode, labelOf) {
  if (!barEl) return;
  const groups = byNode && typeof byNode === 'object' ? byNode : {};
  const total = Object.values(groups).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
  if (total === 0) { barEl.hidden = true; return; }
  barEl.hidden = false;

  const btn = barEl.querySelector('.btn-subs');
  const panel = barEl.querySelector('.subs-panel');
  const count = barEl.querySelector('.sb-count');
  const labelFn = typeof labelOf === 'function' ? labelOf : (id) => id;
  // Per-CARD state on the element (NOT a module-level function static) — the app
  // paints multiple concurrent run cards; a function static would bleed the most
  // recently painted card's grouping/labels into another card's open panel.
  barEl._subsGroups = groups;
  barEl._subsLabelOf = labelFn;

  const { text, active } = subsPillText(groups);
  if (count) {
    count.textContent = text;
    count.classList.toggle('grey', !active);
  }

  // Re-render an already-open panel in place so live spawns/finishes reflect immediately.
  if (panel && btn && btn.getAttribute('aria-expanded') === 'true') {
    renderSubsTree(panel, groups, labelFn);
  }

  if (btn && btn.dataset.bound !== '1') {
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      if (panel) {
        panel.hidden = open;
        if (!open) renderSubsTree(panel, barEl._subsGroups || {}, barEl._subsLabelOf);
      }
    });
  }
}

// Group rollup for a step's sub-agents: anyStop (stop|error) -> 'stop',
// else anyRun -> 'run', else 'done'. Drives the .subs-stat / .dot colour.
function subGroupStatus(list) {
  const arr = Array.isArray(list) ? list : [];
  if (arr.some((s) => s && (s.status === 'stopped' || s.status === 'error'))) return 'stop';
  if (arr.some((s) => s && s.status === 'running')) return 'run';
  return 'done';
}

// Per-sub-agent row status -> the mono badge / .led class. running -> run (lit),
// stopped|error -> stop, else done.
function subRowStatus(status) {
  if (status === 'running') return 'run';
  if (status === 'stopped' || status === 'error') return 'stop';
  return 'done';
}

// .dot colour per group status (matches the .subs-stat palette).
const SUBS_DOT_COLOR = { run: 'var(--blue)', done: 'var(--green)', stop: 'var(--red)' };
const SUBS_STAT_TEXT = { run: 'running', done: 'done', stop: 'stopped' };

// Build the tree panel body from a {nodeId: Array<{id,label,status}>} grouping.
// legend + one .subs-step per node (dot+name+status pill+count) + a .subs-tree
// <li> per sub-agent (led + name + mono status). nodeLabel(id)->display name
// (defaults to the id). Idempotent: the panel is fully rebuilt each call.
// NOTE: squares here are .sq/.led and are NEVER placed under .fan, so the
// graph-only sqPulse animation can never reach them.
function renderSubsTree(panelEl, byNode, nodeLabel) {
  if (!panelEl) return;
  const labelOf = typeof nodeLabel === 'function' ? nodeLabel : (id) => id;
  const groups = byNode && typeof byNode === 'object' ? byNode : {};
  panelEl.innerHTML =
    '<div class="subs-legend">' +
      '<span class="lk"><span class="sq on"></span>active</span>' +
      '<span class="lk"><span class="sq off"></span>finished</span>' +
    '</div>';

  for (const nodeId of Object.keys(groups)) {
    const list = Array.isArray(groups[nodeId]) ? groups[nodeId] : [];
    if (list.length === 0) continue;
    const gstat = subGroupStatus(list);
    const step = document.createElement('div');
    step.className = 'subs-step';
    step.innerHTML =
      '<div class="subs-step-head">' +
        `<span class="dot" style="background:${SUBS_DOT_COLOR[gstat]}"></span>` +
        `<b>${escapeHtml(labelOf(nodeId))}</b>` +
        `<span class="subs-stat ${gstat}">${SUBS_STAT_TEXT[gstat]}</span>` +
        `<span class="subs-n">${list.length} sub-agents</span>` +
      '</div>';
    const ul = document.createElement('ul');
    ul.className = 'subs-tree';
    for (const s of list) {
      const rstat = subRowStatus(s && s.status);
      const li = document.createElement('li');
      li.innerHTML =
        `<span class="led${rstat === 'run' ? ' on' : ''}"></span>` +
        `<span class="ag-name">${escapeHtml((s && s.label) || (s && s.id) || '')}</span>` +
        `<span class="st ${rstat}">${rstat === 'run' ? 'running' : rstat === 'stop' ? 'stopped' : 'done'}</span>`;
      ul.appendChild(li);
    }
    step.appendChild(ul);
    panelEl.appendChild(step);
  }
}

// nodeId -> display label for the tree step headers. Takes a raw stepper and
// normalizes via manifestFor ONCE (callers pass r.stepper / data.state.stepper,
// not a pre-normalized manifest — avoids a redundant double manifestFor). Falls
// back to the raw id for unknown nodes.
function nodeLabelLookup(stepper) {
  const m = manifestFor(stepper);
  const map = {};
  m.steps.forEach((cell) => cell.nodes.forEach((n) => { map[n.id] = n.label || n.id; }));
  return (id) => map[id] || id;
}

function paintStepper(r) {
  if (!r.el) return;
  const host = r.el.querySelector('.run-flow');
  if (!host) return;
  const manifest = manifestFor(r.stepper);
  const terminalDone = r.status === 'done';
  const halted = ['stopped', 'error', 'aborted', 'failed'].includes(r.status);
  const now = Date.now();
  const durs = durByNode(r.steps, now, true);
  const costs = r.costByNode || {};

  // cellIdx per node id (for the frontier comparison).
  const cellOf = {};
  manifest.steps.forEach((cell, i) => cell.nodes.forEach((n) => { cellOf[n.id] = i; }));

  // The active node = the frontier node currently now/pause (drives the live loop).
  let activeId = null;
  const frontier = manifest.steps[r.maxCellIdx];
  if (frontier && !terminalDone) {
    for (const n of frontier.nodes) {
      const k = r.nodeStatus[n.id];
      if (k === 'now' || k === 'pause') { activeId = n.id; break; }
    }
  }

  paintRunGraph(host, manifest, {
    statusOf: (id) => runStatusOf(r, id, cellOf[id] != null ? cellOf[id] : -1, terminalDone, halted),
    activeId,
    cycles: loopCounts(manifest, r.nodeCycle),
    live: true,
    durText: (id) => { const d = durs[id]; return d != null ? fmtDuration(d) : ''; },
    costText: (id) => { const c = costs[id]; return c != null ? fmtUsd(c) : ''; },
    subsOf: (id) => subAgentsForNode(r, id),
  });
}

// Does the run's current frontier cell contain a cycling node?
function currentNodeCycles(r) {
  const m = manifestFor(r.stepper);
  const cell = m.steps[r.maxCellIdx];
  return !!(cell && cell.nodes.some((n) => n.cycles));
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
    } else if (currentNodeCycles(r) && r.cycle) {
      chip.textContent = `${phaseLabel} cycle ${r.cycle}`;
    } else {
      chip.textContent = phaseLabel;
    }
  }

  paintStepper(r);
  // subsByNode returns Map<nodeId,{subs,spawned,active}>; paintSubsBar (and the
  // pill/tree helpers) consume a plain {nodeId: Array<{status}>} grouping, which
  // subsByNodeArrays projects from the Map's .subs arrays. (Plan wrote
  // subsByNode(...) directly, but that Map yields Object.values()===[] -> the bar
  // would never show; see report.)
  const subsBar = r.el.querySelector('.subs-bar');
  if (subsBar) paintSubsBar(subsBar, subsByNodeCycleArrays(r.subAgents), cycleAwareLabel(r.stepper, r.subAgents));
  const assetsBar = r.el.querySelector('.assets-bar');
  if (assetsBar) paintAssetsPanel(assetsBar, r.assets);
  const timeEl = r.el.querySelector('.run-time');
  if (timeEl) timeEl.textContent = fmtDuration(liveTotalMs(r.steps, Date.now()));
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
// Router: sidebar nav (+ responsive top-nav) toggle between the views.
// ---------------------------------------------------------------------------
const views = $$('.view');
const navLinks = $$('.nav a[data-nav], .topnav a[data-nav]');
// [v2/C1] composer is PRESERVED; workspaces + workspace-create are appended.
// workspace-create is in the array (so deep-links resolve) but has no nav link.
const VIEW_NAMES = ['new', 'running', 'history', 'composer', 'workspaces', 'workspace-create', 'settings'];

function showView(name) {
  // Leave-guard: navigating away from the wizard while a scan is live aborts the
  // scan + resets wizard state (addresses orphaned-background-request risk).
  if (currentShownView === 'workspace-create' && name !== 'workspace-create') {
    if (state.wizard.scanId || state.wizard.abort) abortWizardScan();
    resetWizard();
  }
  currentShownView = name;

  views.forEach((v) => v.classList.toggle('hidden', v.dataset.view !== name));
  navLinks.forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
  // Toggle a body flag so CSS can drop .main's top padding for the History view,
  // letting the sticky pills toolbar + project headers pin flush to the top.
  document.body.classList.toggle('view-history', name === 'history');
  if (name === 'running') renderRunningView();
  if (name === 'history') loadHistoryView();
  if (name === 'workspaces') loadWorkspacesView();
  if (name === 'workspace-create') enterWizard();
  if (name === 'composer') initComposer();
  if (name === 'settings') loadSettings();
}
// Tracks the currently shown view so the leave-guard can fire on transition.
let currentShownView = null;

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
// Live timer: tick running cards once a second so timers advance without events.
// ---------------------------------------------------------------------------
const _timerTick = setInterval(() => {
  for (const r of runs.values()) {
    const active = r.status === 'running' || r.status === 'starting';
    const paused = r.pendingQuestion != null;
    if (!active || paused || !r.el) continue;
    const now = Date.now();
    const timeEl = r.el.querySelector('.run-time');
    if (timeEl) timeEl.textContent = fmtDuration(liveTotalMs(r.steps, now));
    const durs = durByNode(r.steps, now, true);
    for (const el of r.el.querySelectorAll('.run-node[data-id]')) {
      const durEl = el.querySelector('.dur');
      if (!durEl) continue;
      const d = durs[el.dataset.id];
      durEl.textContent = d != null ? fmtDuration(d) : '';
    }
  }
}, 1000);
// In a real browser, setInterval returns a numeric id and this timer simply runs
// for the page's lifetime. Under node:test the jsdom harness imports THIS module,
// where bare `setInterval` resolves to Node's global and returns a Timeout that
// would keep the event loop open and hang the test process. unref() — guarded
// because the browser's numeric id has no such method — lets the test subprocess
// exit cleanly with zero effect on browser behaviour.
if (_timerTick && typeof _timerTick.unref === 'function') _timerTick.unref();

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
syncSourceToggle();
setWsStatus(false);
loadProjects();
connectWS();
// Restore the New-Pipeline target (project | workspace). 'workspace' lazy-loads
// the workspace options + re-points the config panel; 'project' is the default.
const bootTarget = localStorage.getItem(LAST_TARGET_KEY) === 'workspace' ? 'workspace' : 'project';
if (bootTarget === 'workspace') setRunTarget('workspace');
const bootHash = location.hash.slice(1);
showView(VIEW_NAMES.includes(bootHash) ? bootHash : 'new');
updateNavCounts();
