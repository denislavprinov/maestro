// Phase-1 API: the ONLY src/core addition. Wraps the orchestrator behind a tiny
// onboarding-only surface and derives the readiness stream the engine omits.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOrchestrator } from './orchestrator.mjs';
import { writeWorkflow } from './workflows.mjs';
import { validateWorkflow } from './workflow-validator.mjs';
import { loadAgentRegistry } from './agent-registry.mjs';

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

export async function runOnboarding({ projectDir, answers = {}, title = ENABLE_TITLE, mock = false, branch } = {}) {
  if (!projectDir) throw new Error('runOnboarding: projectDir is required');

  // 1. validate + seed wf_enable (idempotent). reg mirrors
  //    test/workflow-onboarding-topology.test.mjs.
  const reg = loadAgentRegistry(undefined, { userAgentsDir: null });
  const v = validateWorkflow(ENABLE_WORKFLOW, reg);
  if (!v.ok) throw new Error(`wf_enable invalid: ${v.errors.join('; ')}`);
  await writeWorkflow(ENABLE_WORKFLOW);                // async upsert

  // 2. orchestrator pinned to wf_enable + Enable title (branch derives from title).
  const orch = createOrchestrator({
    projectDir,
    workflowId: ENABLE_WORKFLOW_ID,
    title,
    branch: branch || { source: null, feature: null }, // feature:null -> derived from title (safe)
    claude: { permissionMode: 'acceptEdits', mock },
  });

  const events = new EventEmitter();
  const runId = randomUUID();

  // forward raw engine events verbatim (renderer/server consume these too)
  for (const name of ['state', 'phase', 'question', 'artifact', 'log', 'done', 'error']) {
    orch.on(name, (p) => events.emit(name, p));
  }

  // 3. answer every gate deterministically (D4). Clarify answers come from
  //    `answers` keyed by question id; engine fills any omitted id with its
  //    first option (normalizeClarifyAnswer), so unknown ids never throw.
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

  // 4. derive readiness from canonical files on phase-done boundaries (D5).
  //    pipelineDir is set on state at orchestrator.mjs:411 (before dispatch), so
  //    it is readable inside these mid-run phase listeners.
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

  // 5. run, then emit final readiness + resolve summary.
  const done = (async () => {
    const result = await orch.run();
    const dir = result.pipelineDir;
    const readiness = dir ? readFinalReadiness(dir) : null;
    events.emit('readiness', {
      kind: 'final',
      score: readiness?.score ?? null,
      baselineScore: readiness?.baselineScore ?? null,
      delta: readiness?.delta ?? null,
      dimensions: readiness?.dimensions ?? {},
      gaps: readiness?.gaps ?? [],
    });
    return { status: result.status, branch: orch.getState().branch?.feature ?? null, readiness };
  })();

  return { runId, events, done, orch };               // orch exposed for the server's answer route
}
