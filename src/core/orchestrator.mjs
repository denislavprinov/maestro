// src/core/orchestrator.mjs
// The deterministic state machine that sequences the whole pipeline:
//
//   preflight
//     -> ensure git repo + checkpoint
//     -> planner clarify       (single round; ask up to four questions, or none)
//     -> planner plan
//     -> refine loop           (refiner; stop when no blocking; gate past max)
//     -> implementer (implement)
//     -> review loop           (reviewer; fix; stop when no blocking; gate past max)
//     -> done
//
// It is an EventEmitter. Consumers (CLI, UI) subscribe to events and drive
// interaction via answer()/stop(). Pending questions are modeled as promises
// that resolve when answer(id, payload) is called (or immediately when auto).

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { join, basename, resolve, dirname, sep, relative } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile, readdir, mkdir, realpath } from 'node:fs/promises';

import { generateTitle } from './title.mjs';
import {
  createPipeline,
  updatePipelineTitle,
  appendAudit,
  writeState,
  artifactPaths,
  planPath,
  slugify,
  today,
  recordArtifact,
  upsertSubAgent,
  writeClarify,
  writeReview,
  reviewKindOf,
  writeDecomposition,
  updateTaskStatus,
  updatePhaseStatus,
  readPipelineExtras,
  claimPipelineOwnership,
  touchHeartbeat,
  clearPipelineOwnership,
  HEARTBEAT_INTERVAL_MS,
  writeStepQuestions,
  readStepQuestions,
} from './artifacts.mjs';
import { diffNameStatus, diffNumstat, diffPatch } from './git-info.mjs';
import { assembleResults, persistResults, persistDiffPatch, buildPerProject, rollupSummary } from './results.mjs';
import { projectKey, projectStorePath, workspaceStorePath } from './store.mjs';
import { createRunLogWriter, RUN_LOG_FILE, RUN_LOG_KIND } from './run-log.mjs';
import { detectTools, detectToolsPerProject, runGraphifyUpdate, worktreeGraphInstruction } from './preflight.mjs';
import { fanoutCap, mapWithCap } from './fanout.mjs';
import { resolveStepModels } from './config.mjs';
import { hasBlocking, blockingIssues, readQuestionsFile } from './protocol.mjs';
import { runClarify } from './phases.mjs';
import { runners as defaultRunners } from './runners.mjs';
import { classifyError } from './recoverable-error.mjs';
import { resolveWorkflow, buildStepperManifest, rewriteStepperForDecomposition } from './workflows.mjs';
import { allocate, bindInputs, publish, legacyFields, entrySeedChannels, renderPromptArtifact } from './channels.mjs';
import { loadAgentRegistry, collectChannelDefs } from './agent-registry.mjs';
import { collectRequiredSkills, validateSkills, injectSkills } from './skills.mjs';
import { validateWorkflow } from './workflow-validator.mjs';
import {
  createWorktree, removeWorktree, suggestBranchName, sanitizeBranchName, resolveDefaultBranch,
  isValidSourceRef,
} from './worktree.mjs';

/**
 * Default location of the agent prompt markdown files, relative to this module.
 */
const DEFAULT_AGENTS_DIR = new URL('../../agents/', import.meta.url).pathname;
const REPO_ROOT = new URL('../../', import.meta.url).pathname; // maestro repo root; holds skills/

/**
 * Node keys that fan out across member projects on a workspace run (§5.6 / C4).
 * The orchestrator forces `node.fanOut=true` on these when isWorkspace, unlocking
 * the Task/Agent tool via effectiveAllowedTools. NOTE the set lists
 * `workspaceReviewer`, NOT `reviewer`: on a workspace run the review node is
 * substituted to `workspaceReviewer` (the synthesizer) at resolve time
 * (workflows.mjs, gated on isWorkspace), so it IS in this set and gets
 * fanOut=true here. `reviewer` never appears in a workspace plan — it is the
 * single-project review node only.
 */
const FANOUT_ELIGIBLE = new Set([
  'planner', 'refiner', 'implementer', 'planReviewer', 'workspaceReviewer',
]);

