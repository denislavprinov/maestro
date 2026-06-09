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
import { readFile, writeFile, readdir, mkdir, realpath } from 'node:fs/promises';

import {
  createPipeline,
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
} from './artifacts.mjs';
import { projectKey, projectStorePath, workspaceStorePath } from './store.mjs';
import { detectTools, detectToolsPerProject, runGraphifyUpdate, worktreeGraphInstruction } from './preflight.mjs';
import { fanoutCap, mapWithCap } from './fanout.mjs';
import { resolveStepModels } from './config.mjs';
import { hasBlocking, blockingIssues } from './protocol.mjs';
import { runClarify } from './phases.mjs';
import { runners as defaultRunners } from './runners.mjs';
import { resolveWorkflow, buildStepperManifest, rewriteStepperForDecomposition } from './workflows.mjs';
import { allocate, bindInputs, publish, legacyFields, entrySeedChannels, renderPromptArtifact } from './channels.mjs';
import { loadAgentRegistry } from './agent-registry.mjs';
import { validateWorkflow } from './workflow-validator.mjs';
import {
  createWorktree, removeWorktree, suggestBranchName, sanitizeBranchName, resolveDefaultBranch,
  isValidSourceRef,
} from './worktree.mjs';

/**
 * Default location of the agent prompt markdown files, relative to this module.
 */
const DEFAULT_AGENTS_DIR = new URL('../../agents/', import.meta.url).pathname;

