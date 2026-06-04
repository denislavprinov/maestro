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
import { join, basename, resolve, dirname } from 'node:path';
import { readFile, writeFile, readdir, mkdir, realpath } from 'node:fs/promises';

import {
  createPipeline,
  appendAudit,
  writeState,
  artifactPaths,
  planPath,
  slugify,
  today,
} from './artifacts.mjs';
import { detectTools, runGraphifyUpdate, worktreeGraphInstruction } from './preflight.mjs';
import { resolveStepModels } from './config.mjs';
import { hasBlocking, blockingIssues } from './protocol.mjs';
import { runPlannerClarify } from './phases.mjs';
import { runners as defaultRunners } from './runners.mjs';
import { resolveWorkflow, buildStepperManifest } from './workflows.mjs';
import { allocate, bindInputs, publish, legacyFields, entrySeedChannels, renderPromptArtifact } from './channels.mjs';
import { loadAgentRegistry } from './agent-registry.mjs';
import { validateWorkflow } from './workflow-validator.mjs';
import {
  createWorktree, removeWorktree, suggestBranchName, sanitizeBranchName, resolveDefaultBranch,
} from './worktree.mjs';

/**
 * Default location of the agent prompt markdown files, relative to this module.
 */
const DEFAULT_AGENTS_DIR = new URL('../../agents/', import.meta.url).pathname;