/** Max auto-mode retries for a recoverable error before falling back to status error. */
const RECOVERY_MAX_AUTO_ATTEMPTS = (() => {
  const n = Number(process.env.MAESTRO_RECOVERY_MAX_ATTEMPTS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
})();

/** Max ask-then-resume question rounds per node run (spec 2026-07-11 §5). */
const MAX_QUESTION_ROUNDS = 3;

/**
 * Build the synthetic implementer node for one decomposed task. Pure (exported for
 * tests). `siblings` carries the OTHER tasks of the same phase so the implementer
 * prompt can warn about the shared working tree (see implementerBody).
 * @param {{model?:string,effort?:string,tools?:string[],fanOut?:boolean}} implNode the original implementer node
 * @param {{id:string,nodeId:string,title?:string,file?:string}} task
 * @param {Array<{id:string,title?:string,file?:string}>} phaseTasks all tasks of the task's phase
 * @param {string} pipelineDir
 */
export function decomposedTaskNode(implNode, task, phaseTasks, pipelineDir) {
  return {
    nodeId: task.nodeId,
    key: 'implementer',
    uiPhase: 'implement',
    runnerType: 'producer',
    decomposedTask: true,
    model: implNode.model,
    effort: implNode.effort,
    tools: implNode.tools,
    fanOut: implNode.fanOut, // inherit so each per-task implementer fans out when the run does
    askQuestions: false,     // parallel task shards never gate the user (spec §5)
    taskPath: join(pipelineDir, task.file || ''),
    siblings: (Array.isArray(phaseTasks) ? phaseTasks : [])
      .filter((t) => t && t !== task)
      .map((t) => ({ id: t.id, title: t.title, file: t.file })),
    produces: ['code'],
    consumes: ['plan'],
  };
}

/**
 * Create an orchestrator instance.
 *
 * @param {object} opts
 * @param {string} opts.projectDir
 * @param {string} [opts.prompt]
 * @param {string} [opts.promptFile]
 * @param {string[]} [opts.extras]
 * @param {string} [opts.title]
 * @param {object} [opts.claude]  { bin?, permissionMode="acceptEdits", model?, mock? }
 * @param {string} [opts.agentsDir]
 * @param {string} [opts.pipelineId]
 * @param {boolean} [opts.auto]   non-interactive: clarify->first option, gate->continue
 * @returns {Orchestrator}
 */
export function createOrchestrator(opts = {}) {
  return new Orchestrator(opts);
}

class Orchestrator extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts || {};

    // ── Workspace mode (opt-in; absent => single-project, every path unchanged) ──
    // A workspace run targets 2+ member projects (sorted by projectKey). The scalar
    // projectDir/workDir below point at the PRIMARY (members[0]) so every existing
    // call site that reads them keeps working; per-project data lives in the maps.
    this.workspace = this.opts.workspace || null;
    this.isWorkspace = !!this.workspace;
    this.workspaceKey = this.workspace?.key || null;
    this.members = Array.isArray(this.workspace?.projects)
      ? this.workspace.projects
          .slice()
          .sort((a, b) => (a.projectKey < b.projectKey ? -1 : a.projectKey > b.projectKey ? 1 : 0))
      : [];
    this.memberByKey = new Map(this.members.map((m) => [m.projectKey, m]));
    this.workDirs = new Map();         // projectKey -> worktree checkout dir
    this.checkpointRefs = {};          // projectKey -> pre-run commit
    this.branchInfos = new Map();      // projectKey -> createWorktree() result
    this.toolInstructions = new Map(); // projectKey -> per-project graph instruction
    this.workspaceDescription = '';    // frozen at run start (after createPipeline)

    // primaryCwd: the lowest-projectKey member in workspace mode, else the scalar
    // projectDir. resolve() keeps the single-project behavior byte-identical.
    this.projectDir = this.isWorkspace
      ? resolve(this.members[0].projectDir)
      : resolve(this.opts.projectDir || process.cwd());
    this.claude = {
      bin: this.opts.claude?.bin,
      permissionMode: this.opts.claude?.permissionMode || 'acceptEdits',
      model: this.opts.claude?.model,
      mock: !!this.opts.claude?.mock,
    };
    this.agentsDir = this.opts.agentsDir || DEFAULT_AGENTS_DIR;
    this.auto = !!this.opts.auto;
    this.stepModels = null; // { planner:{model,effort}, refiner:{...}, ... } | null until run()
    // Which saved workflow topology to run (default reproduces today's pipeline) and
    // the runner registry the dispatcher consults (overridable for tests).
    this.workflowId = this.opts.workflowId || 'wf_default';
    // Clarify needs orchestrator state (this._ask / this._writeClarifyAnswers), so it is a
    // bound runner rather than a pure runners.mjs entry. Put it first so opts.runners may
    // still override it in tests.
    this._runners = { clarifier: (ctx) => this._runClarifyNode(ctx), ...(this.opts.runners || defaultRunners) };

    // Worktree isolation: workDir is the per-pipeline checkout. Until
    // _setupWorktree() runs, it mirrors projectDir so the existing tests/paths
    // (dispatcher tests that bypass run()) behave identically.
    this.workDir = this.projectDir;
    this.branchOpts = {
      source: (this.opts.branch && this.opts.branch.source) || null,
      feature: (this.opts.branch && this.opts.branch.feature) || null,
    };
    this.branchInfo = null;

    this.abort = new AbortController();
    this.pauseRequested = false;
    this.pauseAbort = new AbortController(); // aborts ONLY node children on pause
    this.pauseReason = null;                 // set when a session/usage limit forces the pause
    this._pauseGate = null;                  // gate context snapshot when paused at a gate
    this._resumeNodeSessions = null;         // nodeId -> sessionId map, set by resume() (Task 5)
    this.resumeOpts = this.opts.resume || null; // { row, resumePoint, steps } from readPipelineForResume
    this.pendingQuestion = null; // { id, resolve, reject, kind }
    this._recovery = null;      // class -> in-flight Promise<'retry'|'abort'> (same-class dedupe)
    this._askTail = null;       // serializes _ask: ONE prompt open at a time (recovery + step questions)
    this._recoverySeq = 0;      // monotonic id source for recovery prompts (determinism-safe)
    this.agentPrompts = null;
    this.toolInstruction = '';
    // Cap for the in-worktree graphify build (macOS has no timeout(1)).
    // Resolution order: constructor option → MAESTRO_GRAPH_TIMEOUT_MS env → 120s.
    const _gt = Number(this.opts.graphBuildTimeoutMs ?? process.env.MAESTRO_GRAPH_TIMEOUT_MS);
    this.graphBuildTimeoutMs = Number.isFinite(_gt) && _gt > 0 ? _gt : 120000;
    this.checkpointRef = null;
    this.registry = null; // ▲ v3: set in run(); used by _dispatch's D4 validation
    this.extrasFiles = []; // attached files copied into <pipeline>/extras (set in _dispatch)
    this.pipeline = null; // { id, dir, promptText }
    this.logWriter = createRunLogWriter(); // buffered NDJSON persistence of the `log` stream
    this.baseName = null;
    this.planDatePrefix = null; // DD-MM-YY captured once so -vN versions share it

    // Sub-agent live-log labels: parent_tool_use_id -> label shown after "▸".
    // Tool-use ids are unique per claude process, so entries never collide across
    // runs/cycles; bounded by the number of sub-agents in a pipeline, so no reset.
    this._subAgentLabels = new Map();
    // Monotonic ordinal for sub-agents whose Task description was never captured,
    // so their fallback tag (sub-agent-N) is an honest "Nth undescribed sub-agent",
    // independent of how many described sub-agents share the map.
    this._subAgentFallbackSeq = 0;

    this.state = {
      id: this.opts.pipelineId || null,
      title: this.opts.title || null,
      projectDir: this.projectDir,
      status: 'idle',
      phase: 'idle',
      cycle: 0,
      startedAt: null,
      updatedAt: null,
      steps: [],
      stepper: null, // UI stepper manifest, snapshotted at run start (Task 2)
      tools: null,
      checkpointRef: null,
      pipelineDir: null,
      totalCostUsd: 0,  // cumulative actual spend (sum of steps[].costUsd)
      totalActiveMs: 0, // cumulative active processing time (sum of steps[].activeMs)
      branch: null,     // { source, feature, worktreeDir, reusedExisting } after _setupWorktree
      // Sub-agent lifecycle records (rides the existing `state` snapshot; mirrored to
      // the sub_agents table). Each: { id, label, nodeId, stepIndex, cycle, stepKey,
      // status, startedAt, finishedAt, durationMs?, tokens?, costUsd? };
      // status ∈ 'running'|'finished'|'error'|'stopped'.
      subAgents: [],
    };
  }

  /** @returns {object} a deep-ish snapshot of current state. */
  getState() {
    return JSON.parse(JSON.stringify(this.state));
  }

  // ── public control ─────────────────────────────────────────────────────────

  /**
   * Resolve a pending question.
   * @param {string} id
   * @param {object} payload clarify: {answers:[{id,choice}]} ; gate: {decision}
   */
  answer(id, payload) {
    const pq = this.pendingQuestion;
    if (!pq || pq.id !== id) {
      this._log('orchestrator', 'warn', `answer() ignored: no pending question with id ${id}`);
      return false;
    }
    this.pendingQuestion = null;
    pq.resolve(payload);
    return true;
  }

  /** Abort the run; marks state stopped and kills any child via the signal. */
  stop() {
    if (this.state.status === 'done' || this.state.status === 'stopped') return;
    this._setStatus('stopped');
    try {
      this.abort.abort();
    } catch {
      /* ignore */
    }
    // Unblock any awaiting question.
    if (this.pendingQuestion) {
      const pq = this.pendingQuestion;
      this.pendingQuestion = null;
      const err = new Error('stopped');
      err.name = 'AbortError';
      pq.reject(err);
    }
  }

  /**
   * Gracefully pause the run: kill in-flight node children (SIGTERM via the
   * pause-only signal), unwind _dispatch, persist a resume point. The worktree is
   * kept. Returns false unless the run is currently 'running'.
   */
  pause() {
    if (this.state.status !== 'running') return false;
    this.pauseRequested = true;
    this._setStatus('pausing');
    try {
      this.pauseAbort.abort();
    } catch {
      /* ignore */
    }
    // Unblock any awaiting clarify/gate question with the pause sentinel.
    if (this.pendingQuestion) {
      const pq = this.pendingQuestion;
      this.pendingQuestion = null;
      pq.reject(pauseErr());
    }
    return true;
  }

  _checkPause() {
    if (this.pauseRequested) throw pauseErr();
  }

  // ── main run ─────────────────────────────────────────────────────────────────

  /**
   * Execute the full pipeline. Resolves with { status, pipelineDir } on success
   * or stop; rejects only on unexpected internal errors (it emits 'error' too).
   */
  async run() {
    try {
      this.state.startedAt = new Date().toISOString();
      this._setStatus('running');

      // Resolve the workflow topology + per-node run-config and snapshot the UI
      // stepper manifest BEFORE any blocking work (preflight/clarify). It depends
      // only on workflowId + run-config + registry — none of clarify's output — so
      // Running/History render the right nodes (and per-node model·effort) at once
      // instead of the legacy default until clarify ends. resolveWorkflow reads
      // projectDir (NOT the pipeline dir, which doesn't exist yet), so this is safe
      // here. pipelineDir is null in this first event; it is persisted + re-emitted
      // after createPipeline below.
      const registry = loadAgentRegistry(this.agentsDir);
      this.registry = registry; // ▲ v3: expose for run-start workflow validation (D4)
      this.channelDefs = collectChannelDefs(registry); // custom-channel kind/filename for allocate()
      // [C5/M4] On a workspace run, resolveWorkflow substitutes the review node's key
      // reviewer -> workspaceReviewer (the fan-out synthesizer). Single-project runs
      // pass isWorkspace:false, so the resolved plan is byte-identical to today.
      const plan = await resolveWorkflow(this.projectDir, this.workflowId, registry, undefined, {
        isWorkspace: this.isWorkspace,
      });
      // Workspace fan-out forcing (§5.5, C4): the ONLY in-orchestrator topology change a
      // workspace run makes — force fanOut=true on the eligible nodes so they fan out
      // across member projects. Applied right after resolveWorkflow; absent isWorkspace
      // the plan is untouched. workspaceReviewer is now the resolved review node key
      // (substituted in workflows.mjs above), so the review fan-out is forced here.
      if (this.isWorkspace) {
        for (const group of plan.steps) {
          for (const node of group) {
            if (FANOUT_ELIGIBLE.has(node.key)) node.fanOut = true;
          }
        }
      }
      this.state.stepper = buildStepperManifest(plan, registry);
      this._emit('state', this.getState());

      // 1) Load agent prompts + preflight tool detection (parallel; both safe).
      this._phase('preflight', 0, 'start');
      const [agentPrompts, tools, stepModels] = await Promise.all([
        this._loadAgentPrompts(),
        detectTools(this.projectDir),
        resolveStepModels(this.projectDir, this.claude.model), // never throws
      ]);
      this.agentPrompts = agentPrompts;
      this.toolInstruction = tools.instruction || '';
      this.state.tools = tools;
      this.stepModels = stepModels;
      this._log(
        'preflight',
        'info',
        tools.tool
          ? `Detected tool: ${tools.tool}${tools.kind ? ` (${tools.kind})` : ''}`
          : 'No knowledge-graph tooling detected',
      );

      // 2) Create the pipeline directory + audit. On a workspace run the pipeline is
      // written to the WORKSPACE store (artifactPaths routes by workspaceKey),
      // state.json carries the §5.2 superset, and workspace-description.md is frozen
      // (capped at 2000) — all owned by createPipeline (M1). Absent the workspace
      // opts the single-project call is byte-identical.
      this.pipeline = await createPipeline(this.projectDir, {
        prompt: this.opts.prompt,
        promptFile: this.opts.promptFile,
        extras: this.opts.extras,
        title: this.opts.title,
        ...(this.isWorkspace ? {
          workspaceKey: this.workspaceKey,
          workspaceId: this.workspace.id,
          workspaceName: this.workspace.name,
          workspaceDescription: this.workspace.description || '',
          projects: this.members.map((m) => ({
            projectKey: m.projectKey,
            projectDir: m.projectDir,
            projectName: m.projectName,
          })),
        } : {}),
      });
      this.state.id = this.pipeline.id;
      this.state.pipelineDir = this.pipeline.dir;
      this.logWriter.bind(this.pipeline.dir);                  // start persisting (flushes buffered preflight lines)
      recordArtifact(this.pipeline.id, RUN_LOG_KIND, RUN_LOG_FILE); // index like prompt.md (sync; INSERT OR IGNORE)
      // A11(b): carry the resolved prompt on the in-memory state too (createPipeline
      // already INSERTs prompt and the curated UPSERT excludes it, so persistence is
      // safe — this keeps the live state object self-consistent for any reader).
      this.state.prompt = this.pipeline.promptText;
      // Workspace: mirror the §5.2 superset onto the live state and FREEZE the
      // description now (read from the pipeline's frozen state.json snapshot, never
      // re-read from workspaces.json), so later registry edits never alter this run.
      if (this.isWorkspace) {
        // Freeze from the on-disk snapshot createPipeline wrote (the capped,
        // point-in-time copy) — never re-read from workspaces.json mid-run.
        this.workspaceDescription = await readFile(
          join(this.pipeline.dir, 'workspace-description.md'), 'utf8',
        ).catch(() => this.workspace.description || '');
        this.state.target = 'workspace';
        this.state.workspaceId = this.workspace.id;
        this.state.workspaceKey = this.workspaceKey;
        this.state.workspaceName = this.workspace.name;
        this.state.workspaceDescription = this.workspaceDescription;
        this.state.projectKeys = this.members.map((m) => m.projectKey);
        this.state.projects = this.members.map((m) => ({
          projectKey: m.projectKey,
          projectDir: resolve(m.projectDir),
          projectName: m.projectName,
        }));
        this.state.checkpointRefs = {};
        this.state.branches = {};
      }
      if (!this.state.title) this.state.title = basename(this.pipeline.dir);
      // The title set above (firstMeaningfulLine(prompt) or the dir basename) is
      // PROVISIONAL: shown instantly. Kick off the real LLM title without blocking
      // run start. Skip on a resumed run — it already carries the previously-generated
      // row.title (loaded by resume()). this.resumeOpts (= this.opts.resume) is the
      // resume signal; resume() never reaches this run() site anyway (belt-and-suspenders).
      this.state.titleProvisional = true;
      if (!this.resumeOpts) this._kickoffTitleGeneration();
      this.baseName = this._deriveBaseName(this.pipeline.promptText, this.state.title);
      // Capture the date prefix ONCE so every plan -vN and the review file share
      // the v1 date even if the run crosses midnight.
      this.planDatePrefix = today();
      // Persist the plan/review name linkage so a later delete can find the shared
      // markdown exactly (state.artifacts is not persisted; names are the only link).
      this.state.baseName = this.baseName;
      this.state.datePrefix = this.planDatePrefix;
      await this._persist();
      this._startHeartbeat(); // claim ownership + begin liveness heartbeat (crash detection)
      this._artifact('pipeline', this.pipeline.dir);
      await appendAudit(this.pipeline.dir, `Pipeline created (id ${this.pipeline.id}).`);
      if (tools.tool) {
        await appendAudit(
          this.pipeline.dir,
          `Preflight: using **${tools.tool}**${tools.kind ? ` (${tools.kind})` : ''}.`,
        );
      }

      // 3) Ensure a git repo + checkpoint commit (per member on a workspace run).
      if (this.isWorkspace) await this._ensureGitCheckpointAll();
      else await this._ensureGitCheckpoint();
      this._phase('preflight', 0, 'done');
      this._checkAbort();

      // 3b) Set up the per-pipeline worktree(s). All subsequent claude spawns cwd
      // into this.workDir (the primary on a workspace run; per-member fan-out
      // sub-agents cwd into this.workDirs). Artifacts route via the workspace store.
      if (this.isWorkspace) await this._setupWorktreeAll();
      else await this._setupWorktree();
      this._checkAbort();

      // 3c) Build the knowledge graph INSIDE each worktree so agents can query it.
      if (this.isWorkspace) await this._buildWorktreeGraphAll();
      else await this._buildWorktreeGraph();
      this._checkAbort();

      // 3d) Resolve, validate, and inject declared agent skills onto the worktree
      //     scan path. Hard-fails the run BEFORE any node if a required skill is
      //     unresolvable (built beside graphify's probe; does not touch it).
      const requiredSkills = collectRequiredSkills(this.registry, plan);
      if (requiredSkills.length) {
        const skillCtx = { repoRoot: REPO_ROOT, projectDir: this.projectDir };
        const resolvedSkills = validateSkills(requiredSkills, skillCtx); // throws => caught => run ends 'error'
        // Inject ONLY into real isolated worktrees, never the main projectDir,
        // so a copy can never pollute the user's working tree.
        const candidates = this.isWorkspace ? [...this.workDirs.values()] : [this.workDir];
        const worktrees = candidates.filter((d) => d && d !== this.projectDir);
        const injected = await injectSkills(resolvedSkills, { worktrees });
        if (injected.length) {
          await appendAudit(
            this.pipeline.dir,
            `Skills: injected ${injected.join(', ')} into ${worktrees.length} worktree(s).`,
          );
        }
      }
      this._checkAbort();

      // 4) (Clarify now runs as the first graph node — see _runClarifyNode.)

      // 5) Dispatch the resolved workflow (already snapshotted into state.stepper
      //    at run start). Persist now that this.pipeline exists, and re-emit the
      //    full state (with pipelineDir) for any client that connected mid-preflight.
      await this._persist();
      this._emit('state', this.getState());
      await appendAudit(this.pipeline.dir, `Workflow: **${plan.name}** (${plan.id}).`);
      const dispatched = await this._dispatch(plan);
      this._checkAbort();
      if (dispatched === 'paused') return await this._completePaused();

      // 9) Done.
      this._setStatus('done');
      this.state.resumePoint = null; // finished rows are not resumable (clears the boundary trail)
      this._phase('done', 0, 'done');
      await this._persist();
      await appendAudit(this.pipeline.dir, `Pipeline finished with status **done**.`);
      await this._buildResults();          // refs + worktree still live here
      this._emit('done', { status: 'done', pipelineDir: this.pipeline.dir });
      return { status: 'done', pipelineDir: this.pipeline.dir };
    } catch (err) {
      if ((isPause(err) || this.state.status === 'pausing') && this.state.status !== 'stopped') {
        if (this.pipeline) {
          if (!this.state.resumePoint) {
            // Paused outside _dispatch (preflight/worktree): boundary point at step 0.
            this.state.resumePoint = {
              version: 1, kind: 'boundary', stepIndex: 0, stepCycle: [], loopState: {},
              bus: null, stepModels: this.stepModels, workflowId: this.workflowId, plan: null,
              nodes: [], gate: null, toolInstruction: this.toolInstruction ?? '',
              pipelineDir: this.pipeline.dir, pausedAt: new Date().toISOString(),
            };
          }
          return await this._completePaused();
        }
        // No pipeline yet: nothing to resume; treat as stopped.
        this._setStatus('stopped');
        this._emit('done', { status: 'stopped', pipelineDir: null });
        return { status: 'stopped', pipelineDir: null };
      }
      if (isAbort(err) || this.state.status === 'stopped') {
        this._setStatus('stopped');
        // Stopped runs are not resumable: never persist a resume point (e.g. one
        // _dispatch assigned before stop won the race) alongside a torn-down worktree.
        this.state.resumePoint = null;
        if (this.pipeline) {
          await this._persist().catch(() => {});
          await appendAudit(this.pipeline.dir, `Pipeline **stopped**.`).catch(() => {});
        }
        this._emit('done', {
          status: 'stopped',
          pipelineDir: this.pipeline?.dir || null,
        });
        return { status: 'stopped', pipelineDir: this.pipeline?.dir || null };
      }
      this._setStatus('error');
      const message = err?.message || String(err);
      this._emit('error', { message });
      if (this.pipeline) {
        await this._persist().catch(() => {});
        await appendAudit(this.pipeline.dir, `Pipeline **error**: ${message}`).catch(() => {});
      }
      this._emit('done', {
        status: 'error',
        pipelineDir: this.pipeline?.dir || null,
      });
      return { status: 'error', pipelineDir: this.pipeline?.dir || null, error: message };
    } finally {
      this._stopHeartbeat(); // clear timer + NULL owner columns (done/stopped/error/paused)
      // C1: tear the worktree(s) down on done/stopped/error — the branch is always
      // kept (every member's, on a workspace run), only the disposable checkout is
      // removed. But NEVER on a pause: the checkout (with any uncommitted agent
      // work) is the thing we resume into.
      if (this.state.status !== 'paused' && this.state.status !== 'pausing') {
        if (this.isWorkspace) await this._teardownWorktreeAll().catch(() => {});
        else await this._teardownWorktree().catch(() => {});
      }
      await this.logWriter.close().catch(() => {}); // flush + stop timer (last, to capture teardown logs)
    }
  }

  /**
   * Continue a paused pipeline from its persisted resume point. Mirrors run()'s
   * shell but skips createPipeline / checkpoint / worktree / graph setup — those
   * artifacts exist from the original run. Resolves like run().
   */
  async resume() {
    const saved = this.resumeOpts;
    if (!saved?.row || !saved?.resumePoint) throw new Error('resume(): no saved pipeline provided');
    const { row, resumePoint: rp, steps } = saved;
    if (row.status !== 'paused' && row.status !== 'interrupted') {
      throw new Error(`resume(): pipeline is "${row.status}", not resumable`);
    }
    if (rp.version !== 1) throw new Error(`resume(): unsupported resume point version ${rp.version}`);
    try {
      // ── rehydrate identity + state ──
      this.state.id = row.id;
      this.state.title = row.title;
      this.state.startedAt = row.started_at;
      this.state.prompt = row.prompt;
      this.state.stepper = safeParse(row.stepper);
      this.state.tools = safeParse(row.tools);
      this.state.branch = safeParse(row.branch);
      this.state.steps = (steps || []).map((s) => ({ ...s, runningSince: null }));
      this.baseName = row.base_name;
      this.planDatePrefix = row.date_prefix;
      this.pipeline = { id: row.id, dir: rp.pipelineDir, promptText: row.prompt || '' };
      this.state.pipelineDir = rp.pipelineDir;
      this.logWriter.bind(rp.pipelineDir);
      recordArtifact(row.id, RUN_LOG_KIND, RUN_LOG_FILE);
      this.stepModels = rp.stepModels || null;
      this.workflowId = rp.workflowId || this.workflowId;
      // Restore the EFFECTIVE instruction from the resume point — by dispatch time
      // run() has replaced the detect-time tools.instruction with the in-worktree
      // graph-build outcome (worktreeGraphInstruction() or ''). Falling back to
      // tools.instruction would tell resumed agents a graph exists that the original
      // run suppressed. (Fallback keeps old-shape resume points working.)
      this.toolInstruction = typeof rp.toolInstruction === 'string' ? rp.toolInstruction : (this.state.tools?.instruction || '');

      // ── worktree re-attach (single-project; workspace below) ──
      const wt = this.state.branch?.worktreeDir;
      if (wt && !existsSync(wt)) throw new Error(`worktree missing: ${wt} — cannot resume`);
      if (wt) {
        this.workDir = wt;
        this.branchInfo = {
          worktreeDir: wt,
          branch: this.state.branch.feature,
          sourceBranch: this.state.branch.source,
          reusedExisting: true,
        };
      }
      this.checkpointRef = rp.bus?.code?.baseRef || null;

      // ── workspace rehydration (no-op on single-project) ──
      const meta = safeParse(row.workspace_meta);
      if (this.isWorkspace && meta) {
        this.workspaceDescription = meta.workspaceDescription || '';
        this.checkpointRefs = meta.checkpointRefs || {};
        for (const p of rp.bus?.workspace?.projects || []) {
          if (p.projectKey && p.worktreeDir) {
            if (!existsSync(p.worktreeDir)) throw new Error(`worktree missing: ${p.worktreeDir} — cannot resume`);
            this.workDirs.set(p.projectKey, p.worktreeDir);
            this.toolInstructions.set(p.projectKey, p.graphInstruction || '');
            // Re-arm teardown: _teardownWorktreeAll returns immediately on an empty
            // branchInfos map, so without this a resumed workspace run reaching
            // done/stopped/error would leak every member worktree and never run
            // _commitWork (resumed work silently absent from the feature branches).
            // Shape mirrors createWorktree()'s result as registered by _setupWorktreeAll.
            this.branchInfos.set(p.projectKey, {
              worktreeDir: p.worktreeDir,
              branch: meta.branches?.[p.projectKey]?.feature,
              sourceBranch: meta.branches?.[p.projectKey]?.source,
              reusedExisting: true,
            });
          }
        }
        Object.assign(this.state, {
          target: 'workspace', workspaceId: meta.workspaceId, workspaceKey: this.workspaceKey,
          workspaceName: meta.workspaceName, workspaceDescription: this.workspaceDescription,
          projectKeys: meta.projectKeys || [], projects: meta.projects || [],
          checkpointRefs: this.checkpointRefs, branches: meta.branches || {},
        });
      }

      // ── prompts/registry (cheap, local) ──
      this.registry = loadAgentRegistry(this.agentsDir);
      this.channelDefs = collectChannelDefs(this.registry); // custom-channel kind/filename for allocate()
      this.agentPrompts = await this._loadAgentPrompts();

      this.state.resumePoint = null; // consumed; cleared on the next persist
      this._setStatus('running');
      await this._persist();
      this._startHeartbeat();
      await appendAudit(this.pipeline.dir, `Pipeline **resumed** (from ${rp.kind} at step ${rp.stepIndex}).`);
      this._emit('state', this.getState());

      // ── plan: frozen at pause time; a pre-dispatch boundary pause re-resolves ──
      let plan = rp.plan;
      if (!plan) {
        plan = await resolveWorkflow(this.projectDir, this.workflowId, this.registry, undefined, {
          isWorkspace: this.isWorkspace,
        });
      }

      const dispatched = await this._dispatch(plan, { resume: rp });
      this._checkAbort();
      if (dispatched === 'paused') return await this._completePaused();

      this._setStatus('done');
      this.state.resumePoint = null; // finished rows are not resumable (clears the boundary trail)
      this._phase('done', 0, 'done');
      await this._persist();
      await appendAudit(this.pipeline.dir, `Pipeline finished with status **done**.`);
      await this._buildResults();          // refs + worktree still live here
      this._emit('done', { status: 'done', pipelineDir: this.pipeline.dir });
      return { status: 'done', pipelineDir: this.pipeline.dir };
    } catch (err) {
      if ((isPause(err) || this.state.status === 'pausing') && this.state.status !== 'stopped') {
        if (this.pipeline) {
          if (!this.state.resumePoint) this.state.resumePoint = rp; // re-arm the consumed point: a paused row must stay resumable
          return await this._completePaused();
        }
      }
      if (isAbort(err) || this.state.status === 'stopped') {
        this._setStatus('stopped');
        // Stopped runs are not resumable: never persist a resume point alongside
        // a torn-down worktree (mirrors run()'s stopped branch).
        this.state.resumePoint = null;
        if (this.pipeline) {
          await this._persist().catch(() => {});
          await appendAudit(this.pipeline.dir, `Pipeline **stopped**.`).catch(() => {});
        }
        this._emit('done', { status: 'stopped', pipelineDir: this.pipeline?.dir || null });
        return { status: 'stopped', pipelineDir: this.pipeline?.dir || null };
      }
      this._setStatus('error');
      const message = err?.message || String(err);
      this._emit('error', { message });
      if (this.pipeline) {
        await this._persist().catch(() => {});
        await appendAudit(this.pipeline.dir, `Pipeline **error**: ${message}`).catch(() => {});
      }
      this._emit('done', { status: 'error', pipelineDir: this.pipeline?.dir || null });
      return { status: 'error', pipelineDir: this.pipeline?.dir || null, error: message };
    } finally {
      this._stopHeartbeat(); // clear timer + NULL owner columns (done/stopped/error/paused)
      if (this.state.status !== 'paused' && this.state.status !== 'pausing') {
        if (this.isWorkspace) await this._teardownWorktreeAll().catch(() => {});
        else await this._teardownWorktree().catch(() => {});
      }
      await this.logWriter.close().catch(() => {}); // flush + stop timer (last, to capture teardown logs)
    }
  }

  // ── worktree setup ───────────────────────────────────────────────────────────

  async _setupWorktree() {
    this._log('worktree', 'info', 'Resolving source/feature branches…');
    const source = this.branchOpts.source || (await resolveDefaultBranch(this.projectDir));
    const featureRaw = this.branchOpts.feature
      ? sanitizeBranchName(this.branchOpts.feature)
      : suggestBranchName({
          prompt: this.pipeline.promptText,
          title: this.opts.title || null,
          pipelineId: this.pipeline.id,
        });
    const info = await createWorktree({
      projectDir: this.projectDir,
      pipelineId: this.pipeline.id,
      sourceBranch: source,
      featureBranch: featureRaw,
      signal: this.abort.signal,
    });
    this.workDir = info.worktreeDir;
    this.branchInfo = info;
    this.state.branch = {
      source: info.sourceBranch,
      feature: info.branch,
      worktreeDir: info.worktreeDir,
      reusedExisting: info.reusedExisting,
    };
    await this._persist();
    const reuseNote = info.reusedExisting ? ' (resumed existing branch)' : '';
    await appendAudit(
      this.pipeline.dir,
      `Worktree: \`${info.branch}\` (off \`${info.sourceBranch}\`)${reuseNote} at \`${info.worktreeDir}\`.`,
    );
    this._emit('state', this.getState());
  }

  /**
   * Resolve the worktree source/feature branch pair for ONE member (D2). The named
   * source (run-level or per-member) is used only when it resolves to a real commit
   * IN THAT member's repo; otherwise the member's own default branch. The feature is
   * the run-level featureBranch suffixed with the project slug (so members never
   * collide on one branch name), or a suggested name when none was given.
   * @param {{projectDir,projectKey,projectName,branch?:{source?,feature?}}} m
   * @returns {Promise<{source:string, featureRaw:string}>}
   */
  async _resolveMemberBranches(m) {
    const dir = resolve(m.projectDir);
    const named = (m.branch && m.branch.source) || this.branchOpts.source || null;
    const source = (named && (await isValidSourceRef(dir, named)))
      ? named
      : await resolveDefaultBranch(dir);
    const feature = (m.branch && m.branch.feature) || this.branchOpts.feature || null;
    const featureRaw = feature
      ? sanitizeBranchName(`${feature}-${slugify(m.projectName)}`)
      : suggestBranchName({
          prompt: this.pipeline.promptText,
          title: `${this.opts.title || ''} ${m.projectName}`.trim() || null,
          pipelineId: this.pipeline.id,
        });
    return { source, featureRaw };
  }

  /**
   * Workspace worktree setup (D3): one worktree per member in ITS OWN repo at
   * <m.projectDir>/.maestro/worktrees/<pipelineId>/, in parallel (cap fanoutCap()).
   * Populates this.workDirs/this.branchInfos/state.branches[projectKey] and mirrors
   * the scalar this.workDir/this.branchInfo to the primary (members[0]). Results are
   * in sorted-projectKey order (mapWithCap is deterministic), so writes are stable.
   * createWorktree's M2 resume/in-use semantics apply per member unchanged. Each
   * created worktree is registered into this.branchInfos/workDirs/state.branches the
   * instant it resolves, and a failing member is held until ALL members settle before
   * the failure is propagated — so every worktree that got created (even a sibling of
   * the failing member) is found and torn down by _teardownWorktreeAll in run()'s
   * finally (§5.10 edge 4: partial setup leaks nothing).
   */
  async _setupWorktreeAll() {
    this._log('worktree', 'info', `Resolving source/feature branches for ${this.members.length} members…`);
    this.state.branches = this.state.branches || {};
    // Settle EVERY member before propagating any failure. mapWithCap is Promise.all,
    // which rejects the instant one member throws and would abandon a sibling whose
    // createWorktree is still in flight — that sibling resolves AFTER run()'s finally
    // has already snapshotted branchInfos in _teardownWorktreeAll, orphaning its
    // worktree on disk (a real leak; the partial-setup test guards exactly this).
    // Catch per member so each successful worktree registers first, then re-throw so
    // the run still errors and teardown finds + removes every survivor (no leak).
    const setupFailures = [];
    await mapWithCap(this.members, fanoutCap(), async (m) => {
      try {
        const { source, featureRaw } = await this._resolveMemberBranches(m);
        const info = await createWorktree({
          projectDir: resolve(m.projectDir),
          pipelineId: this.pipeline.id,
          sourceBranch: source,
          featureBranch: featureRaw,
          signal: this.abort.signal,
        });
        // Register eagerly (Map.set is synchronous) so teardown always sees it.
        this.workDirs.set(m.projectKey, info.worktreeDir);
        this.branchInfos.set(m.projectKey, info);
        this.state.branches[m.projectKey] = {
          source: info.sourceBranch,
          feature: info.branch,
          worktreeDir: info.worktreeDir,
          reusedExisting: info.reusedExisting,
        };
        const reuseNote = info.reusedExisting ? ' (resumed existing branch)' : '';
        await appendAudit(
          this.pipeline.dir,
          `Worktree \`${m.projectKey}\`: \`${info.branch}\` (off \`${info.sourceBranch}\`)${reuseNote} at \`${info.worktreeDir}\`.`,
        ).catch(() => {});
      } catch (err) {
        setupFailures.push(err);
      }
    });
    // Any member failing setup fails the whole run (createWorktree cleans up its own
    // failed attempt; the registered survivors are torn down in run()'s finally).
    if (setupFailures.length) {
      throw setupFailures[0] instanceof Error ? setupFailures[0] : new Error(String(setupFailures[0]));
    }
    // Scalars mirror the primary so existing scalar readers keep working. C8: the
    // scalar state.branch is the primary's OBJECT (pipeline-delete reads .feature/
    // .worktreeDir), copied from state.branches[primaryKey].
    const primary = this.members[0];
    if (primary && this.state.branches[primary.projectKey]) {
      this.workDir = this.workDirs.get(primary.projectKey);
      this.branchInfo = this.branchInfos.get(primary.projectKey);
      this.state.branch = { ...this.state.branches[primary.projectKey] };
    }
    await this._persist();
    this._emit('state', this.getState());
  }

  /**
   * Build a graphify AST graph INSIDE the worktree so agents (which run with
   * cwd=workDir) can query it. graphify-out/ is gitignored, so it never reaches
   * the reviewer diff, the kept-branch commit, or survives teardown.
   *
   * Fail-safe — never throws. Skipped when: mock mode (keeps `npm run smoke`
   * offline); no worktree was created; or the graphify binary is not on PATH.
   * On build failure/timeout the run proceeds with no graph instruction.
   */
  async _buildWorktreeGraph() {
    if (this.claude.mock) return; // mock runs never use the graph (intentionally silent)
    if (this.workDir === this.projectDir) {
      this._log('graph', 'debug', 'No worktree (workDir===projectDir); skipping in-worktree graph build.');
      return; // building "in the worktree" would write into main
    }
    if (this.state.tools?.kind !== 'cli') {
      this.toolInstruction = '';
      this._log('graph', 'info', 'graphify CLI not on PATH; skipping in-worktree graph build');
      return;
    }
    this._log('graph', 'info', 'Building graphify graph in worktree (AST-only, no LLM)…');
    const res = await runGraphifyUpdate({
      dir: this.workDir,
      cwd: this.workDir,
      timeoutMs: this.graphBuildTimeoutMs,
    });
    if (res.ok) {
      this.toolInstruction = worktreeGraphInstruction();
      this._log('graph', 'info', 'graphify graph built in worktree.');
      await appendAudit(this.pipeline.dir, 'Preflight: built graphify graph in worktree (AST-only).').catch(() => {});
    } else {
      this.toolInstruction = '';
      this._log(
        'graph',
        'warn',
        `graphify build ${res.timedOut ? 'timed out' : 'failed'}; proceeding without graph grounding`,
      );
    }
  }

  /**
   * Workspace graph builds (D4): build a graphify graph inside EACH member worktree
   * in parallel (cap 4), storing this.toolInstructions[projectKey]. Fail-safe per
   * §5.8: a member whose detectTools.kind !== 'cli' or whose build fails/times out
   * degrades to '' (source-reading) WITHOUT aborting the others. Skipped wholesale
   * in mock mode (keeps `npm run smoke` offline + deterministic), matching the
   * single-project _buildWorktreeGraph mock guard.
   */
  async _buildWorktreeGraphAll() {
    if (this.claude.mock) return; // mock runs never use the graph (intentionally silent)
    const dirs = this.members.map((m) => resolve(m.projectDir));
    const toolsByDir = await detectToolsPerProject(dirs); // never throws
    await mapWithCap(this.members, 4, async (m) => {
      const workDir = this.workDirs.get(m.projectKey);
      const info = toolsByDir.get(resolve(m.projectDir));
      if (!workDir || workDir === resolve(m.projectDir)) {
        this.toolInstructions.set(m.projectKey, '');
        return;
      }
      if (info?.kind !== 'cli') {
        this.toolInstructions.set(m.projectKey, '');
        this._log('graph', 'info', `graphify CLI not on PATH for ${m.projectKey}; skipping graph build`);
        return;
      }
      const res = await runGraphifyUpdate({ dir: workDir, cwd: workDir, timeoutMs: this.graphBuildTimeoutMs });
      if (res.ok) {
        this.toolInstructions.set(m.projectKey, worktreeGraphInstruction());
        this._log('graph', 'info', `graphify graph built in ${m.projectKey} worktree.`);
        await appendAudit(this.pipeline.dir, `Preflight: built graphify graph for ${m.projectKey} (AST-only).`).catch(() => {});
      } else {
        this.toolInstructions.set(m.projectKey, '');
        this._log('graph', 'warn', `graphify build for ${m.projectKey} ${res.timedOut ? 'timed out' : 'failed'}; degrading to source-reading`);
      }
    });
  }

  /**
   * Tear down the per-pipeline worktree (C1). Retention policy:
   *   - ALWAYS remove the checkout dir and KEEP the feature branch — done, error,
   *     or stopped alike. The branch carries every change made up to the stop/error
   *     point so the user can recover or merge the agent's work; the worktree is
   *     just the disposable checkout.
   * Always force:true — agents have edited files, so the non-force path would
   * refuse and leak. Idempotent; safe to call when setup never ran.
   */
  async _teardownWorktree() {
    const info = this.branchInfo;
    if (!info || !info.worktreeDir) return;
    this.branchInfo = null; // guard against a double teardown
    // Commit the agent's work onto the feature branch BEFORE removal. Without
    // this, removeWorktree(force:true) discards the working tree and the kept
    // branch carries no changes (the staging in _stageWorkingTree is intent-to-add
    // for the reviewer's diff only — it never creates a commit). On error/stop this
    // is what captures the partial work made up to that point.
    await this._commitWork(info).catch(() => {});
    // branch:null — the branch is always kept (done/error/stopped alike); only the
    // disposable checkout is removed.
    const res = await removeWorktree({
      projectDir: this.projectDir,
      worktreeDir: info.worktreeDir,
      branch: null,
      force: true,
    });
    for (const s of res.steps.filter((x) => !x.ok)) {
      this._log('worktree', 'warn', `teardown ${s.step} failed: ${s.stderr || 'unknown error'}`);
    }
    if (this.pipeline) {
      await appendAudit(
        this.pipeline.dir,
        `Worktree removed at \`${info.worktreeDir}\` (kept branch \`${info.branch}\`).`,
      ).catch(() => {});
    }
    // Reflect the post-teardown reality in state for any late observer.
    if (this.state.branch) {
      this.state.branch.worktreeRemoved = true;
      this.state.branch.branchKept = true;
    }
    this.workDir = this.projectDir;
  }

  /**
   * Workspace teardown (C1, N times): per member, commit its work onto its feature
   * branch (in its own repo), remove its checkout, and KEEP the branch — done,
   * error, or stopped alike. Each member's SHA + survival flags are recorded on
   * state.branches[projectKey]. Idempotent (guards against a double teardown by
   * clearing branchInfos); best-effort (never throws). Iterated serially so the
   * teardown commits don't contend on interleaved git index locks across repos.
   */
  async _teardownWorktreeAll() {
    if (this.branchInfos.size === 0) return;
    const entries = [...this.branchInfos.entries()]; // [projectKey, info]
    this.branchInfos = new Map(); // guard against a double teardown
    for (const [projectKey_, info] of entries) {
      if (!info || !info.worktreeDir) continue;
      const branchRecord = (this.state.branches && this.state.branches[projectKey_]) || null;
      await this._commitWork(info, branchRecord).catch(() => {});
      const res = await removeWorktree({
        projectDir: resolve(this.memberByKey.get(projectKey_)?.projectDir || this.projectDir),
        worktreeDir: info.worktreeDir,
        branch: null, // always keep the branch
        force: true,
      });
      for (const s of res.steps.filter((x) => !x.ok)) {
        this._log('worktree', 'warn', `teardown ${projectKey_} ${s.step} failed: ${s.stderr || 'unknown error'}`);
      }
      if (this.pipeline) {
        await appendAudit(
          this.pipeline.dir,
          `Worktree \`${projectKey_}\` removed at \`${info.worktreeDir}\` (kept branch \`${info.branch}\`).`,
        ).catch(() => {});
      }
      if (branchRecord) {
        branchRecord.worktreeRemoved = true;
        branchRecord.branchKept = true;
      }
      this.workDirs.delete(projectKey_);
    }
    // Keep the scalar mirror coherent for late observers.
    if (this.state.branch) {
      this.state.branch.worktreeRemoved = true;
      this.state.branch.branchKept = true;
    }
    this.branchInfo = null;
    this.workDir = this.projectDir;
    await this._persist().catch(() => {});
  }

  /**
   * Commit every change in the worktree onto the feature branch so the kept
   * branch actually carries the agent's work after the worktree is removed.
   * Best-effort: never throws; logs and returns null on any failure. Skips
   * cleanly when the working tree is clean (no diff from the checkpoint), which
   * is the truthful "no change needed" outcome. Records the SHA on state.branch.
   * @param {{worktreeDir:string, branch:string}} info the branch being kept
   * @param {object} [branchRecord] the state branch object to stamp .commit onto
   *   (defaults to the scalar this.state.branch; a workspace member passes its own
   *   state.branches[projectKey] so per-member SHAs are recorded distinctly).
   * @returns {Promise<string|null>} the new commit SHA, or null when nothing committed.
   */
  async _commitWork(info, branchRecord = this.state.branch) {
    const cwd = info?.worktreeDir;
    if (!cwd) return null;
    // ignoreAbort on every call: teardown runs after stop/error has aborted the
    // signal, so binding it would no-op these commands and lose the partial work.
    const gitOpts = { cwd, ignoreAbort: true };
    const status = await this._git(['status', '--porcelain'], gitOpts);
    if (!status.ok) {
      this._log('git', 'warn', `commit skipped: git status failed: ${status.stderr.trim()}`);
      return null;
    }
    if (!status.stdout.trim()) {
      this._log('git', 'info', 'No changes to commit (working tree clean).');
      return null;
    }
    const add = await this._git(['add', '-A'], gitOpts);
    if (!add.ok) {
      this._log('git', 'warn', `commit skipped: git add failed: ${add.stderr.trim()}`);
      return null;
    }
    const title = this.state.title || this.baseName || 'changes';
    const msg = `maestro: ${title}${this.pipeline ? `\n\nPipeline ${this.pipeline.id}` : ''}`;
    // Plain commit first (uses the repo's configured identity); fall back to a
    // local identity so a repo with no user.name/email still commits — mirrors
    // _ensureGitCheckpoint's belt-and-braces.
    let commit = await this._git(['commit', '-m', msg], gitOpts);
    if (!commit.ok) {
      commit = await this._git(
        ['-c', 'user.email=orchestrator@local', '-c', 'user.name=orchestrator', 'commit', '-m', msg],
        gitOpts,
      );
    }
    if (!commit.ok) {
      this._log('git', 'warn', `commit failed: ${commit.stderr.trim() || `exit ${commit.code}`}`);
      return null;
    }
    const ref = await this._git(['rev-parse', 'HEAD'], gitOpts);
    const sha = ref.ok ? ref.stdout.trim() : null;
    if (branchRecord) branchRecord.commit = sha;
    if (sha && this.pipeline) {
      await appendAudit(
        this.pipeline.dir,
        `Committed agent work to \`${info.branch}\` at \`${sha.slice(0, 10)}\`.`,
      ).catch(() => {});
    }
    return sha;
  }

  // ── phase helpers ─────────────────────────────────────────────────────────────

  // ── data-driven dispatcher ─────────────────────────────────────────────────

  /**
   * Walk the resolved plan's steps in order. A single-node step runs directly; a
   * multi-node step runs concurrently (Promise.all). After each step completes,
   * check active feedback loops whose `from` step just ran: if the loop's `from`
   * node returned blocking issues and the loop's cycle < maxCycles, rewind the
   * pointer to the loop's `to` step (incrementing the loop cycle) and re-run
   * forward. When a loop's cycles are exhausted, gate the user (continue/stop)
   * exactly as the legacy _reviewLoop did.
   *
   * Per-loop state lives in `loopState[fb.id] = { cycle }`; the per-step run cycle
   * passed to nodes is bumped while a loop is replaying through that step (so a
   * node's artifacts/keys are unique per re-run), defaulting to 1.
   * @param {object} plan ExecutablePlan
   * @param {{answers?:Array}} runArgs
   */
  async _dispatch(plan, runArgs = {}) {
    const steps = Array.isArray(plan?.steps) ? plan.steps : [];
    const feedbacks = Array.isArray(plan?.feedbacks) ? plan.feedbacks : [];
    const resume = runArgs.resume || null;

    // D4: surface channel-reachability / governance warnings where they matter — a
    // saved-then-illegalized pipeline runs anyway, but the operator sees why a (e.g.)
    // reviewer with no upstream code reviewed an empty diff. Non-fatal. The resolved
    // node carries .nodeId; reconstruct the {id,key} template the validator expects.
    try {
      const tpl = { steps: steps.map((g) => g.map((n) => ({ id: n.nodeId, key: n.key }))), feedbacks };
      const v = validateWorkflow(tpl, this.registry || {});
      for (const w of v.warnings || []) await appendAudit(this.pipeline.dir, `Workflow warning: ${w}`);
    } catch { /* validation is best-effort at run time */ }

    // Map: source step index -> feedbacks originating there. `from` resolves to the
    // index of the step containing the from-node; `to` is a step index (tolerate a
    // node id or a numeric index).
    const nodeStepIndex = new Map();
    steps.forEach((group, i) => group.forEach((n) => nodeStepIndex.set(n.nodeId, i)));
    const toIndex = (ref) =>
      typeof ref === 'number' ? ref : (nodeStepIndex.has(ref) ? nodeStepIndex.get(ref) : Number(ref) || 0);
    const fbByFrom = new Map();
    for (const fb of feedbacks) {
      const fromIdx = toIndex(fb.from);
      if (!fbByFrom.has(fromIdx)) fbByFrom.set(fromIdx, []);
      fbByFrom.get(fromIdx).push({ ...fb, fromIdx, toIdx: toIndex(fb.to), maxCycles: numOr(fb.maxCycles, 1) });
    }
    const loopState = resume?.loopState ? JSON.parse(JSON.stringify(resume.loopState)) : {}; // fb.id -> { cycle }
    // The active run cycle per step index while a loop is replaying through it.
    const stepCycle = resume?.stepCycle?.length === steps.length
      ? [...resume.stepCycle]
      : new Array(steps.length).fill(1);

    // Typed channel bus (replaces the old `io` bag). plan/checklist are pre-seeded
    // with their default destinations (as today); code is the standing worktree
    // channel; review starts empty; userPrompt carries the prompt + clarify answers.
    // NOTE (V3-F): userPrompt.text and code.dir/baseRef are informational — no
    // legacyFields arm reads them (the planner reads only .answers; the reviewer
    // diffs ctx.checkpointRef, not code.baseRef). Tolerate undefined gracefully.
    const bus = {
      userPrompt: { kind: 'value', text: this.pipeline.promptText, answers: [] },
      clarify: null,
      decomposition: null,
      // planPath routes to the workspace store when workspaceKey is set (byte-
      // identical to today's path otherwise).
      plan: { kind: 'artifact', path: planPath(this.projectDir, this.baseName, 1, this.planDatePrefix, this.workspaceKey || undefined) },
      review: null,
      checklist: { kind: 'artifact', path: join(this.pipeline.dir, 'manual-tests-checklist.md') },
      code: { kind: 'worktree', dir: this.workDir, baseRef: this.checkpointRef },
      // Read-only metadata channel: the frozen workspace description + member set
      // (worktree dir, checkpoint ref, per-project graph instruction). Seeded ONCE
      // here, never re-published (CONV-6). null on a single-project run.
      workspace: this.isWorkspace ? this._workspaceChannel() : null,
    };
    if (resume?.bus) {
      // Restore the paused run's channel state verbatim (paths/text/answers/dirs
      // are plain JSON). The fresh literal above only provides defaults for any
      // channel a future schema adds after the pause.
      for (const [k, v] of Object.entries(resume.bus)) bus[k] = jsonClone(v);
    }

    // Prompt-as-entry-artifact: fill any materializable channel the topology requires
    // before any step produces it (a pipeline that starts mid-stream — implementer or
    // refiner first). The user prompt + attached files stand in for the missing
    // artifact, written to the channel's seeded path so EVERY consumer (the first
    // agent AND any downstream one, e.g. a later reviewer) binds it via the normal bus.
    // Disk-only: we write the file at bus[c].path; the handle (and its path) is
    // unchanged, so the frozen per-step snapshots already point at the now-existing
    // file. A real producer later overwrites the file (latest-writer-wins), as today.
    this.extrasFiles = await this._collectExtras();
    if (!resume) {
      for (const c of entrySeedChannels(steps)) {
        const handle = bus[c];
        if (!handle?.path) continue;
        await mkdir(dirname(handle.path), { recursive: true }); // plans/ dir is lazy
        await writeFile(handle.path, renderPromptArtifact(this.pipeline.promptText, this.extrasFiles), 'utf8');
        await appendAudit(this.pipeline.dir, `Seeded "${c}" from the user prompt (no upstream producer).`);
      }
    }

    let i = resume ? Math.min(Math.max(0, resume.stepIndex | 0), steps.length) : 0;
    // One-shot session re-attach map: only the interrupted step's nodes resume their
    // captured claude sessions; every later step starts fresh.
    this._resumeNodeSessions = resume?.kind === 'node'
      ? new Map((resume.nodes || []).filter((n) => n.sessionId).map((n) => [n.nodeId, n.sessionId]))
      : null;
    let pendingGate = resume?.kind === 'gate' && resume.gate ? { ...resume.gate } : null;
    try {
      while (i < steps.length) {
        if (pendingGate) {
          // Re-enter exactly at the interrupted gate: no step re-run.
          const fb = (fbByFrom.get(i) || []).find((f) => f.id === pendingGate.fbId);
          const g = pendingGate;
          pendingGate = null;
          if (fb) {
            const st = (loopState[fb.id] ||= { cycle: g.cycle || 1 });
            this._pauseGate = { ...g };
            const decision = await this._gate(fb.id, g.cycle, g.issues || []);
            this._pauseGate = null;
            this._checkAbort();
            if (decision === 'another') {
              st.cycle = (g.cycle || 1) + 1;
              for (let k = fb.toIdx; k <= i; k++) stepCycle[k] = st.cycle;
              await appendAudit(this.pipeline.dir, `Loop ${fb.id} gate at cycle ${g.cycle}: user approved another cycle.`);
              i = fb.toIdx;
              continue;
            }
            await appendAudit(this.pipeline.dir, `Loop ${fb.id} gate at cycle ${g.cycle}: user chose to continue with open issue(s).`);
          }
          i += 1;
          continue;
        }
        this._checkAbort();
        this._checkPause();
        const cycle = stepCycle[i];
        const results = await this._runStep(steps[i], i, cycle, bus);
        this._resumeNodeSessions = null; // one-shot: only the interrupted step re-attaches

        // Did any feedback originating in THIS step fire?
        const loops = fbByFrom.get(i) || [];
        let rewound = false;
        for (const fb of loops) {
          const fired = this._loopFired(fb, results); // CONV-3: gate off the loop's `from` node
          if (!fired) continue;
          const st = (loopState[fb.id] ||= { cycle: 1 });
          if (st.cycle < fb.maxCycles) {
            st.cycle += 1;
            for (let k = fb.toIdx; k <= i; k++) stepCycle[k] = st.cycle; // re-runs bump cycle
            await appendAudit(
              this.pipeline.dir,
              `Loop ${fb.id}: blocking issues at step ${i}; rewind to step ${fb.toIdx} (cycle ${st.cycle}).`,
            );
            i = fb.toIdx;
            rewound = true;
            break;
          }
          // Cycles exhausted -> gate the user exactly like the old review loop.
          // Snapshot the gate context so a pause that lands while _gate awaits the
          // user can serialize kind:'gate'.
          const gateIssues = blockingIssues(this._reviewOf(results, fb.from));
          this._pauseGate = { fbId: fb.id, toIdx: fb.toIdx, cycle: st.cycle, issues: gateIssues };
          const decision = await this._gate(fb.id, st.cycle, gateIssues);
          this._pauseGate = null;
          this._checkAbort();
          if (decision === 'another') {
            st.cycle += 1;
            for (let k = fb.toIdx; k <= i; k++) stepCycle[k] = st.cycle;
            await appendAudit(this.pipeline.dir, `Loop ${fb.id} gate at cycle ${st.cycle - 1}: user approved another cycle.`);
            i = fb.toIdx;
            rewound = true;
            break;
          }
          await appendAudit(this.pipeline.dir, `Loop ${fb.id} gate at cycle ${st.cycle}: user chose to continue with open issue(s).`);
        }
        if (!rewound) i += 1;
        // Crash-recovery trail: every completed step boundary persists a boundary resume
        // point for the NEXT step. A hard stop now leaves a valid recovery position.
        this.state.resumePoint = this._buildResumePoint({ plan, stepIndex: i, stepCycle, loopState, bus });
        await this._persist();
      }
    } catch (err) {
      if (isPause(err)) {
        this.state.resumePoint = this._buildResumePoint({ plan, stepIndex: i, stepCycle, loopState, bus });
        return 'paused';
      }
      throw err;
    }
    return 'done';
  }

  /** Serialize the dispatch position into a JSON-safe resume point. */
  _buildResumePoint({ plan, stepIndex, stepCycle, loopState, bus }) {
    const cyc = Array.isArray(stepCycle) ? [...stepCycle] : [];
    const curCycle = cyc[stepIndex] || 1;
    const cur = (this.state.steps || []).filter(
      (s) => s.stepIndex === stepIndex && (s.cycle || 1) === curCycle && s.nodeId,
    );
    const kind = this._pauseGate ? 'gate' : (cur.some((s) => s.status === 'paused') ? 'node' : 'boundary');
    return {
      version: 1,
      kind,
      stepIndex,
      stepCycle: cyc,
      loopState: JSON.parse(JSON.stringify(loopState || {})),
      bus: jsonClone(bus),
      stepModels: this.stepModels,
      workflowId: this.workflowId,
      plan: jsonClone({ id: plan.id, name: plan.name, steps: plan.steps, feedbacks: plan.feedbacks }),
      nodes: cur.map((s) => ({
        nodeId: s.nodeId, key: s.phase, sessionId: s.sessionId || null, completed: s.status === 'done',
      })),
      gate: this._pauseGate ? { ...this._pauseGate } : null,
      // The EFFECTIVE instruction at dispatch time (post in-worktree graph build),
      // not the detect-time tools.instruction — resume() restores it verbatim.
      toolInstruction: this.toolInstruction ?? '',
      pipelineDir: this.pipeline.dir,
      pausedAt: new Date().toISOString(),
    };
  }

  /**
   * Run one step. Single node -> direct; >1 node -> Promise.all (PARALLEL).
   * Returns an array of { node, result } in node order.
   */
  async _runStep(group, stepIndex, cycle, bus) {
    // Decomposed implement: a single implementer step (and not an already-synthetic
    // task node) + a decomposition on the bus + NOT a fix cycle => fan out one
    // implementer per task, phases sequential, tasks parallel. A fix-cycle rewind
    // (bus.review present) runs the normal single implementer on the combined diff.
    if (
      group.length === 1 && group[0].key === 'implementer' && !group[0].decomposedTask &&
      bus.decomposition && Array.isArray(bus.decomposition.phases) && bus.decomposition.phases.length &&
      !bus.review
    ) {
      return this._runDecomposedImplement(group[0], stepIndex, cycle, bus);
    }
    // CONV-6: each node reads a FROZEN snapshot of the inbound bus; nodes never
    // mutate shared state concurrently. Results merge back in node order after all
    // nodes settle, so the outcome is independent of completion timing.
    const snapshot = Object.freeze({ ...bus });
    const results = group.length === 1
      ? [await this._runNode(group[0], stepIndex, cycle, snapshot)]
      : await Promise.all(group.map((node) => this._runNode(node, stepIndex, cycle, snapshot)));
    let stageNeeded = false;
    for (const { node, result, ctx } of results) {
      this._publishNodeIo(node, result, ctx.outputs, bus); // deterministic, node order
      // M1: the reviews table is the AUTHORITATIVE per-cycle verdict store. Persist
      // synchronously (awaited) before the step returns so the History UI and any
      // post-run reader see every cycle's verdict. writeReview keeps an inner catch, so
      // it stays best-effort under WAL contention (a transient lock must not abort a long
      // pipeline) — the await is for ordering/visibility, NOT error propagation. The live
      // refine/review->fix loop still gates on result.review in-memory (_loopFired),
      // which the runner parsed from the agent's scratch json — the FS json stays a
      // transient subprocess artifact swept with the run dir.
      if (this.pipeline && ctx.outputs?.review?.reviewKind && result?.review) {
        await writeReview(this.pipeline.id, reviewKindOf(ctx.outputs.review.reviewKind), cycle, result.review);
      }
      // Decomposer node: persist the phases + tasks (stamped with the deterministic
      // implementer node ids) so the records exist even if the implement stage aborts.
      if (this.pipeline && node.key === 'decomposer' && Array.isArray(result?.decomposition?.phases)) {
        await this._persistDecomposition(result.decomposition.phases);
      }
      if ((node.produces || []).includes('code')) stageNeeded = true;
    }
    // CONV-6: stage ONCE, AWAITED, after the step's producers — so a following
    // reviewer's `git diff` sees newly-written files (legacy _reviewLoop staged
    // after every implement pass).
    if (stageNeeded) await this._stageWorkingTree();
    return results;
  }

  /**
   * Persist the decomposer's phases/tasks, stamping each task with the deterministic
   * implementer node id `s_impl_p<ordinal>_t<index+1>` used by the manifest rewrite +
   * runtime fan-out. Best-effort (writeDecomposition swallows WAL errors).
   */
  async _persistDecomposition(phases) {
    for (const ph of phases) {
      const tasks = Array.isArray(ph?.tasks) ? ph.tasks : [];
      tasks.forEach((t, i) => { t.nodeId = `s_impl_p${ph.ordinal}_t${i + 1}`; });
    }
    writeDecomposition(this.pipeline.id, phases);
    await appendAudit(this.pipeline.dir, `Decomposed plan into ${phases.length} phase(s).`);
  }

  /**
   * Run the decomposed implement stage. Rewrite + persist the UI stepper into per-phase
   * / per-task cells, then run each phase IN ORDER (tasks within a phase in PARALLEL,
   * shared working tree). Abort immediately on the first genuine task failure. Stages
   * the combined tree itself (the guard returns early from _runStep, skipping its tail
   * stage). Returns the dispatcher's [{node,result,ctx}] shape with ONE synthetic
   * implementer result so the reviewer step sees a settled 'code' producer.
   */
  async _runDecomposedImplement(implNode, stepIndex, cycle, bus) {
    const phases = bus.decomposition.phases;
    // 1) Rewrite + persist the UI manifest so the live/history view stacks per task.
    this.state.stepper = rewriteStepperForDecomposition(this.state.stepper, phases);
    await this._persist();
    this._emit('state', this.getState());

    const snapshot = Object.freeze({ ...bus });

    // 2) Run each phase in order.
    for (const ph of phases) {
      const tasks = Array.isArray(ph.tasks) ? ph.tasks : [];
      updatePhaseStatus(this.pipeline.id, ph.ordinal, 'running', new Date().toISOString());
      await appendAudit(this.pipeline.dir, `Phase ${ph.ordinal}: ${tasks.length} task(s) starting.`);

      const phaseAbort = new AbortController();
      const settled = await Promise.allSettled(tasks.map((task) => {
        const taskNode = decomposedTaskNode(implNode, task, tasks, this.pipeline.dir);
        return this._runDecomposedTask(taskNode, task, stepIndex, cycle, snapshot, phaseAbort);
      }));

      // Pause lands between decomposed phases (coarse but safe): aborted tasks of
      // this phase re-run on resume as part of the whole decomposed step.
      if (this.pauseRequested) throw pauseErr();

      // Abort-immediately on the FIRST genuine (non-abort) failure.
      let firstError = null;
      settled.forEach((r, k) => {
        if (r.status === 'rejected' && !isAbort(r.reason) && !firstError) {
          firstError = { task: tasks[k], reason: r.reason };
          phaseAbort.abort();
        }
      });
      if (firstError) {
        updatePhaseStatus(this.pipeline.id, ph.ordinal, 'error', new Date().toISOString());
        await appendAudit(this.pipeline.dir,
          `Phase ${ph.ordinal}: task "${firstError.task.title || firstError.task.id}" failed — aborting run.`);
        throw new Error(`Decomposed implement failed in phase ${ph.ordinal}: task "${firstError.task.title || firstError.task.id}": ${firstError.reason?.message || firstError.reason}`);
      }
      updatePhaseStatus(this.pipeline.id, ph.ordinal, 'done', new Date().toISOString());
    }

    // 3) Stage the combined tree so the reviewer's diff sees every task's files.
    await this._stageWorkingTree();

    // 4) Synthetic dispatcher result (one settled 'code' producer). NOT published via
    //    _publishNodeIo (the guard returned early); bus.code is the standing worktree
    //    channel the reviewer already binds, so the staged tree is all it needs.
    return [{
      node: { ...implNode, produces: ['code'], consumes: ['plan'] },
      result: { status: 'ok', summary: `Decomposed implementation complete (${phases.length} phase(s)).` },
      ctx: { outputs: {} },
    }];
  }

  /**
   * Run one decomposed task through the standard node machinery: _nodeStep records its
   * own pipeline step (distinct nodeId), _nodeCtx wires its own onEvent (so sub-agents
   * are attributed to this task), and the producer runner runs the implementer with the
   * self-contained TASK file authoritative (ctx.node.taskPath). The phase-local abort is
   * folded with the run-wide signal so a sibling failure cancels it. updateTaskStatus
   * tracks running/done/error. Errors propagate.
   */
  async _runDecomposedTask(taskNode, task, stepIndex, cycle, snapshot, phaseAbort) {
    this._nodeStep(taskNode, stepIndex, cycle, 'start');
    updateTaskStatus(this.pipeline.id, task.id, 'running', new Date().toISOString());
    const ctx = this._nodeCtx(taskNode, { stepIndex, cycle });
    Object.assign(ctx, this._bindNodeIo(taskNode, cycle, snapshot));
    ctx.signal = AbortSignal.any([this.abort.signal, this.pauseAbort.signal, phaseAbort.signal]); // sibling-failure/pause cancel
    let status = 'done';
    try {
      const runner = this._runners[taskNode.runnerType];
      await runner(ctx); // producer -> runImplementer({ ..., taskPath: ctx.node.taskPath })
    } catch (err) {
      status = 'error';
      throw err;
    } finally {
      updateTaskStatus(this.pipeline.id, task.id, status, new Date().toISOString());
      this._nodeStep(taskNode, stepIndex, cycle, status === 'error' ? 'error' : 'done');
    }
  }

  /**
   * Execute a single plan node through its runnerType, binding the frozen bus
   * snapshot into ctx and returning the node result + ctx (publish happens in
   * _runStep). Records the node step (parallel-safe) and tags all emits.
   */
  async _runNode(node, stepIndex, cycle, snapshot) {
    this._nodeStep(node, stepIndex, cycle, 'start');
    // Per-cycle artifact paths so loop re-runs never clobber prior outputs.
    const ctx = this._nodeCtx(node, { stepIndex, cycle });
    Object.assign(ctx, this._bindNodeIo(node, cycle, snapshot));
    if (this._resumeNodeSessions?.has(node.nodeId)) {
      ctx.resumeSessionId = this._resumeNodeSessions.get(node.nodeId);
    }
    this._primeQuestions(node, ctx);
    let result;
    let endMark = 'done';
    try {
      result = await this._runNodeAttempts(node, stepIndex, cycle, ctx);
      result = await this._questionsLoop(node, stepIndex, cycle, ctx, result);
    } catch (err) {
      if (this.pauseRequested && (isAbort(err) || isPause(err) || this.pauseAbort.signal.aborted)) {
        endMark = 'paused';
        throw pauseErr();
      }
      throw err;
    } finally {
      this._nodeStep(node, stepIndex, cycle, endMark);
    }
    // CONV-6: no shared-bus mutation here — _runStep merges results in node order.
    return { node, result, ctx };
  }

  /** The recoverable-error retry loop around one node execution. Extracted from
   *  _runNode verbatim so the questions-resume runs (spec 2026-07-11) get the
   *  SAME usage-limit/recovery treatment as the initial attempt. The pause
   *  paths throw pauseErr() with pauseRequested already set (_pauseForLimit
   *  calls this.pause()), so _runNode's catch reproduces the 'paused' mark. */
  async _runNodeAttempts(node, stepIndex, cycle, ctx) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this._runOnce(node, ctx);
      } catch (err) {
        // Pause/stop always win over a recoverable error.
        if (this.pauseRequested && (isAbort(err) || isPause(err) || this.pauseAbort.signal.aborted)) {
          throw pauseErr();
        }
        if (isAbort(err) || isPause(err)) throw err;
        const cls = classifyError(err);
        if (!cls) throw err;                    // not recoverable -> today's path
        if (cls === 'usage_limit') {
          // A session/usage cap that only clears after a multi-hour reset.
          // _pauseForLimit pauses the whole run (sets pauseRequested); throwing
          // pauseErr() unwinds this node as a pause.
          this._pauseForLimit(node, err);
          throw pauseErr();
        }
        const decision = await this._recover({ node, cls, err, attempt });
        if (decision === 'abort') throw err;    // user/auto gave up -> fail as today
        this._nodeStep(node, stepIndex, cycle, 'start'); // node back to running for the retry
        // loop -> re-run the node fresh
      }
    }
  }

  /** Run a node's runner once, with the spec §7 vanished-session fresh re-run
   *  fallback (a dead `--resume` session must not fail the run). Extracted from
   *  _runNode verbatim so the recovery loop wraps a single clean call. */
  async _runOnce(node, ctx) {
    const runner = this._runners[node.runnerType];
    if (typeof runner !== 'function') throw new Error(`no runner for type "${node.runnerType}"`);
    try {
      return await runner(ctx);
    } catch (err) {
      if (ctx.resumeSessionId && !isAbort(err) && !isPause(err) && !this.pauseRequested) {
        this._log(node.key, 'warn', `session resume failed (${err?.message || err}); re-running the step fresh`);
        await appendAudit(this.pipeline.dir, `Resume fallback: node ${node.nodeId} re-ran fresh (session resume failed).`).catch(() => {});
        ctx.resumeSessionId = undefined;
        return await runner(ctx);
      }
      throw err;
    }
  }

  /** Seed the ask-then-resume ctx fields (spec 2026-07-11) for one node run.
   *  Disabled for clarifier nodes (they have their own gate), decomposed task
   *  shards, and auto mode (the directive would be auto-answered noise).
   *  Persisted answers from EVERY prior round/cycle of this node are re-injected
   *  so a fix-cycle or crash-resumed re-run never re-asks. */
  _primeQuestions(node, ctx) {
    const enabled = !!node.askQuestions && node.runnerType !== 'clarifier'
      && !node.decomposedTask && !this.auto;
    ctx.questionsEnabled = enabled;
    if (!enabled) return;
    ctx.questionsAnswered = readStepQuestions(this.pipeline.id)
      .filter((r) => r.nodeId === node.nodeId)
      .flatMap((r) => r.answers);
    ctx.questionsFile = this._questionsPath(node, ctx.stepIndex, ctx.cycle, 1);
  }

  /** Absolute per-round questions file path inside the pipeline dir. The node
   *  id is sanitized so a hand-authored workflow id can never escape the dir. */
  _questionsPath(node, stepIndex, cycle, round) {
    const safe = String(node.nodeId).replace(/[^A-Za-z0-9_-]/g, '_');
    return join(this.pipeline.dir, `questions-${stepIndex}-${safe}-c${cycle}-r${round}.json`);
  }

  /**
   * Ask-then-resume rounds (spec 2026-07-11 §5). After a successful run: if the
   * agent wrote this round's questions file, persist the questions, gate the
   * user (serialized — single pendingQuestion slot), persist the answers
   * (BEFORE the resume spawns — crash-safe), then resume the SAME session with
   * the answers injected via questionsPromptBlock. The resume goes through
   * _runNodeAttempts, so recovery + the vanished-session fresh re-run apply
   * unchanged. Caps at MAX_QUESTION_ROUNDS; the final resume carries no
   * next-round file so the agent proceeds on assumptions.
   */
  async _questionsLoop(node, stepIndex, cycle, ctx, firstResult) {
    let result = firstResult;
    if (!ctx.questionsEnabled) return result;
    const stepKey = this._stepKeyFor(node, stepIndex, cycle);
    const agentLabel = ((this.registry || {})[node.key] || {}).displayName || node.key;
    for (let round = 1; round <= MAX_QUESTION_ROUNDS; round++) {
      const qPath = ctx.questionsFile;
      if (!qPath) break;
      const { questions, malformed } = await readQuestionsFile(qPath);
      if (!questions.length) {
        if (malformed) {
          await appendAudit(this.pipeline.dir, `${agentLabel}: questions file was malformed — proceeding without asking (round ${round}).`).catch(() => {});
        }
        break;
      }
      this._checkAbort();
      await writeStepQuestions(this.pipeline.id, stepKey, round, {
        agentKey: node.key, nodeId: node.nodeId, questions: { questions },
      });
      this._artifact('questions', qPath);
      await appendAudit(this.pipeline.dir, `${agentLabel} asked ${questions.length} question(s) (round ${round}).`);
      const payload = await this._enqueueAsk(() => this._ask({
        id: `questions-${stepKey}-r${round}`,
        kind: 'questions',
        questions,
        agent: agentLabel,
        nodeId: node.nodeId,
      }));
      this._checkAbort();
      const answers = normalizeClarifyAnswer(payload, questions);
      const byId = new Map(questions.map((q) => [q.id, q]));
      const enriched = answers.map((a) => ({ id: a.id, question: byId.get(a.id)?.question || '', choice: a.choice }));
      await writeStepQuestions(this.pipeline.id, stepKey, round, {
        agentKey: node.key, nodeId: node.nodeId, answers: { answers: enriched },
      });
      await appendAudit(this.pipeline.dir, `${agentLabel}: ${enriched.length} answer(s) received (round ${round}).`);
      const step = this.state.steps.find((s) => s.key === stepKey);
      if (step?.sessionId) ctx.resumeSessionId = step.sessionId;
      ctx.questionsAnswered = [...(ctx.questionsAnswered || []), ...enriched];
      ctx.questionsFile = round < MAX_QUESTION_ROUNDS
        ? this._questionsPath(node, stepIndex, cycle, round + 1)
        : null;
      result = await this._runNodeAttempts(node, stepIndex, cycle, ctx);
    }
    return result;
  }

  /** Pause the whole run because a node hit a session/usage cap that only clears
   *  after a long reset. Records the cap message (surfaced on the paused row /
   *  audit) and signals a graceful pause; the caller throws pauseErr() to unwind
   *  this node, and pause() aborts the in-flight siblings. Idempotent: the first
   *  limit-hit among parallel siblings wins, the rest no-op. */
  _pauseForLimit(node, err) {
    const reason = firstLine(err?.message || String(err));
    if (!this.pauseReason) this.pauseReason = reason;
    this._log(node.key, 'warn', `session/usage limit reached — pausing for manual resume: ${reason}`);
    appendAudit(this.pipeline.dir, `Pipeline **paused**: session/usage limit on ${node.key} — ${reason}. Resume after the reset.`).catch(() => {});
    this.pause();
  }

  /** Decide how to recover from a classified error. Auto mode: bounded backoff
   *  then give up (and abort immediately if a pause fired during backoff, so a
   *  pause is never followed by a wasted retry). Interactive: ONE shared prompt
   *  per error class (same-class siblings await the same answer), and distinct
   *  classes are serialized so only one recovery prompt is open at a time (the
   *  gate holds a single pendingQuestion). Returns 'retry' | 'abort'. */
  async _recover({ node, cls, err, attempt }) {
    this._log(node.key, 'warn', `recoverable ${cls} error: ${err.message}`);
    await appendAudit(this.pipeline.dir, `Recoverable **${cls}** error on ${node.key}: ${firstLine(err.message)}`).catch(() => {});

    if (this.auto) {
      if (attempt > RECOVERY_MAX_AUTO_ATTEMPTS) return 'abort';
      await this._backoff(attempt, this.pauseAbort.signal);
      // A pause during backoff must win: abort instead of retrying. The loop's
      // outer catch then re-classifies the thrown error under pauseRequested and
      // unwinds as a pause (the pauseAbort signal is aborted).
      if (this.pauseRequested || this.pauseAbort.signal.aborted) return 'abort';
      return 'retry';
    }

    this._recovery ||= new Map();
    if (!this._recovery.has(cls)) {
      const p = this._enqueueRecoveryPrompt(cls, firstLine(err.message))
        .finally(() => { if (this._recovery) this._recovery.delete(cls); });
      this._recovery.set(cls, p);
    }
    return this._recovery.get(cls);
  }

  /** Open a recovery prompt for one class, serialized behind any in-flight
   *  recovery prompt (the question gate has a single pendingQuestion slot, so
   *  distinct classes must queue — see the clarify answer). Returns 'retry'|'abort'. */
  _enqueueRecoveryPrompt(cls, message) {
    const run = () =>
      this._ask({
        id: `recovery-${cls}-${this._recoveryNonce()}`,
        kind: 'recovery',
        recovery: { cls, message },
      }).then((ans) => (ans && ans.decision === 'abort' ? 'abort' : 'retry'));
    return this._enqueueAsk(run);
  }

  /** Serialize an _ask-producing thunk behind any in-flight prompt (the gate
   *  holds a single pendingQuestion slot; recovery AND step questions share
   *  this tail so parallel nodes can never clobber each other's prompt). */
  _enqueueAsk(run) {
    const prev = this._askTail || Promise.resolve();
    const next = prev.then(run, run);
    this._askTail = next.catch(() => {}); // tail must never reject the chain
    return next;
  }

  /** Abort-aware backoff: base * 2^(attempt-1) ms, resolving early (and still
   *  'retry') if the pause-only signal fires so a pause is not delayed. */
  _backoff(attempt, signal) {
    const base = (() => {
      const n = Number(process.env.MAESTRO_RECOVERY_BACKOFF_MS);
      return Number.isFinite(n) && n >= 0 ? n : 1000;
    })();
    const ms = base * Math.pow(2, Math.max(0, attempt - 1));
    if (!ms) return Promise.resolve();
    return new Promise((res) => {
      const t = setTimeout(res, ms);
      t.unref?.();
      if (signal) {
        if (signal.aborted) { clearTimeout(t); res(); }
        else signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
      }
    });
  }

  /** Monotonic id source for recovery prompts (no Date.now/random — replay-safe). */
  _recoveryNonce() {
    return ++this._recoverySeq;
  }

  /**
   * Interactive clarify runner (runnerType 'clarifier'). Runs the clarify agent
   * (writes clarify.json + the DB clarify questions row), then pauses for the user's
   * answers via the same _ask the feedback-loop gate uses, persists them to the
   * clarify row, and returns { questions, answers } so _publishNodeIo folds them onto
   * the `clarify` channel (read by the planner as inputs.clarify.answers). With no
   * questions it skips the gate and returns empty sets. `ctx` is the node ctx built by
   * _runNode (carries node, cycle, agentPrompts.clarify, outputs.clarify, pipelineDir,
   * pipelineId).
   */
  async _runClarifyNode(ctx) {
    const cycle = ctx.cycle || 1;
    const clarifyPath = ctx.outputs?.clarify?.path || join(this.pipeline.dir, 'clarify.json');
    const { questions } = await runClarify(ctx, { round: cycle, priorAnswers: [] });
    this._checkAbort();
    if (!Array.isArray(questions) || questions.length === 0) {
      await appendAudit(this.pipeline.dir, `Clarify: no questions; proceeding to plan.`);
      return { questions: [], answers: [] };
    }
    this._artifact('clarify', clarifyPath);
    const answer = await this._ask({ id: `clarify-${cycle}`, kind: 'clarify', questions });
    this._checkAbort();
    const answers = normalizeClarifyAnswer(answer, questions);
    const enriched = await this._writeClarifyAnswers(questions, answers);
    await appendAudit(this.pipeline.dir, `Clarify: answered ${answers.length} question(s).`);
    return { questions, answers: enriched };
  }

  /** Bind a node's typed inputs from the (frozen) bus snapshot + allocate its
   *  outputs, then flatten to the runner ABI the phases.mjs runners read. Replaces
   *  the role switch. `node` carries consumes/produces/optionalConsumes from
   *  resolveWorkflow (Step 4). */
  _bindNodeIo(node, cycle, snapshot) {
    const consumes = node.consumes || [];
    const produces = node.produces || [];
    const optional = node.optionalConsumes || [];
    const ctx = {
      projectDir: this.projectDir, pipelineDir: this.pipeline.dir,
      baseName: this.baseName, datePrefix: this.planDatePrefix, cycle, key: node.key,
      // allocate() forwards workspaceKey into planPath/reviewPath so a workspace
      // run's unified plan/review route to the workspace store; null otherwise.
      workspaceKey: this.workspaceKey,
      // Registry-collected custom channel definitions (kind/filename) so allocate()'s
      // generic default branch can mint <pipelineDir>/<filename>[-cycleN].<ext>.
      channelDefs: this.channelDefs || {},
    };
    const inputs = bindInputs(consumes, optional, snapshot);
    const outputs = {};
    for (const c of produces) outputs[c] = allocate(c, ctx);
    return { inputs, outputs, ...legacyFields(node, inputs, outputs, cycle, this.baseName) };
  }

  /**
   * Build the read-only `workspace` metadata channel handle (the bus value for the
   * workspace channel): the frozen description + the member set with each member's
   * worktree dir, checkpoint ref, and per-project graph instruction. Seeded once by
   * _dispatch and never re-published (CONV-6). Members are in sorted-projectKey order.
   */
  _workspaceChannel() {
    return {
      kind: 'metadata',
      workspaceDescription: this.workspaceDescription,
      projects: this.members.map((m) => ({
        projectKey: m.projectKey,
        projectName: m.projectName,
        worktreeDir: this.workDirs.get(m.projectKey),
        checkpointRef: this.checkpointRefs[m.projectKey],
        graphInstruction: this.toolInstructions.get(m.projectKey) || '',
      })),
    };
  }

  /** Publish a node's produced channels back onto the bus (node order). Emits the
   *  same 'artifact' events as before for plan/checklist. Clearing `review` on code
   *  publish fixes the sticky fix-mode latent bug. */
  _publishNodeIo(node, result, outputs, bus) {
    if (!result) return;
    const beforePlan = bus.plan, beforeChecklist = bus.checklist;
    publish(node.produces || [], result, outputs || {}, bus);
    if (bus.plan && bus.plan !== beforePlan) this._artifact('plan', bus.plan.path);
    if (bus.checklist && bus.checklist !== beforeChecklist) this._artifact('checklist', bus.checklist.path);
    // A16(5): index a published review's md path so the Task-3.13 index-based deleter
    // can remove the shared reviews/<date>-<base>-(impl|plan|ws)-review.md. publish()
    // only folds reviews that carry an md (refiner's md-less verdict is private), so
    // the md is on result.reviewMdPath / outputs.review.mdPath. webui-review md is
    // pipeline-dir-local -> index it under kind 'webui'; all other review md is the
    // shared store-rooted file -> kind 'review'. (_artifact computes the rel_path.)
    const reviewMd = result.reviewMdPath ?? outputs?.review?.mdPath;
    if (reviewMd) {
      const reviewKind = outputs?.review?.reviewKind === 'webui-review' ? 'webui' : 'review';
      this._artifact(reviewKind, reviewMd);
    }
  }

  /** True if the loop's `from` node returned a blocking verdict (CONV-3). */
  _loopFired(fb, results) {
    const review = this._reviewOf(results, fb.from);
    return review ? hasBlocking(review) : false;
  }

  /**
   * CONV-3: the verdict of the loop's ORIGINATING node, resolved by `nodeId`,
   * REGARDLESS of runnerType — so a producer self-loop (the refiner `s1_0->s1_0`)
   * gates on its own review, reproducing the legacy `_refineLoop`. `loopSource` is
   * a validation/UI hint, not the runtime gate selector. Falls back to synthesizing
   * a review from a blocked status when the node exposed issues but no full review.
   */
  _reviewOf(results, fromNodeId) {
    const r = results.find((x) => x.node.nodeId === fromNodeId);
    if (!r) return null;
    return r.result?.review || (r.result?.status === 'blocked'
      ? { issues: (r.result.issues || []).map((i) => ({ severity: i.severity || 'major' })), summary: r.result.summary || '' }
      : null);
  }

  // ── question / gate plumbing ───────────────────────────────────────────────

  /**
   * Emit a question and await its resolution. Honors auto-mode.
   * Freezes the active-time clock while blocked on the user (active-time-only).
   * @returns {Promise<any>} the answer payload
   */
  async _ask({ id, kind, questions, issues, recovery, agent, nodeId }) {
    this._checkAbort();

    // Freeze the active-time clock while we wait on the user (active-time-only).
    const frozenKey = this._runningStepKey();
    if (frozenKey) {
      this._clockPause(frozenKey);
      this.state.totalActiveMs = sumStepActive(this.state.steps);
      this._emit('state', this.getState()); // UI freezes the live timer
      this._persist().catch(() => {});
    }

    this._emit('question', { id, kind, questions, issues, recovery, agent, nodeId });

    try {
      if (this.auto) {
        if (kind === 'recovery') {
          // Auto mode handles recovery in _recover before ever calling _ask;
          // this is a defensive fallback so an auto run can never hang.
          return { decision: 'abort' };
        }
        if (kind === 'clarify' || kind === 'questions') {
          this._log('orchestrator', 'info', `auto-answering ${kind} ${id}`);
          return {
            answers: (questions || []).map((q) => ({
              id: q.id,
              choice: (q.options && q.options.find((o) => o && o.trim())) || 'auto',
            })),
          };
        }
        this._log('orchestrator', 'info', `auto-answering gate ${id} -> continue`);
        return { decision: 'continue' };
      }
      return await new Promise((resolveP, rejectP) => {
        this.pendingQuestion = { id, kind, resolve: resolveP, reject: rejectP };
      });
    } finally {
      // Resume only if that step is still the active phase AND the run hasn't
      // gone terminal. stop() sets status before rejecting the pending promise,
      // so on a stop-while-blocked we must NOT resume (the terminal _setStatus
      // already folded every clock). Gates fire after a phase's 'done', so
      // frozenKey is null there and nothing resumes anyway.
      if (frozenKey && !['stopped', 'error', 'pausing', 'paused'].includes(this.state.status)) {
        this._clockResume(frozenKey);
        this._emit('state', this.getState());
        this._persist().catch(() => {});
      }
    }
  }

  /**
   * Emit a gate question for a loop and resolve to "continue" | "another".
   */
  async _gate(loop, cycle, issues) {
    const id = `gate-${loop}-${cycle}`;
    const payload = await this._ask({ id, kind: 'gate', issues });
    const decision = payload?.decision === 'another' ? 'another' : 'continue';
    return decision;
  }

  // ── context passed to phase runners ────────────────────────────────────────

  _phaseCtx(role, { fanOut = false } = {}) {
    // resolveStepModels already folded in the global fallback, so step.model is
    // the effective model; the `|| this.claude.model` is a defensive belt-and-
    // braces for the (guarded) case where stepModels is null.
    const step = (this.stepModels && this.stepModels[role]) || {};
    return {
      projectDir: this.workDir,
      pipelineDir: this.pipeline.dir,
      pipelineId: this.pipeline.id,
      taskPrompt: this.pipeline.promptText,
      toolInstruction: this.toolInstruction,
      agentPrompts: this.agentPrompts,
      fanOut,
      checkpointRef: this.checkpointRef,
      // Workspace metadata for prompt injection (undefined on a single-project run,
      // so buildSystemPrompt/taskHeader emit the byte-identical single-project text).
      workspace: this.isWorkspace ? this._workspaceChannel() : undefined,
      onEvent: (e) => this._onAgentEvent(role, e),
      signal: AbortSignal.any([this.abort.signal, this.pauseAbort.signal]),
      claudeOpts: {
        bin: this.claude.bin,
        permissionMode: this.claude.permissionMode,
        model: step.model || this.claude.model, // per-role, falling back to global
        effort: step.effort,                     // per-role effort (undefined when unset)
        mock: this.claude.mock,
      },
    };
  }

  /**
   * Stable step key for a node occurrence. Parallel nodes in the same step share
   * stepIndex but differ by nodeId; loop re-runs differ by cycle. Format keeps the
   * legacy `phase#cycle` readability while staying unique per node:
   *   "<stepIndex>:<nodeId>#<cycle>"  (cycle omitted when 1 and not a loop re-run)
   */
  _stepKeyFor(node, stepIndex, cycle) {
    const c = Number(cycle) > 1 ? `#${cycle}` : '';
    return `${stepIndex}:${node.nodeId}${c}`;
  }

  /** List the user's attached files copied into <pipeline>/extras/ (basename + abs
   *  path), sorted for deterministic seeded-file content. Empty when none were
   *  attached or the dir is absent. */
  async _collectExtras() {
    try {
      const dir = join(this.pipeline.dir, 'extras');
      const names = (await readdir(dir)).sort();
      return names.map((name) => ({ name, path: join(dir, name) }));
    } catch {
      return [];
    }
  }

  /**
   * Node execution context. Extends the legacy _phaseCtx shape but is keyed by the
   * node (model/effort come from the resolved plan node, not a role lookup) and
   * tags every emit + cost with { nodeId, stepIndex, cycle } so parallel/looped
   * emits are attributable. `node.agentKeyForPrompt` lets a node reuse an existing
   * agent's prompt body (the default-workflow nodes set this to their role).
   * @param {object} node    plan Node { nodeId, key, runnerType, model, effort, ... }
   * @param {{stepIndex:number, cycle:number}} pos
   */
  _nodeCtx(node, pos = {}) {
    const stepIndex = Number(pos.stepIndex) || 0;
    const cycle = Number(pos.cycle) > 0 ? Number(pos.cycle) : 1;
    const stepKey = this._stepKeyFor(node, stepIndex, cycle);
    return {
      projectDir: this.workDir,
      pipelineDir: this.pipeline.dir,
      pipelineId: this.pipeline.id,
      taskPrompt: this.pipeline.promptText,
      toolInstruction: this.toolInstruction,
      agentPrompts: this.agentPrompts,
      checkpointRef: this.checkpointRef,
      // Workspace metadata for prompt injection — reaches EVERY dispatched runner
      // (it does not depend on a node declaring `workspace` in consumes). undefined
      // on a single-project run, preserving byte-identical prompts. _bindNodeIo's
      // legacyFields would surface the same handle if the node consumed the channel.
      workspace: this.isWorkspace ? this._workspaceChannel() : undefined,
      signal: AbortSignal.any([this.abort.signal, this.pauseAbort.signal]),
      node,
      nodeId: node.nodeId,
      stepIndex,
      cycle,
      isEntry: stepIndex === 0,
      extras: this.extrasFiles || [],
      onEvent: (e) => this._onAgentEvent(node.key, e, { nodeId: node.nodeId, stepIndex, cycle, stepKey, uiPhase: node.uiPhase || node.key }),
      claudeOpts: {
        bin: this.claude.bin,
        permissionMode: this.claude.permissionMode,
        model: node.model || this.claude.model, // per-node, falling back to global
        effort: node.effort,                     // per-node effort (undefined when unset)
        mock: this.claude.mock,
      },
    };
  }

  /**
   * Record/transition a node's step (parallel-safe analogue of _recordStep). The
   * key is the node-derived stepKey so concurrent nodes never collide. On 'start'
   * it does NOT pause sibling clocks (parallel nodes run simultaneously); on a
   * terminal marker it folds just this node's clock.
   */
  _nodeStep(node, stepIndex, cycle, status) {
    const key = this._stepKeyFor(node, stepIndex, cycle);
    const now = new Date().toISOString();
    let step = this.state.steps.find((s) => s.key === key);
    if (!step) {
      step = {
        key, phase: node.key, nodeId: node.nodeId, stepIndex, cycle,
        status, startedAt: now, updatedAt: now, activeMs: 0, runningSince: null,
      };
      this.state.steps.push(step);
    } else {
      step.status = status;
      step.updatedAt = now;
    }
    if (status === 'start') this._clockResume(key);
    else this._clockPause(key);
    this.state.totalActiveMs = sumStepActive(this.state.steps);
    // CONV-4: drive the live-UI stepper. Mirror the legacy `_phase` emit
    // (orchestrator.mjs:710-719) but WITHOUT its `_recordStep` call (this method
    // already records the step). `node.uiPhase` is stamped by resolveWorkflow
    // (Phase 2 Task 6); on a parallel step the last-started node wins the scalar
    // phase (per-node attribution lives in state.steps[]). Confirm the 'phase'
    // payload against app.js `onPhase` (:308) before landing.
    this.state.phase = node.uiPhase || node.key;
    this.state.cycle = cycle;
    this.state.updatedAt = now;
    this._emit('phase', { phase: this.state.phase, cycle, status, nodeId: node.nodeId });
    // Backstop (§5.2): when a step reaches its terminal marker, force-close any
    // sub-agent still 'running' for THIS step so the UI never shows a stuck-active
    // square if a tool_result finish was missed. 'start' never closes anything;
    // the close status is 'stopped' when the run was stopped or is pausing (pause
    // SIGTERMs in-flight children too), else 'finished'.
    if (status === 'done' || status === 'error' || status === 'stopped' || status === 'paused') {
      const closeTo = (this.state.status === 'stopped' || this.state.status === 'pausing') ? 'stopped' : 'finished';
      for (const rec of this.state.subAgents) {
        if (rec.stepKey !== key || rec.status !== 'running') continue;
        rec.status = closeTo;
        rec.finishedAt = new Date().toISOString();
        this._upsertSubAgent(rec);
        this._subAgentTransition('finish', rec);
      }
    }
    this._emit('state', this.getState());
    this._persist().catch(() => {});
  }

  /** Translate a low-level claude/mock event into a pipeline 'log' event. */
  _onAgentEvent(role, e, attr = null) {
    if (!e) return;
    // Sub-agent telemetry (feature-detected, gated by MAESTRO_SUBAGENT_HOOKS). A
    // surfaced PostToolUse:Agent hook-event carries the parent tool_use_id +
    // tool_response telemetry; enrich the matching record's columns, keyed by
    // tool_use_id (the canonical key — never agent_id). Returns early: a hook
    // event has no human text and no cost to attribute.
    if (e.type === 'hook-event') {
      this._recordSubAgentTelemetry(e.raw);
      return;
    }
    // Pause/Resume: stamp the claude session id on the step that spawned it, and
    // persist eagerly — a later pause (or even a crash) must find it in the DB.
    if (e.type === 'session' && typeof e.sessionId === 'string') {
      const key = attr?.stepKey;
      const step = key ? this.state.steps.find((s) => s.key === key) : null;
      if (step && step.sessionId !== e.sessionId) {
        step.sessionId = e.sessionId;
        this._persist().catch(() => {});
      }
      return;
    }
    // Capture actual spend before anything returns early. The runner tags the
    // terminal stream-json `result` with costUsd (Claude's total_cost_usd; 0 in
    // mock). Fall back to raw.total_cost_usd defensively. e.raw may be a string
    // (non-JSON line) — `.type` on it is just undefined, so this never throws.
    // `e.costUsd != null` keeps a genuine 0 (which `!= null` is true for).
    const cost = e.costUsd != null
      ? Number(e.costUsd)
      : (e.raw && e.raw.type === 'result' ? Number(e.raw.total_cost_usd ?? e.raw.cost_usd) : NaN);
    if (Number.isFinite(cost)) this._recordCost(cost, attr?.stepKey);
    else if (e.raw && e.raw.type === 'result' && !this.claude.mock) {
      this._log('orchestrator', 'warn', 'result event carried no cost estimate (total_cost_usd absent)', attr);
    }

    // Sub-agent attribution. A child (Task/Agent) event carries parent_tool_use_id
    // = the id of the parent's Task tool_use block; main-agent events carry null/
    // absent. parent_tool_use_id is a TOP-LEVEL stream-json field; the message-
    // nested read is defensive. On a string `raw`, both reads yield undefined.
    const subId = e.raw?.parent_tool_use_id ?? e.raw?.message?.parent_tool_use_id ?? null;

    // Learn Task/Agent descriptions from MAIN-agent events (subId == null) so the
    // child events below can be labeled by what their sub-agent was asked to do.
    if (subId == null) {
      registerSubAgents(e.raw, this._subAgentLabels);
      // Lifecycle: a NEW Task/Agent tool_use on the MAIN stream = a sub-agent spawn.
      // Needs `attr` to pin nodeId/stepIndex/cycle/stepKey; the clarify pre-step
      // (attr === null) carries no node, so it is logged but not lifecycle-tracked.
      if (attr) this._recordSubAgentSpawns(e.raw, attr);
      // Finish: a tool_result on the MAIN stream whose tool_use_id is a tracked
      // sub-agent → finished/error. These `user` envelopes were previously dropped.
      this._recordSubAgentFinishes(e.raw);
    }

    // Capture named-skill / MCP-tool usage for the Sub-agents dropdown pills
    // (main agent -> its step; sub-agent -> its record). Independent of the
    // text/tool log branches below (it runs BEFORE the `if (text) return`), so a
    // mixed text+tool_use turn is still caught.
    this._recordSkills(e.raw, subId, attr);
    // Count graphify CLI invocations (Bash only) per agent / sub-agent. Bash-only
    // by design: the graphify skill runs the CLI itself, so counting the Skill tool
    // too would double-count; the bash invocation is the ground truth and also
    // catches direct CLI use with no skill.
    this._recordGraphify(e.raw, subId, attr);

    // Display source: parent role for main events; "role ▸ label" for sub-agent
    // events. `sub` drives the indented/dimmed web styling.
    let source = role;
    let sub = false;
    if (subId != null) {
      let label = this._subAgentLabels.get(subId);
      if (!label) {
        label = `sub-agent-${++this._subAgentFallbackSeq}`;
        this._subAgentLabels.set(subId, label); // stamp so the ordinal stays stable for this id
      }
      source = `${role} ▸ ${label}`;
      sub = true;
    }
    // Preserve the step attribution (nodeId/stepIndex/cycle) carried by attr so a
    // sub-agent line stays pinned to the right pipeline step/cycle in the UI; just
    // add `sub`. {...null} === {}, so attr === null (the clarify pre-step) is safe.
    const logAttr = sub ? { ...attr, sub: true } : attr;

    const text = (e.text || '').trim();
    if (text) {
      this._log(source, 'info', text, logAttr);
      return;
    }
    // No human-readable text. Rather than echo the bare stream-json envelope
    // type (the old noisy `[planner] user` / `[planner] system` lines), surface
    // the concrete tool calls the agent made this turn. Contentless envelope
    // events — tool_result echoes (`user`) and the init `system` event — carry
    // no information and are dropped.
    for (const call of describeToolUses(e.raw, this.projectDir)) {
      this._log(source, 'debug', `→ ${call}`, logAttr);
    }
  }

  /**
   * Lifecycle spawn reducer: for every NEW Task/Agent tool_use block in a
   * MAIN-stream event, push a `running` sub-agent record (attributed to the
   * step via `attr`), mirror it to the sub_agents table, and emit a `spawn`
   * delta. Idempotent per tool_use id (re-seen ids are skipped). `attr` is
   * required (the caller only invokes this when a node is in scope).
   */
  _recordSubAgentSpawns(raw, attr) {
    const content = raw?.message?.content;
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (c?.type !== 'tool_use' || (c.name !== 'Task' && c.name !== 'Agent') || !c.id) continue;
      if (this.state.subAgents.some((s) => s.id === c.id)) continue; // idempotent
      const label = this._subAgentLabels.get(c.id) || clip(c.input?.description || c.input?.prompt, SUBAGENT_LABEL_MAX);
      const rec = {
        id: c.id,
        label: label || null,
        nodeId: attr.nodeId ?? null,
        uiPhase: attr.uiPhase ?? null,
        stepIndex: attr.stepIndex ?? null,
        cycle: attr.cycle ?? null,
        stepKey: attr.stepKey ?? null,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        subagentType: c.input?.subagent_type ?? null,
      };
      this.state.subAgents.push(rec);
      this._upsertSubAgent(rec);
      this._subAgentTransition('spawn', rec);
    }
  }

  /**
   * Lifecycle finish reducer: scan a MAIN-stream event's content for a
   * tool_result whose tool_use_id is a tracked sub-agent. Set status =
   * is_error ? 'error' : 'finished' and stamp finishedAt, but ONLY while the
   * record is still 'running' (a late/duplicate tool_result must not flip a
   * terminal record back or re-emit). Mirrors to the table + emits a `finish`
   * delta. The finish envelope is `{type:'user', message:{content:[{type:
   * 'tool_result', tool_use_id, is_error?:true}]}}` — previously dropped.
   */
  _recordSubAgentFinishes(raw) {
    const content = raw?.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type !== 'tool_result' || !b.tool_use_id) continue;
      const rec = this.state.subAgents.find((s) => s.id === b.tool_use_id);
      if (!rec || rec.status !== 'running') continue; // unknown id or already terminal
      rec.status = b.is_error ? 'error' : 'finished';
      rec.finishedAt = new Date().toISOString();
      this._upsertSubAgent(rec);
      this._subAgentTransition('finish', rec);
    }
  }

  /**
   * Record skills / MCP-tools used in one agent event. Routes by parent_tool_use_id:
   * a MAIN-agent turn (subId == null) attributes to its pipeline step (by stepKey);
   * a sub-agent turn (subId != null) attributes to the spawned record (id === subId).
   * Grows a deduped, capped `skills` array and emits a delta + persists ONLY when the
   * set actually changed. No-op when there is nothing to attribute to (e.g. the
   * clarify pre-step has no step; a child event seen before its spawn).
   */
  _recordSkills(raw, subId, attr) {
    const labels = extractSkillLabels(raw);
    if (!labels.length) return;
    if (subId == null) {
      const key = attr?.stepKey;
      const step = key ? this.state.steps.find((s) => s.key === key) : null;
      if (!step) return;
      const merged = mergeSkills(step.skills, labels);
      if (!merged) return;
      step.skills = merged;
      this._emit('stepskills', {
        stepKey: step.key,
        nodeId: step.nodeId ?? null,
        cycle: step.cycle ?? null,
        skills: merged,
        ts: new Date().toISOString(),
      });
      this._persist().catch(() => {}); // mirrors _recordCost: per-step skills survive a reload
    } else {
      const rec = this.state.subAgents.find((s) => s.id === subId);
      if (!rec) return;
      const merged = mergeSkills(rec.skills, labels);
      if (!merged) return;
      rec.skills = merged;
      this._upsertSubAgent(rec);
      this._subAgentTransition('update', rec);
    }
  }

  /**
   * Count graphify CLI invocations (Bash only) in one agent event and add them to
   * the running total. Routes exactly like _recordSkills: a MAIN-agent turn
   * (subId == null) accrues onto its pipeline step (by stepKey) and emits a
   * `stepgraphify` delta; a sub-agent turn accrues onto the spawned record and
   * emits a `subagent` update. No-op when the event invoked graphify zero times or
   * there is nothing to attribute to (clarify pre-step; child seen before spawn).
   */
  _recordGraphify(raw, subId, attr) {
    const n = countGraphifyBashCalls(raw);
    if (!n) return;
    if (subId == null) {
      const key = attr?.stepKey;
      const step = key ? this.state.steps.find((s) => s.key === key) : null;
      if (!step) return;
      step.graphifyCount = (step.graphifyCount ?? 0) + n;
      this._emit('stepgraphify', {
        stepKey: step.key,
        nodeId: step.nodeId ?? null,
        cycle: step.cycle ?? null,
        graphifyCount: step.graphifyCount,
        ts: new Date().toISOString(),
      });
      this._persist().catch(() => {}); // mirrors _recordSkills: survives a reload
    } else {
      const rec = this.state.subAgents.find((s) => s.id === subId);
      if (!rec) return;
      rec.graphifyCount = (rec.graphifyCount ?? 0) + n;
      this._upsertSubAgent(rec);
      this._subAgentTransition('update', rec);
    }
  }

  /** Best-effort mirror of a sub-agent record to the sub_agents table. Guarded
   *  exactly like _persist/_artifact: no pipeline → in-memory only (unit ctx). */
  _upsertSubAgent(rec) {
    if (!this.pipeline) return;
    try { upsertSubAgent(this.pipeline.id, rec); } catch { /* best-effort */ }
  }

  /** Emit a hybrid `subagent` delta. The full `state` snapshot remains the
   *  reconcile/late-join source of truth (it carries subAgents). */
  _subAgentTransition(transition, rec) {
    this._emit('subagent', {
      transition,
      id: rec.id,
      label: rec.label ?? null,
      nodeId: rec.nodeId ?? null,
      uiPhase: rec.uiPhase ?? null,
      stepKey: rec.stepKey ?? null,
      stepIndex: rec.stepIndex ?? null,
      cycle: rec.cycle ?? null,
      status: rec.status,
      ...(rec.durationMs != null ? { durationMs: rec.durationMs } : {}),
      ...(rec.tokens != null ? { tokens: rec.tokens } : {}),
      ...(rec.costUsd != null ? { costUsd: rec.costUsd } : {}),
      ...(Array.isArray(rec.skills) ? { skills: rec.skills } : {}),
      ...(rec.subagentType != null ? { subagentType: rec.subagentType } : {}),
      ...(rec.graphifyCount != null ? { graphifyCount: rec.graphifyCount } : {}),
      ts: new Date().toISOString(),
    });
  }

  /**
   * Telemetry enrichment from a surfaced PostToolUse:Agent hook-event. Reads the
   * parent tool_use_id + tool_response.{totalDurationMs,totalTokens,usage} and
   * fills the matching sub-agent record's durationMs/tokens/costUsd (only those
   * present), mirrors to the table, and emits an `update` delta. No-op for an
   * unknown id or a non-Agent hook. Strictly additive — the baseline lifecycle
   * needs none of this.
   */
  _recordSubAgentTelemetry(raw) {
    const id = raw?.tool_use_id ?? raw?.tool_response?.tool_use_id ?? null;
    if (!id) return;
    const rec = this.state.subAgents.find((s) => s.id === id);
    if (!rec) return;
    const tr = raw?.tool_response || {};
    if (Number.isFinite(Number(tr.totalDurationMs))) rec.durationMs = Number(tr.totalDurationMs);
    if (Number.isFinite(Number(tr.totalTokens))) rec.tokens = Number(tr.totalTokens);
    const cost = tr.usage?.cost_usd ?? tr.usage?.total_cost_usd ?? tr.cost_usd;
    if (Number.isFinite(Number(cost))) rec.costUsd = Number(cost);
    this._upsertSubAgent(rec);
    this._subAgentTransition('update', rec);
  }

  // ── git checkpoint ─────────────────────────────────────────────────────────

  /**
   * Ensure `dir` is its OWN git repo with at least one commit, and return its
   * checkpoint ref (HEAD), or null when none could be established. Pure of state
   * writes — the caller wires checkpointRef(s)/state. Single-project and each
   * workspace member call this with their own dir (D3: never an enclosing repo).
   * @param {string} dir
   * @returns {Promise<string|null>}
   */
  async _ensureGitCheckpointFor(dir) {
    // C2: `--is-inside-work-tree` is true even when dir merely sits *inside* an
    // enclosing repo (no .git of its own). Acting on that parent repo would
    // silently create maestro/* branches + checkpoint commits in the developer's
    // real repo. Require dir to BE the repo toplevel; if it isn't (no repo, or
    // only a parent repo), `git init` a dedicated repo here.
    const projReal = await realpath(dir).catch(() => resolve(dir));
    const top = await this._git(['rev-parse', '--show-toplevel'], { cwd: dir });
    let topReal = null;
    if (top.ok && top.stdout.trim()) {
      topReal = await realpath(top.stdout.trim()).catch(() => top.stdout.trim());
    }
    const isOwnRepo = topReal === projReal;
    if (!isOwnRepo) {
      if (topReal) {
        this._log(
          'git',
          'info',
          `${dir} is nested in repo ${topReal}; initializing a dedicated repo to isolate worktrees.`,
        );
      }
      await this._git(['init'], { cwd: dir });
      // Ensure an identity exists for the commit (local, non-destructive).
      await this._git(['config', 'user.email', 'orchestrator@local'], { cwd: dir });
      await this._git(['config', 'user.name', 'orchestrator'], { cwd: dir });
    }
    // Is there any commit yet?
    const head = await this._git(['rev-parse', 'HEAD'], { cwd: dir });
    if (!head.ok) {
      await this._git(['add', '-A'], { cwd: dir });
      const commit = await this._git([
        '-c',
        'user.email=orchestrator@local',
        '-c',
        'user.name=orchestrator',
        'commit',
        '--allow-empty',
        '-m',
        'orchestrator: initial checkpoint',
      ], { cwd: dir });
      if (!commit.ok) {
        this._log('git', 'warn', `initial commit failed: ${commit.stderr.trim()}`);
      }
    }
    const ref = await this._git(['rev-parse', 'HEAD'], { cwd: dir });
    return ref.ok ? ref.stdout.trim() : null;
  }

  /**
   * Layer 1: build + persist the deterministic results view while the worktree(s)
   * and checkpoint refs are still live. Best-effort: never throws into run().
   */
  async _buildResults() {
    if (!this.pipeline) return;
    try {
      const reviews = readPipelineExtras(this.pipeline.id).reviews || [];
      if (this.isWorkspace) {
        const members = [];
        const patches = [];
        for (const [projectKey, dir] of this.workDirs.entries()) {
          const base = this.checkpointRefs[projectKey];
          if (!base) continue;
          const [ns, num, patch] = await Promise.all([
            diffNameStatus(dir, base), diffNumstat(dir, base), diffPatch(dir, base),
          ]);
          const results = assembleResults({ nameStatus: ns, numstat: num, reviews });
          members.push({ projectKey, results });
          patches.push(`# ${projectKey}\n${patch}`);
        }
        const perProject = buildPerProject(members);
        const results = { summary: rollupSummary(perProject), perProject };
        await persistResults(this.pipeline.dir, results);
        await persistDiffPatch(this.pipeline.dir, patches.join('\n\n'));
      } else {
        const base = this.checkpointRef;
        if (!base) return;
        const dir = this.workDir || this.projectDir;
        const [ns, num, patch] = await Promise.all([
          diffNameStatus(dir, base), diffNumstat(dir, base), diffPatch(dir, base),
        ]);
        const results = assembleResults({ nameStatus: ns, numstat: num, reviews });
        await persistResults(this.pipeline.dir, results);
        await persistDiffPatch(this.pipeline.dir, patch);
      }
    } catch (err) {
      this._log('results', 'warn', `results build failed: ${err.message}`);
    }
  }

  /** Single-project checkpoint: own repo + commit, record the scalar ref + state. */
  async _ensureGitCheckpoint() {
    this.checkpointRef = await this._ensureGitCheckpointFor(this.projectDir);
    this.state.checkpointRef = this.checkpointRef;
    if (this.checkpointRef) {
      await appendAudit(
        this.pipeline.dir,
        `Git checkpoint at \`${this.checkpointRef.slice(0, 10)}\`.`,
      );
    } else {
      this._log('git', 'warn', 'No git checkpoint ref could be established (continuing).');
    }
  }

  /**
   * Workspace checkpoint: run _ensureGitCheckpointFor once per member (serial —
   * git is cheap and serial avoids interleaved index locks), record
   * this.checkpointRefs[projectKey], mirror the scalar this.checkpointRef to the
   * primary, and write state.checkpointRefs (+ scalar). Members are iterated in
   * sorted-projectKey order so the primary is members[0].
   */
  async _ensureGitCheckpointAll() {
    for (const m of this.members) {
      const ref = await this._ensureGitCheckpointFor(resolve(m.projectDir));
      this.checkpointRefs[m.projectKey] = ref;
      if (ref) {
        await appendAudit(
          this.pipeline.dir,
          `Git checkpoint for \`${m.projectKey}\` at \`${ref.slice(0, 10)}\`.`,
        ).catch(() => {});
      } else {
        this._log('git', 'warn', `No git checkpoint ref for ${m.projectKey} (continuing).`);
      }
    }
    const primaryKey = this.members[0]?.projectKey;
    this.checkpointRef = primaryKey ? this.checkpointRefs[primaryKey] : null;
    this.state.checkpointRef = this.checkpointRef;
    this.state.checkpointRefs = { ...this.checkpointRefs };
    await this._persist();
  }

  /**
   * Stage every change in the working tree with intent-to-add so that newly
   * created (untracked) files show up in a plain `git diff` for the reviewer.
   * Uses `git add -A -N`: it records intent-to-add for new paths (making their
   * content visible to `git diff`) without actually creating a commit, so the
   * checkpoint commit remains the single diff base. Best-effort; never throws.
   */
  async _stageWorkingTree() {
    if (this.isWorkspace) {
      // Stage EVERY member worktree (not just primary) so each per-project
      // reviewer's `git diff` sees that project's agent edits.
      for (const dir of this.workDirs.values()) {
        const res = await this._git(['add', '-A', '-N'], { cwd: dir });
        if (!res.ok && res.stderr && res.stderr.trim()) {
          this._log('git', 'debug', `git add -A -N (${dir}): ${res.stderr.trim()}`);
        }
      }
      return;
    }
    // Stage inside the worktree so the reviewer's `git diff` sees agent edits.
    const res = await this._git(['add', '-A', '-N'], { cwd: this.workDir });
    if (!res.ok && res.stderr && res.stderr.trim()) {
      this._log('git', 'debug', `git add -A -N: ${res.stderr.trim()}`);
    }
  }

  /**
   * Run a git command in the project dir. Never throws; returns
   * { ok, code, stdout, stderr }. Honors the abort signal.
   */
  _git(args, { cwd, ignoreAbort = false } = {}) {
    return new Promise((resolveP) => {
      let child;
      try {
        child = spawn('git', args, {
          cwd: cwd || this.projectDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          // ignoreAbort: teardown commits run AFTER the run is aborted (stop/error);
          // binding the aborted signal here would kill them instantly and leave the
          // kept branch empty. Cleanup git must outlive the abort.
          signal: ignoreAbort ? undefined : this.abort.signal,
        });
      } catch (err) {
        resolveP({ ok: false, code: -1, stdout: '', stderr: err.message });
        return;
      }
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => (stdout += d.toString()));
      child.stderr?.on('data', (d) => (stderr += d.toString()));
      child.on('error', (err) =>
        resolveP({ ok: false, code: -1, stdout, stderr: stderr || err.message }),
      );
      child.on('close', (code) => resolveP({ ok: code === 0, code: code ?? -1, stdout, stderr }));
    });
  }

  // ── agent prompt loading ───────────────────────────────────────────────────

  /** Bulk-load every registry agent's .md body keyed by agent key (fallback layer
   *  for runners whose ctx has no node, e.g. the clarify pre-step; dispatched nodes
   *  prefer node.agentPrompt via phases.resolveAgentBody). Registry-driven: built-in
   *  AND user agents load from their own layer via meta.agentPath. */
  async _loadAgentPrompts() {
    const prompts = {};
    const registry = this.registry || loadAgentRegistry(this.agentsDir);
    for (const meta of Object.values(registry)) {
      if (!meta.agentPath) { prompts[meta.key] = ''; continue; }
      try {
        prompts[meta.key] = await readFile(meta.agentPath, 'utf8');
      } catch {
        prompts[meta.key] = ''; // missing agent file => empty body (fails safe)
        this._log('orchestrator', 'warn', `Agent prompt missing: ${rel(this.projectDir, meta.agentPath)}`);
      }
    }
    return prompts;
  }

  // ── small utilities ─────────────────────────────────────────────────────────

  async _writeClarifyAnswers(questions, answers) {
    // M1: clarify answers live ONLY in the clarify DB row (the authoritative store).
    // The dead FS clarify-answers.json (never read back; the single-round loop passes
    // prior answers in-memory) is gone. Enrich each answer with its question text so
    // the row + History UI render the full Q&A without a join.
    const byId = new Map(questions.map((q) => [q.id, q]));
    const enriched = answers.map((a) => ({
      id: a.id,
      question: byId.get(a.id)?.question || '',
      choice: a.choice,
    }));
    await writeClarify(this.pipeline.id, { answers: { answers: enriched } });
    return enriched;
  }

  _deriveBaseName(promptText, title) {
    const fromTitle = title && title !== basename(this.pipeline?.dir || '') ? title : '';
    const source = fromTitle || firstLine(promptText) || 'feature';
    return slugify(source).slice(0, 40) || 'feature';
  }

  _checkAbort() {
    if (this.abort.signal.aborted || this.state.status === 'stopped') {
      const err = new Error('stopped');
      err.name = 'AbortError';
      throw err;
    }
  }

  _phase(phase, cycle, status, nodeId = null) {
    this.state.phase = phase;
    this.state.cycle = cycle;
    this._recordStep(phase, cycle, status, nodeId);
    this.state.updatedAt = new Date().toISOString();
    this._emit('phase', { phase, cycle, status });
    this._emit('state', this.getState());
    // Persist on phase boundaries so history/audit stay fresh.
    this._persist().catch(() => {});
  }

  _recordStep(phase, cycle, status, nodeId = null) {
    const key = cycle ? `${phase}#${cycle}` : phase;
    const now = new Date().toISOString();
    let step = this.state.steps.find((s) => s.key === key);
    if (!step) {
      step = { key, phase, cycle, status, startedAt: now, updatedAt: now, activeMs: 0, runningSince: null };
      // Attribute this phase's figures to a stepper node (clarify -> the plan
      // node) so the UI buckets it onto that cell. Totals are derived as Σ steps,
      // so labelling a step changes attribution only — it adds no ms/cost.
      if (nodeId) step.nodeId = nodeId;
      this.state.steps.push(step);
    } else {
      step.status = status;
      step.updatedAt = now;
      // Idempotent: a later marker (e.g. 'done') passes no nodeId and must not
      // clear the tag set at 'start'; never clobber an existing tag.
      if (nodeId && !step.nodeId) step.nodeId = nodeId;
    }
    if (status === 'start') {
      this._clockPauseAll();   // close out any prior running step
      this._clockResume(key);  // start this phase's active clock
    } else {
      this._clockPause(key);   // 'done' (or any terminal marker): finalize
    }
    // Keep the derived total in lockstep with the per-step figures (mirrors cost).
    this.state.totalActiveMs = sumStepActive(this.state.steps);
  }

  /**
   * Attribute a dollar cost to the step currently executing and roll it into
   * the pipeline total. The active step is identified by the live (phase,cycle)
   * — the SAME key _recordStep uses — because a `result` event always arrives
   * between that phase's 'start' and 'done' markers. Records the figure even when
   * it is 0 (so mock runs DISPLAY a truthful $0.00 rather than a blank); only
   * NaN/negative are ignored. Multiple results on one step accumulate. Emits a
   * 'state' snapshot so a live UI updates, and persists so history (state.json)
   * carries the figure.
   * @param {number} costUsd
   */
  _recordCost(costUsd, stepKey = null) {
    if (!Number.isFinite(costUsd) || costUsd < 0) return;
    const key = stepKey
      || (this.state.cycle ? `${this.state.phase}#${this.state.cycle}` : this.state.phase);
    const step = this.state.steps.find((s) => s.key === key);
    if (step) step.costUsd = roundUsd((step.costUsd || 0) + costUsd);
    // Derive the pipeline total from the per-step figures so it ALWAYS equals
    // their sum. Keeping a separate running total and rounding it on every add
    // drifts from Σ steps (e.g. 0.00005 + 0.00015 gave total 0.0003 vs Σ 0.0002).
    this.state.totalCostUsd = sumStepCosts(this.state.steps);
    this.state.updatedAt = new Date().toISOString();
    this._emit('state', this.getState());
    this._persist().catch(() => {});
  }

  /** Start (resume) the active-time clock for a step key, idempotently. */
  _clockResume(key) {
    const step = this.state.steps.find((s) => s.key === key);
    if (step && step.runningSince == null) step.runningSince = Date.now();
  }

  /** Pause a step's clock, folding the elapsed run into activeMs. No-op if idle. */
  _clockPause(key) {
    const step = this.state.steps.find((s) => s.key === key);
    if (!step || step.runningSince == null) return;
    step.activeMs = (step.activeMs || 0) + Math.max(0, Date.now() - step.runningSince);
    step.runningSince = null;
  }

  /** Pause every running step (defensive: only one runs at a time normally). */
  _clockPauseAll() {
    for (const s of this.state.steps) {
      if (s.runningSince != null) this._clockPause(s.key);
    }
  }

  /** Key of the step whose clock is currently running, or null. */
  _runningStepKey() {
    const s = this.state.steps.find((x) => x.runningSince != null);
    return s ? s.key : null;
  }

  /** Live total = finalized activeMs (sumStepActive) + the running tail. Test/diagnostic. */
  liveActiveMs() {
    const now = Date.now();
    let sum = 0;
    for (const s of this.state.steps) {
      sum += (s.activeMs || 0) + (s.runningSince != null ? Math.max(0, now - s.runningSince) : 0);
    }
    return sum;
  }

  _setStatus(status) {
    this.state.status = status;
    if (status === 'done' || status === 'stopped' || status === 'error' || status === 'paused') {
      this._clockPauseAll();
      this.state.totalActiveMs = sumStepActive(this.state.steps);
    }
    this.state.updatedAt = new Date().toISOString();
    this._emit('state', this.getState());
  }

  _log(source, level, text, attr = null) {
    const evt = { source, level, text, ts: new Date().toISOString() };
    if (attr) {
      if (attr.nodeId != null) evt.nodeId = attr.nodeId;
      if (attr.stepIndex != null) evt.stepIndex = attr.stepIndex;
      if (attr.cycle != null) evt.cycle = attr.cycle;
      if (attr.sub) evt.sub = true;        // drives sub-agent web styling
    }
    this._emit('log', evt);
    this.logWriter.push(evt); // persist the full stream (buffered; flushed on a timer)
  }

  _artifact(kind, path) {
    this._emit('artifact', { kind, path });
    // Phase 3.9: ALSO index FS markdown/extra paths so pipeline-delete (Task 3.13)
    // can unlink the EXACT files later (best-effort; never blocks a run). Skip the
    // synthetic 'pipeline'/'clarify' kinds (clarify lives in the clarify table;
    // 'pipeline' is the dir itself). plan/review markdown live under
    // <store>/<key>/{plans,reviews} (store-root-relative); checklist/webui live in
    // the pipeline dir (dir-relative).
    if (!this.pipeline || !path || kind === 'pipeline' || kind === 'clarify' || kind === 'questions') return;
    let relPath = null;
    const pdir = this.pipeline.dir;
    if (path.startsWith(pdir + sep)) {
      relPath = relative(pdir, path);                 // dir-relative (checklist, webui)
    } else {
      const root = this.isWorkspace
        ? workspaceStorePath(this.workspaceKey)
        : projectStorePath(projectKey(this.projectDir));
      if (path.startsWith(root + sep)) relPath = relative(root, path); // store-rel (plan/review)
    }
    if (relPath) recordArtifact(this.pipeline.id, kind, relPath);
  }

  _emit(event, payload) {
    try {
      this.emit(event, payload);
    } catch {
      /* never let a listener crash the state machine */
    }
  }

  /**
   * Fire-and-forget: generate a concise LLM title and, when ready, persist + broadcast it.
   * The promise is stored on this._titlePromise for test determinism but is NEVER awaited
   * by run() (must not delay the run). Aborts with the run via this.abort.signal.
   */
  _kickoffTitleGeneration() {
    const prompt = this.pipeline?.promptText || this.opts.prompt || '';
    const id = this.pipeline?.id;
    if (!prompt || !id) { this._titlePromise = Promise.resolve(); return; }
    this._titlePromise = Promise.resolve()
      .then(() => generateTitle(prompt, {
        cwd: this.projectDir,
        signal: this.abort.signal,
      }))
      .then((real) => {
        if (!real || real === this.state.title) return;     // empty / unchanged → keep provisional
        if (this.abort.signal.aborted) return;
        this.state.title = real;
        this.state.titleProvisional = false;
        this.state.updatedAt = new Date().toISOString();
        updatePipelineTitle(id, real);                      // persist (dedicated UPDATE)
        // Carry pipelineId: the client run model has no pipeline id; History patch needs it.
        this._emit('title', { title: real, provisional: false, pipelineId: id }); // live broadcast
      })
      .catch(() => { /* generateTitle already swallows; this is a final backstop */ });
  }

  async _persist() {
    if (!this.pipeline) return;
    try {
      await writeState(this.pipeline.dir, this.state);
    } catch {
      /* persistence is best-effort */
    }
  }

  /** Begin owning this run's row: stamp pid/host + start the heartbeat timer. Idempotent. */
  _startHeartbeat() {
    if (!this.pipeline?.id) return;
    claimPipelineOwnership(this.pipeline.id);
    if (this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(() => {
      try { touchHeartbeat(this.pipeline.id); } catch { /* best-effort */ }
    }, HEARTBEAT_INTERVAL_MS);
    this._heartbeatTimer.unref?.(); // never hold the process open
  }

  /** Stop heartbeating and drop ownership (terminal/paused). Safe to call repeatedly. */
  _stopHeartbeat() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    if (this.pipeline?.id) clearPipelineOwnership(this.pipeline.id);
  }

  /** Terminal bookkeeping for a pause: persist the resume point + paused status. */
  async _completePaused() {
    this._setStatus('paused');
    await this._persist();
    // A plain manual pause has no reason; only a limit-pause records one (audited
    // already at the pause site, so don't double-log it here).
    if (!this.pauseReason) await appendAudit(this.pipeline.dir, `Pipeline **paused**.`).catch(() => {});
    this._emit('done', { status: 'paused', pipelineDir: this.pipeline.dir, reason: this.pauseReason || null });
    return { status: 'paused', pipelineDir: this.pipeline.dir, reason: this.pauseReason || null };
  }
}

