// Phase-1 API: the ONLY src/core addition. Wraps the orchestrator behind a tiny
// onboarding-only surface and derives the readiness stream the engine omits.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOrchestrator } from './orchestrator.mjs';
import { writeWorkflow } from './workflows.mjs';
import { validateWorkflow } from './workflow-validator.mjs';
import { loadAgentRegistry } from './agent-registry.mjs';
import { readPipelineForResume, readStoreMeta } from './artifacts.mjs';

export const ENABLE_WORKFLOW_ID = 'wf_enable';
export const ENABLE_TITLE = 'Enable project for AI';

export const ENABLE_WORKFLOW = Object.freeze({
  id: ENABLE_WORKFLOW_ID,
  name: ENABLE_TITLE,
  domain: 'coding',
  steps: [
    [{ id: 's_clarify', key: 'enableClarifier' }],   // NEW deterministic clarifier
    [{ id: 's_analyze', key: 'onboardingAnalyzer' }], // reused
    [{ id: 's_infra',   key: 'projectOnboarding' }],  // reused
    [{ id: 's_tests',   key: 'onboardingTests' }],    // reused
    [{ id: 's_eval',    key: 'onboardingEvaluator' }],// reused
    [{ id: 's_canary',  key: 'onboardingCanary' }],   // reused
  ],
  feedbacks: [{ id: 'fb_eval', from: 's_eval', to: 's_infra' }], // resolveWorkflow adds gate:'hasBlocking'
});

export const ENABLE_QUESTION_IDS = Object.freeze([
  'testTier', 'vendoringDepth', 'multiToolTargets', 'canary', 'scopeConstraints',
]);

// dimension key -> friendly label (renderer + tests share this)
export const DIMENSION_LABELS = Object.freeze({
  docs: 'Documentation', skillsAgents: 'Custom skills', rules: 'Guardrails',
  tests: 'Test setup', featureSkillCoverage: 'Key-workflow coverage',
  realTests: 'Working tests', vendoring: 'Bundled skills',
  multiTool: 'Cross-tool support', codeHealth: 'Code health',
});

const MULTITOOL_FILE_MAP = Object.freeze({
  claude: 'CLAUDE.md', cursor: '.cursor/rules',
  copilot: '.github/copilot-instructions.md', agents: 'AGENTS.md',
});

// D6: UI multi-select (label keys) -> joined free-text file list reaching the engine.
export function joinMultiToolTargets(selection) {
  if (selection == null) return undefined;
  if (typeof selection === 'string') return selection; // already free text
  const files = selection.map((s) => MULTITOOL_FILE_MAP[String(s).toLowerCase()] || s);
  if (!files.includes('CLAUDE.md')) files.unshift('CLAUDE.md'); // Claude locked
  return [...new Set(files)].join(', ');
}

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function readBaselineReadiness(pipelineDir) {
  const g = readJsonSafe(join(pipelineDir, 'graph-summary.json'));
  const b = g && g.baselineReadiness;                 // top-level (analyzer.md:58)
  if (!b || typeof b.score !== 'number') return null;
  return { score: b.score, dimensions: b.dimensions || null };
}

export function readCycleScore(pipelineDir, cycle) {
  const r = readJsonSafe(join(pipelineDir, `onboardingEvaluator-review-cycle${cycle}.json`));
  return r && typeof r.score === 'number' ? r.score : null;
}

export function readFinalReadiness(pipelineDir) {
  const r = readJsonSafe(join(pipelineDir, 'readiness.json'));
  if (!r || typeof r.score !== 'number') return null;
  return {
    score: r.score,
    baselineScore: typeof r.baselineScore === 'number' ? r.baselineScore : null,
    delta: typeof r.delta === 'number' ? r.delta : null,
    dimensions: r.dimensions || {},
    gaps: Array.isArray(r.gaps) ? r.gaps : [],
  };
}

// phase event identifies a node by nodeId (workflow node id) primarily; the phase
// string (uiPhase||key) is a defensive fallback for the legacy _phase path.
function matchNode(ev, nodeId, key) {
  return ev.nodeId === nodeId || ev.phase === key || ev.phase === nodeId;
}