const AGENT_FILES = {
  clarify: 'maestro-clarify.md',
  planner: 'maestro-planner.md',
  refiner: 'maestro-plan-refiner.md',
  implementer: 'maestro-implementer.md',
  reviewer: 'maestro-code-reviewer.md',
  planReviewer: 'maestro-plan-reviewer.md',
  // Workspace review synthesizer: its body is the contract (no FALLBACK_PROMPTS
  // entry, C10), so it must load into agentPrompts for a real workspace run. The
  // off-pipeline scanner is NOT here (it is driven by the M5 scan engine, not the
  // dispatcher, which supplies agentPrompts.workspaceScanner itself).
  workspaceReviewer: 'maestro-workspace-reviewer.md',
};

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
    this.pendingQuestion = null; // { id, resolve, reject, kind }
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
      const registry = await loadAgentRegistry();
      this.registry = registry; // ▲ v3: expose for run-start workflow validation (D4)
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
      this.baseName = this._deriveBaseName(this.pipeline.promptText, this.state.title);
      // Capture the date prefix ONCE so every plan -vN and the review file share
      // the v1 date even if the run crosses midnight.
      this.planDatePrefix = today();
      // Persist the plan/review name linkage so a later delete can find the shared
      // markdown exactly (state.artifacts is not persisted; names are the only link).
      this.state.baseName = this.baseName;
      this.state.datePrefix = this.planDatePrefix;
      await this._persist();
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

      // 4) (Clarify now runs as the first graph node — see _runClarifyNode.)

      // 5) Dispatch the resolved workflow (already snapshotted into state.stepper
      //    at run start). Persist now that this.pipeline exists, and re-emit the
      //    full state (with pipelineDir) for any client that connected mid-preflight.
      await this._persist();
      this._emit('state', this.getState());
      await appendAudit(this.pipeline.dir, `Workflow: **${plan.name}** (${plan.id}).`);
      await this._dispatch(plan);
      this._checkAbort();

      // 9) Done.
      this._setStatus('done');
      this._phase('done', 0, 'done');
      await this._persist();
      await appendAudit(this.pipeline.dir, `Pipeline finished with status **done**.`);
      this._emit('done', { status: 'done', pipelineDir: this.pipeline.dir });
      return { status: 'done', pipelineDir: this.pipeline.dir };
    } catch (err) {
      if (isAbort(err) || this.state.status === 'stopped') {
        this._setStatus('stopped');
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
      // C1: always tear the worktree(s) down. By now this.state.status is the
      // terminal value (done/stopped/error); the branch is always kept (every
      // member's, on a workspace run), only the disposable checkout is removed.
      if (this.isWorkspace) await this._teardownWorktreeAll().catch(() => {});
      else await this._teardownWorktree().catch(() => {});
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
    const loopState = {}; // fb.id -> { cycle }
    // The active run cycle per step index while a loop is replaying through it.
    const stepCycle = new Array(steps.length).fill(1);

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

    // Prompt-as-entry-artifact: fill any materializable channel the topology requires
    // before any step produces it (a pipeline that starts mid-stream — implementer or
    // refiner first). The user prompt + attached files stand in for the missing
    // artifact, written to the channel's seeded path so EVERY consumer (the first
    // agent AND any downstream one, e.g. a later reviewer) binds it via the normal bus.
    // Disk-only: we write the file at bus[c].path; the handle (and its path) is
    // unchanged, so the frozen per-step snapshots already point at the now-existing
    // file. A real producer later overwrites the file (latest-writer-wins), as today.
    this.extrasFiles = await this._collectExtras();
    for (const c of entrySeedChannels(steps)) {
      const handle = bus[c];
      if (!handle?.path) continue;
      await mkdir(dirname(handle.path), { recursive: true }); // plans/ dir is lazy
      await writeFile(handle.path, renderPromptArtifact(this.pipeline.promptText, this.extrasFiles), 'utf8');
      await appendAudit(this.pipeline.dir, `Seeded "${c}" from the user prompt (no upstream producer).`);
    }

    let i = 0;
    while (i < steps.length) {
      this._checkAbort();
      const cycle = stepCycle[i];
      const results = await this._runStep(steps[i], i, cycle, bus);

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
        const decision = await this._gate(fb.id, st.cycle, blockingIssues(this._reviewOf(results, fb.from)));
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
    }
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
        const taskNode = {
          nodeId: task.nodeId,
          key: 'implementer',
          uiPhase: 'implement',
          runnerType: 'producer',
          decomposedTask: true,
          model: implNode.model,
          effort: implNode.effort,
          tools: implNode.tools,
          taskPath: join(this.pipeline.dir, task.file || ''),
          produces: ['code'],
          consumes: ['plan'],
        };
        return this._runDecomposedTask(taskNode, task, stepIndex, cycle, snapshot, phaseAbort);
      }));

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
    ctx.signal = AbortSignal.any([this.abort.signal, phaseAbort.signal]); // sibling-failure cancel
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
    let result;
    try {
      const runner = this._runners[node.runnerType];
      if (typeof runner !== 'function') throw new Error(`no runner for type "${node.runnerType}"`);
      result = await runner(ctx);
    } finally {
      this._nodeStep(node, stepIndex, cycle, 'done');
    }
    // CONV-6: no shared-bus mutation here — _runStep merges results in node order.
    return { node, result, ctx };
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
  async _ask({ id, kind, questions, issues }) {
    this._checkAbort();

    // Freeze the active-time clock while we wait on the user (active-time-only).
    const frozenKey = this._runningStepKey();
    if (frozenKey) {
      this._clockPause(frozenKey);
      this.state.totalActiveMs = sumStepActive(this.state.steps);
      this._emit('state', this.getState()); // UI freezes the live timer
      this._persist().catch(() => {});
    }

    this._emit('question', { id, kind, questions, issues });

    try {
      if (this.auto) {
        if (kind === 'clarify') {
          this._log('orchestrator', 'info', `auto-answering clarify ${id}`);
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
      if (frozenKey && this.state.status !== 'stopped' && this.state.status !== 'error') {
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
      signal: this.abort.signal,
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
      signal: this.abort.signal,
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
    // the close status is 'stopped' iff the whole run was stopped, else 'finished'.
    if (status === 'done' || status === 'error' || status === 'stopped') {
      const closeTo = this.state.status === 'stopped' ? 'stopped' : 'finished';
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

  async _loadAgentPrompts() {
    const prompts = {};
    for (const [role, file] of Object.entries(AGENT_FILES)) {
      const p = join(this.agentsDir, file);
      try {
        prompts[role] = await readFile(p, 'utf8');
      } catch {
        // Missing agent file => empty system prompt body (fails safe).
        prompts[role] = '';
        this._log('orchestrator', 'warn', `Agent prompt missing: ${rel(this.projectDir, p)}`);
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
    if (status === 'done' || status === 'stopped' || status === 'error') {
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
  }

  _artifact(kind, path) {
    this._emit('artifact', { kind, path });
    // Phase 3.9: ALSO index FS markdown/extra paths so pipeline-delete (Task 3.13)
    // can unlink the EXACT files later (best-effort; never blocks a run). Skip the
    // synthetic 'pipeline'/'clarify' kinds (clarify lives in the clarify table;
    // 'pipeline' is the dir itself). plan/review markdown live under
    // <store>/<key>/{plans,reviews} (store-root-relative); checklist/webui live in
    // the pipeline dir (dir-relative).
    if (!this.pipeline || !path || kind === 'pipeline' || kind === 'clarify') return;
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

  async _persist() {
    if (!this.pipeline) return;
    try {
      await writeState(this.pipeline.dir, this.state);
    } catch {
      /* persistence is best-effort */
    }
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