// ── module-level pure helpers ──────────────────────────────────────────────────

function numOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** Round a USD amount to 4 decimals (tenth-of-a-cent) to avoid float drift. */
function roundUsd(n) {
  return Math.round((Number(n) || 0) * 1e4) / 1e4;
}

/**
 * Sum per-step costUsd into the pipeline total, rounded ONCE so the total is
 * exactly Σ steps (avoids the drift of independently rounding a separate running
 * total on every add). Absent/NaN step costs are ignored.
 * @param {Array<{costUsd?:number}>} steps
 * @returns {number}
 */
function sumStepCosts(steps) {
  let sum = 0;
  for (const s of Array.isArray(steps) ? steps : []) {
    if (Number.isFinite(s?.costUsd)) sum += s.costUsd;
  }
  return roundUsd(sum);
}

/**
 * Sum per-step active processing time (ms) into the pipeline total. Only the
 * FINALIZED activeMs is summed here; a still-running step's tail is added live
 * by consumers (liveActiveMs / the UI). Absent/NaN values are ignored. No
 * rounding (durations are integer ms).
 * @param {Array<{activeMs?:number}>} steps
 * @returns {number}
 */
function sumStepActive(steps) {
  let sum = 0;
  for (const s of Array.isArray(steps) ? steps : []) {
    if (Number.isFinite(s?.activeMs)) sum += s.activeMs;
  }
  return sum;
}