// 3. answer gates deterministically (D4). Clarify answers come from `answers`
//    keyed by question id; engine fills any omitted id with its first option
//    (normalizeClarifyAnswer), so unknown ids never throw. With `interactive`,
//    gate/recovery questions are left pending for the UI (POST /api/enable/answer);
//    clarify stays auto-answered — the set-up screen already collected it.
export function wireGateAnswers(orch, events, { answers = {}, interactive = false } = {}) {
  const supplied = { ...answers };
  if (supplied.multiToolTargets != null) {
    supplied.multiToolTargets = joinMultiToolTargets(supplied.multiToolTargets);
  }
  orch.on('question', (q) => {
    // _ask emits 'question' BEFORE it sets this.pendingQuestion (orchestrator.mjs
    // :1777 vs :1799). _emit is synchronous, so answering inline would hit a null
    // pendingQuestion and be ignored, hanging the run. Defer to a microtask: by
    // the time it runs, the synchronous _ask body has set pendingQuestion.
    queueMicrotask(() => {
      try {
        if (q.kind === 'clarify') {
          const ans = (q.questions || [])
            .map((qq) => ({ id: qq.id, choice: supplied[qq.id] }))
            .filter((a) => a.choice != null && a.choice !== '');
          orch.answer(q.id, { answers: ans });
        } else if (interactive) {
          // user decides in the UI
        } else if (q.kind === 'gate') {
          orch.answer(q.id, { decision: 'continue' });   // refine unattended
        } else if (q.kind === 'recovery') {
          orch.answer(q.id, { decision: 'abort' });       // surface terminal error
        }
      } catch (err) {
        events.emit('log', { source: 'onboarding', level: 'warn', text: `answer failed: ${err.message}` });
      }
    });
  });
}

// Shared wiring for fresh and resumed Enable runs: event forwarding, gate
// answering, readiness derivation, and the done-promise. `kick` starts the
// engine (run() or resume()); `replayDir`, when set, re-emits readiness already
// on disk so a resumed/reconnecting UI gets its ring state back.
function wireOnboardingRun(orch, { answers = {}, interactive = false, kick, replayDir = null, persistMode = null } = {}) {
  const events = new EventEmitter();
  const runId = randomUUID();

  // Stamp the run's mode into its store dir on the FIRST event that carries a
  // pipelineDir (state fires before dispatch), so even a run paused before its
  // first step completes knows how to resume. Written once, never overwritten.
  if (persistMode) {
    let stamped = false;
    const stamp = () => {
      if (stamped) return;
      const dir = orch.getState().pipelineDir;
      if (!dir) return;
      stamped = true;
      try {
        const p = join(dir, 'run-mode.json');
        if (!existsSync(p)) writeFileSync(p, JSON.stringify(persistMode));
      } catch { /* mode falls back to real on resume */ }
    };
    orch.on('state', stamp);
    orch.on('phase', stamp);
  }

  // forward raw engine events verbatim (renderer/server consume these too)
  for (const name of ['state', 'phase', 'question', 'artifact', 'log', 'done', 'error']) {
    orch.on(name, (p) => events.emit(name, p));
  }

  wireGateAnswers(orch, events, { answers, interactive });

  // derive readiness from canonical files on phase-done boundaries (D5).
  // pipelineDir is set on state at orchestrator.mjs:411 (before dispatch), so
  // it is readable inside these mid-run phase listeners.
  let baselineEmitted = false;
  const cyclesEmitted = new Set();
  orch.on('phase', (ev) => {
    if (ev.status !== 'done') return;
    const dir = orch.getState().pipelineDir;
    if (!dir) return;
    if (!baselineEmitted && matchNode(ev, 's_analyze', 'onboardingAnalyzer')) {
      baselineEmitted = true;
      const b = readBaselineReadiness(dir);
      events.emit('readiness', { kind: 'baseline', score: b?.score ?? null, dimensions: b?.dimensions ?? null });
    }
    if (matchNode(ev, 's_eval', 'onboardingEvaluator')) {
      const cycle = ev.cycle || 1;
      if (!cyclesEmitted.has(cycle)) {
        cyclesEmitted.add(cycle);
        events.emit('readiness', { kind: 'cycle', cycle, score: readCycleScore(dir, cycle) });
      }
    }
  });

  // re-emit readiness a prior lifetime of this pipeline already produced, and
  // seed the dedup state so the live listeners above don't double-emit.
  const replayReadiness = (dir) => {
    const b = readBaselineReadiness(dir);
    if (b) {
      baselineEmitted = true;
      events.emit('readiness', { kind: 'baseline', score: b.score, dimensions: b.dimensions });
    }
    for (let c = 1; ; c++) {
      const s = readCycleScore(dir, c);
      if (s == null) break;
      cyclesEmitted.add(c);
      events.emit('readiness', { kind: 'cycle', cycle: c, score: s });
    }
  };

  // run, then emit final readiness + resolve summary. The setImmediate lets the
  // caller attach its events listeners (a microtask-continuation of our return)
  // before the replay frames fire — otherwise they'd be emitted into silence.
  const done = (async () => {
    await new Promise((r) => setImmediate(r));
    if (replayDir) replayReadiness(replayDir);
    const result = await kick();
    const dir = result.pipelineDir;
    const readiness = dir ? readFinalReadiness(dir) : null;
    const feature = orch.getState().branch?.feature ?? null;
    // A paused run is NOT final: emitting kind:'final' here would flip the
    // renderer to the results screen right before the paused banner shows.
    if (result.status !== 'paused') {
      events.emit('readiness', {
        kind: 'final',
        score: readiness?.score ?? null,
        baselineScore: readiness?.baselineScore ?? null,
        delta: readiness?.delta ?? null,
        dimensions: readiness?.dimensions ?? {},
        gaps: readiness?.gaps ?? [],
        branch: feature,                     // results screen renders this
      });
    }
    return { status: result.status, branch: feature, readiness };
  })();

  return { runId, events, done, orch };               // orch exposed for the server's answer route
}