const AGENT_FILES = {
  planner: 'maestro-planner.md',
  refiner: 'maestro-plan-refiner.md',
  implementer: 'maestro-implementer.md',
  reviewer: 'maestro-code-reviewer.md',
  planReviewer: 'maestro-plan-reviewer.md',
};

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
    this.projectDir = resolve(this.opts.projectDir || process.cwd());
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
    this._runners = this.opts.runners || defaultRunners;

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
      const plan = await resolveWorkflow(this.projectDir, this.workflowId, registry);
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

      // 2) Create the pipeline directory + audit.
      this.pipeline = await createPipeline(this.projectDir, {
        prompt: this.opts.prompt,
        promptFile: this.opts.promptFile,
        extras: this.opts.extras,
        title: this.opts.title,
      });
      this.state.id = this.pipeline.id;
      this.state.pipelineDir = this.pipeline.dir;
      if (!this.state.title) this.state.title = basename(this.pipeline.dir);
      this.baseName = this._deriveBaseName(this.pipeline.promptText, this.state.title);
      // Capture the date prefix ONCE so every plan -vN and the review file share
      // the v1 date even if the run crosses midnight.
      this.planDatePrefix = today();
      await this._persist();
      this._artifact('pipeline', this.pipeline.dir);
      await appendAudit(this.pipeline.dir, `Pipeline created (id ${this.pipeline.id}).`);
      if (tools.tool) {
        await appendAudit(
          this.pipeline.dir,
          `Preflight: using **${tools.tool}**${tools.kind ? ` (${tools.kind})` : ''}.`,
        );
      }

      // 3) Ensure a git repo + checkpoint commit.
      await this._ensureGitCheckpoint();
      this._phase('preflight', 0, 'done');
      this._checkAbort();

      // 3b) Set up the per-pipeline worktree. All subsequent claude spawns cwd
      // into this.workDir; artifacts continue to live under this.projectDir.
      await this._setupWorktree();
      this._checkAbort();

      // 3c) Build the knowledge graph INSIDE the worktree so agents can query it.
      await this._buildWorktreeGraph();
      this._checkAbort();

      // 4) Planner clarify (single round).
      const answers = await this._clarify(plannerNodeIdOf(plan));
      this._checkAbort();

      // 5) Dispatch the resolved workflow (already snapshotted into state.stepper
      //    at run start). Persist now that this.pipeline exists, and re-emit the
      //    full state (with pipelineDir) for any client that connected mid-preflight.
      await this._persist();
      this._emit('state', this.getState());
      await appendAudit(this.pipeline.dir, `Workflow: **${plan.name}** (${plan.id}).`);
      await this._dispatch(plan, { answers });
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
      // C1: always tear the worktree down. By now this.state.status is the
      // terminal value (done/stopped/error), which decides branch retention.
      await this._teardownWorktree().catch(() => {});
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
   * Tear down the per-pipeline worktree (C1). Retention policy:
   *   - done  → remove the checkout dir, KEEP the feature branch so the user
   *             can merge the agent's work.
   *   - error/stopped → remove the dir; also delete the branch, but only when we
   *             created it this run (never delete a resumed/pre-existing branch).
   * Always force:true — agents have edited files, so the non-force path would
   * refuse and leak. Idempotent; safe to call when setup never ran.
   */
  async _teardownWorktree() {
    const info = this.branchInfo;
    if (!info || !info.worktreeDir) return;
    this.branchInfo = null; // guard against a double teardown
    const keepBranch = this.state.status === 'done' || info.reusedExisting;
    // Commit the agent's work onto the feature branch BEFORE removal. Without
    // this, removeWorktree(force:true) discards the working tree and the kept
    // branch carries no changes (the staging in _stageWorkingTree is intent-to-add
    // for the reviewer's diff only — it never creates a commit). Only when we are
    // keeping the branch; on a discarded branch there is nothing to preserve.
    if (keepBranch) await this._commitWork(info).catch(() => {});
    const res = await removeWorktree({
      projectDir: this.projectDir,
      worktreeDir: info.worktreeDir,
      branch: keepBranch ? null : info.branch,
      force: true,
    });
    for (const s of res.steps.filter((x) => !x.ok)) {
      this._log('worktree', 'warn', `teardown ${s.step} failed: ${s.stderr || 'unknown error'}`);
    }
    if (this.pipeline) {
      const branchNote = keepBranch
        ? `kept branch \`${info.branch}\``
        : `removed branch \`${info.branch}\``;
      await appendAudit(
        this.pipeline.dir,
        `Worktree removed at \`${info.worktreeDir}\` (${branchNote}).`,
      ).catch(() => {});
    }
    // Reflect the post-teardown reality in state for any late observer.
    if (this.state.branch) {
      this.state.branch.worktreeRemoved = true;
      this.state.branch.branchKept = keepBranch;
    }
    this.workDir = this.projectDir;
  }

  /**
   * Commit every change in the worktree onto the feature branch so the kept
   * branch actually carries the agent's work after the worktree is removed.
   * Best-effort: never throws; logs and returns null on any failure. Skips
   * cleanly when the working tree is clean (no diff from the checkpoint), which
   * is the truthful "no change needed" outcome. Records the SHA on state.branch.
   * @param {{worktreeDir:string, branch:string}} info the branch being kept
   * @returns {Promise<string|null>} the new commit SHA, or null when nothing committed.
   */
  async _commitWork(info) {
    const cwd = info?.worktreeDir;
    if (!cwd) return null;
    const status = await this._git(['status', '--porcelain'], { cwd });
    if (!status.ok) {
      this._log('git', 'warn', `commit skipped: git status failed: ${status.stderr.trim()}`);
      return null;
    }
    if (!status.stdout.trim()) {
      this._log('git', 'info', 'No changes to commit (working tree clean).');
      return null;
    }
    const add = await this._git(['add', '-A'], { cwd });
    if (!add.ok) {
      this._log('git', 'warn', `commit skipped: git add failed: ${add.stderr.trim()}`);
      return null;
    }
    const title = this.state.title || this.baseName || 'changes';
    const msg = `maestro: ${title}${this.pipeline ? `\n\nPipeline ${this.pipeline.id}` : ''}`;
    // Plain commit first (uses the repo's configured identity); fall back to a
    // local identity so a repo with no user.name/email still commits — mirrors
    // _ensureGitCheckpoint's belt-and-braces.
    let commit = await this._git(['commit', '-m', msg], { cwd });
    if (!commit.ok) {
      commit = await this._git(
        ['-c', 'user.email=orchestrator@local', '-c', 'user.name=orchestrator', 'commit', '-m', msg],
        { cwd },
      );
    }
    if (!commit.ok) {
      this._log('git', 'warn', `commit failed: ${commit.stderr.trim() || `exit ${commit.code}`}`);
      return null;
    }
    const ref = await this._git(['rev-parse', 'HEAD'], { cwd });
    const sha = ref.ok ? ref.stdout.trim() : null;
    if (this.state.branch) this.state.branch.commit = sha;
    if (sha && this.pipeline) {
      await appendAudit(
        this.pipeline.dir,
        `Committed agent work to \`${info.branch}\` at \`${sha.slice(0, 10)}\`.`,
      ).catch(() => {});
    }
    return sha;
  }

  // ── phase helpers ─────────────────────────────────────────────────────────────

  /**
   * Single clarify round: run the planner once (it asks up to four questions),
   * record the answers, then return them for the plan phase. There is no
   * re-ask loop — when the planner has no questions we skip straight to plan.
   * Returns the answers array ([{ id, question, choice }]).
   */
  async _clarify(plannerNodeId = null) {
    // Tag the clarify round with the planner node id so its activeMs + costUsd
    // bucket onto the Plan cell from the first tick. Pipeline totals are derived
    // as Σ steps, so this only changes attribution — never the totals.
    // plannerNodeId is null on a workflow with no plan-phase node; clarify then
    // stays unattributed (legacy behavior).
    this._phase('clarify', 1, 'start', plannerNodeId);
    const { questions } = await runPlannerClarify(this._phaseCtx('planner'), {
      round: 1,
      priorAnswers: [], // single round: there is never a prior round to feed back
    });
    this._checkAbort();
    if (!Array.isArray(questions) || questions.length === 0) {
      this._phase('clarify', 1, 'done');
      await appendAudit(this.pipeline.dir, `Clarify: no questions; proceeding to plan.`);
      return [];
    }
    this._artifact('clarify', join(this.pipeline.dir, 'clarify.json'));
    const answer = await this._ask({ id: 'clarify-1', kind: 'clarify', questions });
    this._checkAbort();
    const answers = normalizeClarifyAnswer(answer, questions);
    const enriched = await this._writeClarifyAnswers(questions, answers);
    await appendAudit(this.pipeline.dir, `Clarify: answered ${answers.length} question(s).`);
    this._phase('clarify', 1, 'done');
    return enriched;
  }

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
      userPrompt: { kind: 'value', text: this.pipeline.promptText, answers: runArgs.answers || [] },
      plan: { kind: 'artifact', path: planPath(this.projectDir, this.baseName, 1, this.planDatePrefix) },
      review: null,
      checklist: { kind: 'artifact', path: join(this.pipeline.dir, 'manual-tests-checklist.md') },
      code: { kind: 'worktree', dir: this.workDir, baseRef: this.checkpointRef },
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
      if ((node.produces || []).includes('code')) stageNeeded = true;
    }
    // CONV-6: stage ONCE, AWAITED, after the step's producers — so a following
    // reviewer's `git diff` sees newly-written files (legacy _reviewLoop staged
    // after every implement pass).
    if (stageNeeded) await this._stageWorkingTree();
    return results;
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
    };
    const inputs = bindInputs(consumes, optional, snapshot);
    const outputs = {};
    for (const c of produces) outputs[c] = allocate(c, ctx);
    return { inputs, outputs, ...legacyFields(node, inputs, outputs, cycle, this.baseName) };
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

  _phaseCtx(role) {
    // resolveStepModels already folded in the global fallback, so step.model is
    // the effective model; the `|| this.claude.model` is a defensive belt-and-
    // braces for the (guarded) case where stepModels is null.
    const step = (this.stepModels && this.stepModels[role]) || {};
    return {
      projectDir: this.workDir,
      pipelineDir: this.pipeline.dir,
      taskPrompt: this.pipeline.promptText,
      toolInstruction: this.toolInstruction,
      agentPrompts: this.agentPrompts,
      checkpointRef: this.checkpointRef,
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
      taskPrompt: this.pipeline.promptText,
      toolInstruction: this.toolInstruction,
      agentPrompts: this.agentPrompts,
      checkpointRef: this.checkpointRef,
      signal: this.abort.signal,
      node,
      nodeId: node.nodeId,
      stepIndex,
      cycle,
      isEntry: stepIndex === 0,
      extras: this.extrasFiles || [],
      onEvent: (e) => this._onAgentEvent(node.key, e, { nodeId: node.nodeId, stepIndex, cycle, stepKey }),
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
    this._emit('state', this.getState());
    this._persist().catch(() => {});
  }

  /** Translate a low-level claude/mock event into a pipeline 'log' event. */
  _onAgentEvent(role, e, attr = null) {
    if (!e) return;
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

    const text = (e.text || '').trim();
    if (text) {
      this._log(role, 'info', text, attr);
      return;
    }
    // No human-readable text. Rather than echo the bare stream-json envelope
    // type (the old noisy `[planner] user` / `[planner] system` lines), surface
    // the concrete tool calls the agent made this turn. Contentless envelope
    // events — tool_result echoes (`user`) and the init `system` event — carry
    // no information and are dropped.
    for (const call of describeToolUses(e.raw, this.projectDir)) {
      this._log(role, 'debug', `→ ${call}`, attr);
    }
  }

  // ── git checkpoint ─────────────────────────────────────────────────────────

  async _ensureGitCheckpoint() {
    // C2: `--is-inside-work-tree` is true even when projectDir merely sits
    // *inside* an enclosing repo (no .git of its own). Acting on that parent
    // repo would silently create maestro/* branches + checkpoint commits in the
    // developer's real repo. Require projectDir to BE the repo toplevel; if it
    // isn't (no repo, or only a parent repo), `git init` a dedicated repo here.
    const projReal = await realpath(this.projectDir).catch(() => resolve(this.projectDir));
    const top = await this._git(['rev-parse', '--show-toplevel']);
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
          `projectDir is nested in repo ${topReal}; initializing a dedicated repo to isolate worktrees.`,
        );
      }
      await this._git(['init']);
      // Ensure an identity exists for the commit (local, non-destructive).
      await this._git(['config', 'user.email', 'orchestrator@local']);
      await this._git(['config', 'user.name', 'orchestrator']);
    }
    // Is there any commit yet?
    const head = await this._git(['rev-parse', 'HEAD']);
    if (!head.ok) {
      await this._git(['add', '-A']);
      const commit = await this._git([
        '-c',
        'user.email=orchestrator@local',
        '-c',
        'user.name=orchestrator',
        'commit',
        '--allow-empty',
        '-m',
        'orchestrator: initial checkpoint',
      ]);
      if (!commit.ok) {
        this._log('git', 'warn', `initial commit failed: ${commit.stderr.trim()}`);
      }
    }
    const ref = await this._git(['rev-parse', 'HEAD']);
    this.checkpointRef = ref.ok ? ref.stdout.trim() : null;
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
   * Stage every change in the working tree with intent-to-add so that newly
   * created (untracked) files show up in a plain `git diff` for the reviewer.
   * Uses `git add -A -N`: it records intent-to-add for new paths (making their
   * content visible to `git diff`) without actually creating a commit, so the
   * checkpoint commit remains the single diff base. Best-effort; never throws.
   */
  async _stageWorkingTree() {
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
  _git(args, { cwd } = {}) {
    return new Promise((resolveP) => {
      let child;
      try {
        child = spawn('git', args, {
          cwd: cwd || this.projectDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          signal: this.abort.signal,
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
    // Delegate to protocol's writer via dynamic import to keep this module's
    // import surface focused; protocol is already loaded so this is cheap.
    const { writeClarifyAnswers } = await import('./protocol.mjs');
    const byId = new Map(questions.map((q) => [q.id, q]));
    const enriched = answers.map((a) => ({
      id: a.id,
      question: byId.get(a.id)?.question || '',
      choice: a.choice,
    }));
    await writeClarifyAnswers(this.pipeline.dir, { answers: enriched });
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
    }
    this._emit('log', evt);
  }

  _artifact(kind, path) {
    this._emit('artifact', { kind, path });
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

/**
 * Resolve the planner node's id from a resolved ExecutablePlan: the first node
 * whose UI bucket is the plan phase (uiPhase === 'plan'), else the first node
 * keyed 'planner'. Returns null when there is no plan-phase node (a non-standard
 * workflow) — callers then leave clarify unattributed (legacy behavior).
 * Never hardcodes 's0_0'; works for any workflow whose first step is the planner.
 * plan.steps is the resolveWorkflow() shape: Array<Array<node>> (groups of nodes).
 * @param {{steps?:Array<Array<{nodeId:string,key:string,uiPhase?:string}>>}} plan
 * @returns {string|null}
 */
export function plannerNodeIdOf(plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  for (const group of steps) {
    for (const node of Array.isArray(group) ? group : []) {
      if (node && (node.uiPhase === 'plan' || node.key === 'planner')) {
        return node.nodeId || null;
      }
    }
  }
  return null;
}

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