function isAbort(err) {
  return err && (err.name === 'AbortError' || /aborted|stopped/i.test(err.message || ''));
}

/** Pause sentinel: thrown to unwind _dispatch when pause() was requested. */
function pauseErr() {
  const e = new Error('paused');
  e.name = 'PauseError';
  return e;
}
function isPause(err) {
  return !!err && err.name === 'PauseError';
}

/** JSON round-trip clone; drops functions/undefined. Bus channels and resolved
 *  plan nodes are plain data, so this is lossless for them. */
function jsonClone(v) {
  return v == null ? null : JSON.parse(JSON.stringify(v));
}

/** Fail-safe JSON.parse for nullable DB text columns; null on absent/bad JSON. */
function safeParse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function firstLine(text) {
  if (!text) return '';
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.replace(/^#+\s*/, '').trim();
    if (t) return t;
  }
  return '';
}

function rel(base, p) {
  if (!p) return '';
  const b = resolve(base);
  const full = resolve(p);
  return full.startsWith(b + '/') ? full.slice(b.length + 1) : full;
}

/**
 * Describe the tool calls in a stream-json `assistant` event as readable
 * one-liners (e.g. `Read src/app.js`, `Bash npm test`). Returns [] for events
 * with no tool_use blocks — tool_result echoes, the system init event — so the
 * caller drops them instead of logging a contentless envelope type.
 */