export async function runOnboarding({ projectDir, workspace, answers = {}, title = ENABLE_TITLE, mock = false, branch, interactive = false } = {}) {
  if (!projectDir && !workspace) throw new Error('runOnboarding: projectDir or workspace is required');
  if (projectDir && workspace) throw new Error('runOnboarding: provide projectDir or workspace, not both');

  // 1. validate + seed wf_enable (idempotent). reg mirrors
  //    test/workflow-onboarding-topology.test.mjs.
  const reg = loadAgentRegistry(undefined, { userAgentsDir: null });
  const v = validateWorkflow(ENABLE_WORKFLOW, reg);
  if (!v.ok) throw new Error(`wf_enable invalid: ${v.errors.join('; ')}`);
  await writeWorkflow(ENABLE_WORKFLOW);                // async upsert

  // 2. orchestrator pinned to wf_enable + Enable title (branch derives from title).
  const orch = createOrchestrator({
    ...(workspace ? { workspace } : { projectDir }),
    workflowId: ENABLE_WORKFLOW_ID,
    title,
    branch: branch || { source: null, feature: null }, // feature:null -> derived from title (safe)
    claude: { permissionMode: 'acceptEdits', mock },
  });

  return wireOnboardingRun(orch, {
    answers, interactive, kick: () => orch.run(),
    persistMode: { mock: !!mock, interactive: !!interactive },
  });
}

// Run mode is a property of the RUN, not the caller: a paused real pipeline
// must resume with real runners (and a mock one with mock runners) no matter
// what a UI toggle happens to say. Mode is persisted as run-mode.json in the
// pipeline store dir at run start — sessions can't be used to infer it (a run
// paused before its first step records one has nothing to infer from, and
// non-claude steps record real-format ids even in mock runs).
export function readRunMode(pipelineDir) {
  if (!pipelineDir) return null;
  const m = readJsonSafe(join(pipelineDir, 'run-mode.json'));
  return m && typeof m.mock === 'boolean' ? m : null;
}

// Resume a paused/interrupted Enable pipeline (manual pause or session-limit
// auto-pause) with the SAME event wiring as a fresh run. Project dir resolves
// via store_meta — Enable projects are not in the projects registry table.
// `mock` left unset -> inferred from the run's own step sessions (see above).
export async function resumeOnboarding({ pipelineId, interactive = false, mock, answers = {} } = {}) {
  if (!pipelineId) throw new Error('resumeOnboarding: pipelineId is required');
  const saved = readPipelineForResume(pipelineId);
  if (!saved) {
    const e = new Error('pipeline not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  const { row, resumePoint } = saved;
  if (row.title !== ENABLE_TITLE) throw new Error(`not an Enable run: "${row.title ?? row.id}"`);
  if (row.status !== 'paused' && row.status !== 'interrupted') {
    throw new Error(`pipeline is "${row.status}", not resumable`);
  }
  if (!resumePoint) throw new Error('pipeline has no resume point');

  let branch = null;
  try { branch = row.branch ? JSON.parse(row.branch) : null; } catch {}
  if (branch?.worktreeDir && !existsSync(branch.worktreeDir)) {
    throw new Error(`worktree missing: ${branch.worktreeDir}`);
  }

  // Resolve projectDir: workspace runs carry their member set in workspace_meta
  // (mirrors ui/server.mjs's /api/run/resume arm); single-project runs map
  // project_key back through store_meta.
  let projectDir = null;
  let workspace;
  if (row.target === 'workspace' && row.workspace_meta) {
    const meta = JSON.parse(row.workspace_meta);
    const projects = (meta.projects || []).map((p) => ({ ...p }));
    if (!projects.length) throw new Error('workspace metadata incomplete');
    projectDir = projects[0].projectDir;
    workspace = {
      id: meta.workspaceId, key: row.workspace_key, name: meta.workspaceName,
      description: meta.workspaceDescription || '', projects,
    };
  } else {
    projectDir = readStoreMeta(row.project_key)?.path ?? null;
  }
  if (!projectDir || !existsSync(projectDir)) {
    throw new Error('project directory for this run no longer exists on this machine');
  }

  const useMock = typeof mock === 'boolean' ? mock
    : (readRunMode(resumePoint.pipelineDir)?.mock ?? false);   // legacy runs without the file resume real
  const orch = createOrchestrator({
    projectDir,
    ...(workspace ? { workspace } : {}),
    resume: saved,
    claude: { permissionMode: 'acceptEdits', mock: useMock },
  });
  return {
    ...wireOnboardingRun(orch, {
      answers, interactive,
      kick: () => orch.resume(),
      replayDir: resumePoint.pipelineDir || null,
    }),
    pipelineId,
  };
}