// Max chars for the sub-agent label inside the "[role ▸ label]" tag. Deliberately
// shorter than toolTarget's 60-char Task clip: that 60 governs the parent's own
// "→ Task <desc>" debug line, which has a whole row to itself; this 40 governs the
// label embedded inside "[role ▸ label]", which shares a single flex row (web) and
// sits inline in the terminal, so it must stay compact. The two clips are
// independent on purpose — a long description may render at ≤60 on the parent line
// and ≤40 inside the child tag.
const SUBAGENT_LABEL_MAX = 40;

/**
 * Record id -> short description for every Task/Agent tool_use block in a
 * MAIN-agent event, so a sub-agent's later events (which carry that id as
 * parent_tool_use_id) can be labeled by the job they were given. Safe when
 * `raw` is a string (non-JSON runner line): raw?.message?.content is undefined.
 */
function registerSubAgents(raw, labels) {
  const content = raw?.message?.content;
  if (!Array.isArray(content)) return;
  for (const c of content) {
    if (c?.type === 'tool_use' && (c.name === 'Task' || c.name === 'Agent') && c.id && !labels.has(c.id)) {
      const desc = clip(c.input?.description || c.input?.prompt, SUBAGENT_LABEL_MAX);
      if (desc) labels.set(c.id, desc); // empty desc left unset → fallback assigns sub-agent-N
    }
  }
}

function describeToolUses(raw, projectDir) {
  const content = raw?.message?.content;
  if (!Array.isArray(content)) return [];
  const calls = [];
  for (const c of content) {
    if (c?.type === 'tool_use' && typeof c.name === 'string') {
      const target = toolTarget(c.name, c.input, projectDir);
      calls.push(target ? `${c.name} ${target}` : c.name);
    }
  }
  return calls;
}

/** A short, human-readable target for a tool call (file, command, pattern…). */
function toolTarget(name, input, projectDir) {
  if (!input || typeof input !== 'object') return '';
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return rel(projectDir, input.file_path || input.path || input.notebook_path || '');
    case 'Bash':
      return clip(input.command, 80);
    case 'Grep':
      return input.pattern
        ? `"${input.pattern}"${input.path ? ' ' + rel(projectDir, input.path) : ''}`
        : '';
    case 'Glob':
      return input.pattern || '';
    case 'Task':
    case 'Agent':
      return clip(input.description || input.prompt, 60);
    case 'WebFetch':
    case 'WebSearch':
      return clip(input.url || input.query, 60);
    default:
      return '';
  }
}

// ── Skill / MCP-tool capture (for the Sub-agents dropdown pills) ──────────────
// Pills surface ONLY named skills (the Skill tool) and MCP server tools
// (mcp__<server>__<tool>). Core file/bash/search/web tools and the sub-agent
// spawn tools (Task/Agent) are NOT skills. Labels are kind-tagged strings —
// "skill:<name>" / "mcp:<server>" — so the set dedups cleanly and the UI styles
// the two kinds without a second field. Capped per agent.
const SKILLS_MAX = 24;

/** Display server token for an MCP tool name `mcp__<server>__<tool>`: strip a
 *  leading `plugin_`, then collapse consecutive duplicate words. */
function mcpServerLabel(name) {
  const parts = String(name).split('__');
  let server = (parts[1] || '').trim();
  if (!server) return '';
  server = server.replace(/^plugin_/, '');
  const words = server.split('_').filter(Boolean);
  const collapsed = words.filter((w, i) => w !== words[i - 1]); // playwright_playwright -> playwright
  return collapsed.join('_') || server;
}

/** Kind-tagged pill label for ONE tool_use block, or '' if it is not a skill /
 *  MCP tool. The Skill slug key is read defensively (the one stream-json detail
 *  not pinned by a fixture). */
function skillLabel(name, input) {
  if (typeof name !== 'string') return '';
  if (name === 'Skill') {
    const raw = input && typeof input === 'object'
      ? (input.skill ?? input.name ?? input.command ?? input.skill_name) : '';
    const slug = typeof raw === 'string' ? raw.trim() : '';
    return slug ? `skill:${slug}` : '';
  }
  if (name.startsWith('mcp__')) {
    const server = mcpServerLabel(name);
    return server ? `mcp:${server}` : '';
  }
  return ''; // Read/Write/Edit/Bash/Grep/Glob/Task/Agent/WebFetch/WebSearch/… excluded
}

/** All kind-tagged skill labels in ONE stream-json envelope (deduped within the
 *  turn, order-preserving). */
function extractSkillLabels(raw) {
  const content = raw?.message?.content;
  if (!Array.isArray(content)) return [];
  const out = [];
  const seen = new Set();
  for (const c of content) {
    if (c?.type !== 'tool_use') continue;
    const label = skillLabel(c.name, c.input);
    if (label && !seen.has(label)) { seen.add(label); out.push(label); }
  }
  return out;
}

// ── graphify CLI-invocation counter ──────────────────────────────────────────
// Counts how many times a Bash command INVOKES the `graphify` CLI, as opposed to
// merely mentioning the word (reading graphify-out/, grepping for "graphify", rm
// graphify-out). Match `graphify` only at a COMMAND position: string start, after a
// shell separator (; | & && || newline or subshell `(`), or after leading VAR=val
// env assignments — optionally path-prefixed (~/.local/bin/graphify) — and followed
// by whitespace or end-of-string, so `graphify-out` (next char `-`) never matches.
// Known gaps (rare; documented, not counted): `npx graphify`, `python -m graphify`,
// `sh -c "graphify …"` — graphify there is an argument, not the command word.
const GRAPHIFY_CMD_RE = /(?:^|[;&|\n(]|&&|\|\|)\s*(?:\w+=\S+\s+)*(?:[^\s;&|()]*\/)?graphify(?=\s|$)/g;

/** How many graphify CLI invocations the Bash tool_use blocks of ONE stream-json
 *  envelope contain (0 when none / not a tool turn). Pure + module-scoped. */
function countGraphifyBashCalls(raw) {
  const content = raw?.message?.content;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const c of content) {
    if (c?.type !== 'tool_use' || c.name !== 'Bash') continue;
    const cmd = c.input?.command;
    if (typeof cmd !== 'string') continue;
    const m = cmd.match(GRAPHIFY_CMD_RE);
    if (m) n += m.length;
  }
  return n;
}

/** Union `incoming` into `existing` (order-preserving, deduped, capped). Returns
 *  the NEW array when it grew, else null (caller skips persist/emit). */
function mergeSkills(existing, incoming) {
  if (!incoming.length) return null;
  const base = Array.isArray(existing) ? existing : [];
  const seen = new Set(base);
  const out = base.slice();
  for (const x of incoming) {
    if (seen.has(x) || out.length >= SKILLS_MAX) continue;
    seen.add(x); out.push(x);
  }
  return out.length > base.length ? out : null;
}

/** Collapse whitespace and truncate to n chars with an ellipsis. */
function clip(text, n) {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Normalize an answer payload from answer()/auto into [{id, choice}].
 * Accepts { answers:[{id,choice}] } or a bare array. Fills any missing
 * questions with their first option so downstream never sees gaps.
 */
function normalizeClarifyAnswer(payload, questions) {
  const arr = Array.isArray(payload?.answers)
    ? payload.answers
    : Array.isArray(payload)
      ? payload
      : [];
  const byId = new Map();
  for (const a of arr) {
    if (a && a.id != null) byId.set(String(a.id), String(a.choice ?? ''));
  }
  return (questions || []).map((q) => ({
    id: q.id,
    choice: byId.has(q.id)
      ? byId.get(q.id)
      : (q.options && q.options.find((o) => o && o.trim())) || '',
  }));
}
