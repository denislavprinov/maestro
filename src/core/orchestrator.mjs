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
import { join, basename, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

import {
  createPipeline,
  appendAudit,
  writeState,
  artifactPaths,
  planPath,
  reviewPath,
  slugify,
  today,
} from './artifacts.mjs';
import { detectTools } from './preflight.mjs';
import { resolveStepModels } from './config.mjs';
import { hasBlocking, blockingIssues } from './protocol.mjs';
import {
  runPlannerClarify,
  runPlannerPlan,
  runRefiner,
  runImplementer,
  runReviewer,
} from './phases.mjs';

/**
 * Default location of the agent prompt markdown files, relative to this module.
 */
const DEFAULT_AGENTS_DIR = new URL('../../agents/', import.meta.url).pathname;

const AGENT_FILES = {
  planner: 'maestro-planner.md',
  refiner: 'maestro-plan-refiner.md',
  implementer: 'maestro-implementer.md',
  reviewer: 'maestro-code-reviewer.md',
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
 * @param {number} [opts.maxRefineCycles=5]
 * @param {number} [opts.maxReviewCycles=5]
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
    this.maxRefineCycles = numOr(this.opts.maxRefineCycles, 5);
    this.maxReviewCycles = numOr(this.opts.maxReviewCycles, 5);
    this.claude = {
      bin: this.opts.claude?.bin,
      permissionMode: this.opts.claude?.permissionMode || 'acceptEdits',
      model: this.opts.claude?.model,
      mock: !!this.opts.claude?.mock,
    };
    this.agentsDir = this.opts.agentsDir || DEFAULT_AGENTS_DIR;
    this.auto = !!this.opts.auto;
    this.stepModels = null; // { planner:{model,effort}, refiner:{...}, ... } | null until run()

    this.abort = new AbortController();
    this.pendingQuestion = null; // { id, resolve, reject, kind }
    this.agentPrompts = null;
    this.toolInstruction = '';
    this.checkpointRef = null;
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
      tools: null,
      checkpointRef: null,
      pipelineDir: null,
      totalCostUsd: 0, // cumulative actual spend (sum of steps[].costUsd)
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
        tools.tool ? `Detected tool: ${tools.tool}` : 'No knowledge-graph tooling detected',
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
        await appendAudit(this.pipeline.dir, `Preflight: using **${tools.tool}**.`);
      }

      // 3) Ensure a git repo + checkpoint commit.
      await this._ensureGitCheckpoint();
      this._phase('preflight', 0, 'done');
      this._checkAbort();

      // 4) Planner clarify (single round).
      const answers = await this._clarify();
      this._checkAbort();

      // 5) Planner plan.
      const planFilePath = planPath(this.projectDir, this.baseName, 1, this.planDatePrefix);
      this._phase('plan', 0, 'start');
      const planResult = await runPlannerPlan(this._phaseCtx('planner'), {
        answers,
        planFilePath,
        baseName: this.baseName,
      });
      const currentPlanPath = planResult?.planPath || planFilePath;
      this._artifact('plan', currentPlanPath);
      await appendAudit(this.pipeline.dir, `Plan written: \`${rel(this.projectDir, currentPlanPath)}\`.`);
      this._phase('plan', 0, 'done');
      this._checkAbort();

      // 6) Refine loop.
      const finalPlanPath = await this._refineLoop(currentPlanPath);
      this._checkAbort();

      // 7) Implement.
      this._phase('implement', 0, 'start');
      const impl = await runImplementer(this._phaseCtx('implementer'), {
        planPath: finalPlanPath,
        mode: 'implement',
      });
      // Stage the implementer's output so newly-created (untracked) files appear
      // in `git diff` for the reviewer. Without this, brand-new feature files are
      // invisible to a plain `git diff`/`git diff HEAD`.
      await this._stageWorkingTree();
      await appendAudit(
        this.pipeline.dir,
        `Implementation complete: ${oneLine(impl?.summary) || 'done'}.`,
      );
      this._phase('implement', 0, 'done');
      this._checkAbort();

      // 8) Review loop (review -> fix -> review ...).
      await this._reviewLoop(finalPlanPath);
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
    }
  }

  // ── phase helpers ─────────────────────────────────────────────────────────────

  /**
   * Single clarify round: run the planner once (it asks up to four questions),
   * record the answers, then return them for the plan phase. There is no
   * re-ask loop — when the planner has no questions we skip straight to plan.
   * Returns the answers array ([{ id, question, choice }]).
   */
  async _clarify() {
    this._phase('clarify', 1, 'start');
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

  /**
   * Refine loop. Each cycle runs the refiner producing -vN and a review json.
   * Stops when the review has no blocking issues. Past maxRefineCycles, emits a
   * gate question with the open blocking issues; "continue" ends the loop,
   * "another" runs one more cycle (escalates indefinitely).
   * Returns the path of the latest refined plan.
   */
  async _refineLoop(initialPlanPath) {
    let cycle = 0;
    let inPlanPath = initialPlanPath;
    let latestPlanPath = initialPlanPath;

    while (true) {
      cycle += 1;
      this._phase('refine', cycle, 'start');
      const outPlanPath = planPath(this.projectDir, this.baseName, cycle + 1, this.planDatePrefix);
      const reviewJsonPath = join(this.pipeline.dir, `refine-review-cycle${cycle}.json`);

      const { outPlanPath: writtenPath, review } = await runRefiner(this._phaseCtx('refiner'), {
        inPlanPath,
        outPlanPath,
        cycle,
        reviewJsonPath,
      });
      this._checkAbort();

      const refinedPath = writtenPath || outPlanPath;
      latestPlanPath = refinedPath;
      inPlanPath = refinedPath;
      this._artifact('plan', refinedPath);
      this._artifact('review', reviewJsonPath);

      const blocking = blockingIssues(review);
      await appendAudit(
        this.pipeline.dir,
        `Refine cycle ${cycle}: ${blocking.length} blocking issue(s); plan \`${rel(
          this.projectDir,
          refinedPath,
        )}\`.`,
      );
      this._phase('refine', cycle, 'done');

      if (!hasBlocking(review)) {
        await appendAudit(this.pipeline.dir, `Refine complete after ${cycle} cycle(s).`);
        break;
      }

      if (cycle >= this.maxRefineCycles) {
        const decision = await this._gate('refine', cycle, blocking);
        this._checkAbort();
        if (decision === 'continue') {
          await appendAudit(
            this.pipeline.dir,
            `Refine gate at cycle ${cycle}: user chose to continue with ${blocking.length} open issue(s).`,
          );
          break;
        }
        await appendAudit(
          this.pipeline.dir,
          `Refine gate at cycle ${cycle}: user approved another cycle.`,
        );
        // loop continues
      }
    }
    return latestPlanPath;
  }

  /**
   * Review loop. Run reviewer -> if blocking, run implementer(fix) -> repeat.
   * Stops when no blocking issues. Past maxReviewCycles, gates like refine.
   */
  async _reviewLoop(planPathForFix) {
    let cycle = 0;
    const reviewMdPath = reviewPath(this.projectDir, this.baseName, this.planDatePrefix);

    while (true) {
      cycle += 1;
      this._phase('review', cycle, 'start');
      const reviewJsonPath = join(this.pipeline.dir, `impl-review-cycle${cycle}.json`);
      const { review } = await runReviewer(this._phaseCtx('reviewer'), {
        planPath: planPathForFix,
        reviewMdPath,
        reviewJsonPath,
        cycle,
      });
      this._checkAbort();

      this._artifact('review', reviewMdPath);
      this._artifact('review', reviewJsonPath);

      const blocking = blockingIssues(review);
      await appendAudit(
        this.pipeline.dir,
        `Review cycle ${cycle}: ${blocking.length} blocking issue(s).`,
      );
      this._phase('review', cycle, 'done');

      if (!hasBlocking(review)) {
        await appendAudit(this.pipeline.dir, `Review passed after ${cycle} cycle(s).`);
        break;
      }

      if (cycle >= this.maxReviewCycles) {
        const decision = await this._gate('review', cycle, blocking);
        this._checkAbort();
        if (decision === 'continue') {
          await appendAudit(
            this.pipeline.dir,
            `Review gate at cycle ${cycle}: user chose to continue with ${blocking.length} open issue(s).`,
          );
          break;
        }
        await appendAudit(
          this.pipeline.dir,
          `Review gate at cycle ${cycle}: user approved another cycle.`,
        );
      }

      // Fix pass before the next review.
      this._phase('implement', cycle, 'start');
      const fix = await runImplementer(this._phaseCtx('implementer'), {
        planPath: planPathForFix,
        reviewPath: reviewMdPath,
        mode: 'fix',
      });
      // Re-stage so any new files created by the fix pass are visible to the
      // next reviewer's `git diff`.
      await this._stageWorkingTree();
      this._checkAbort();
      await appendAudit(
        this.pipeline.dir,
        `Fix pass (review cycle ${cycle}): ${oneLine(fix?.summary) || 'applied fixes'}.`,
      );
      this._phase('implement', cycle, 'done');
    }
  }

  // ── question / gate plumbing ───────────────────────────────────────────────

  /**
   * Emit a question and await its resolution. Honors auto-mode.
   * @returns {Promise<any>} the answer payload
   */
  _ask({ id, kind, questions, issues }) {
    this._checkAbort();
    this._emit('question', { id, kind, questions, issues });

    if (this.auto) {
      // Resolve immediately with a deterministic auto-answer.
      if (kind === 'clarify') {
        const auto = {
          answers: (questions || []).map((q) => ({
            id: q.id,
            choice: (q.options && q.options.find((o) => o && o.trim())) || 'auto',
          })),
        };
        this._log('orchestrator', 'info', `auto-answering clarify ${id}`);
        return Promise.resolve(auto);
      }
      this._log('orchestrator', 'info', `auto-answering gate ${id} -> continue`);
      return Promise.resolve({ decision: 'continue' });
    }

    return new Promise((resolveP, rejectP) => {
      this.pendingQuestion = { id, kind, resolve: resolveP, reject: rejectP };
    });
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
      projectDir: this.projectDir,
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

  /** Translate a low-level claude/mock event into a pipeline 'log' event. */
  _onAgentEvent(role, e) {
    if (!e) return;
    // Capture actual spend before anything returns early. The runner tags the
    // terminal stream-json `result` with costUsd (Claude's total_cost_usd; 0 in
    // mock). Fall back to raw.total_cost_usd defensively. e.raw may be a string
    // (non-JSON line) — `.type` on it is just undefined, so this never throws.
    // `e.costUsd != null` keeps a genuine 0 (which `!= null` is true for).
    const cost = e.costUsd != null
      ? Number(e.costUsd)
      : (e.raw && e.raw.type === 'result' ? Number(e.raw.total_cost_usd) : NaN);
    if (Number.isFinite(cost)) this._recordCost(cost);

    const text = (e.text || '').trim();
    if (text) {
      this._log(role, 'info', text);
      return;
    }
    // No human-readable text. Rather than echo the bare stream-json envelope
    // type (the old noisy `[planner] user` / `[planner] system` lines), surface
    // the concrete tool calls the agent made this turn. Contentless envelope
    // events — tool_result echoes (`user`) and the init `system` event — carry
    // no information and are dropped.
    for (const call of describeToolUses(e.raw, this.projectDir)) {
      this._log(role, 'debug', `→ ${call}`);
    }
  }

  // ── git checkpoint ─────────────────────────────────────────────────────────

  async _ensureGitCheckpoint() {
    const isRepo = await this._git(['rev-parse', '--is-inside-work-tree']);
    if (!isRepo.ok || isRepo.stdout.trim() !== 'true') {
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
    const res = await this._git(['add', '-A', '-N']);
    if (!res.ok && res.stderr && res.stderr.trim()) {
      this._log('git', 'debug', `git add -A -N: ${res.stderr.trim()}`);
    }
  }

  /**
   * Run a git command in the project dir. Never throws; returns
   * { ok, code, stdout, stderr }. Honors the abort signal.
   */
  _git(args) {
    return new Promise((resolveP) => {
      let child;
      try {
        child = spawn('git', args, {
          cwd: this.projectDir,
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

  _phase(phase, cycle, status) {
    this.state.phase = phase;
    this.state.cycle = cycle;
    this._recordStep(phase, cycle, status);
    this.state.updatedAt = new Date().toISOString();
    this._emit('phase', { phase, cycle, status });
    this._emit('state', this.getState());
    // Persist on phase boundaries so history/audit stay fresh.
    this._persist().catch(() => {});
  }

  _recordStep(phase, cycle, status) {
    const key = cycle ? `${phase}#${cycle}` : phase;
    const existing = this.state.steps.find((s) => s.key === key);
    if (existing) {
      existing.status = status;
      existing.updatedAt = new Date().toISOString();
    } else {
      this.state.steps.push({
        key,
        phase,
        cycle,
        status,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
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
  _recordCost(costUsd) {
    if (!Number.isFinite(costUsd) || costUsd < 0) return;
    this.state.totalCostUsd = roundUsd((this.state.totalCostUsd || 0) + costUsd);
    const key = this.state.cycle ? `${this.state.phase}#${this.state.cycle}` : this.state.phase;
    const step = this.state.steps.find((s) => s.key === key);
    if (step) step.costUsd = roundUsd((step.costUsd || 0) + costUsd);
    this.state.updatedAt = new Date().toISOString();
    this._emit('state', this.getState());
    this._persist().catch(() => {});
  }

  _setStatus(status) {
    this.state.status = status;
    this.state.updatedAt = new Date().toISOString();
    this._emit('state', this.getState());
  }

  _log(source, level, text) {
    const evt = { source, level, text, ts: new Date().toISOString() };
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

function numOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** Round a USD amount to 4 decimals (tenth-of-a-cent) to avoid float drift. */
function roundUsd(n) {
  return Math.round((Number(n) || 0) * 1e4) / 1e4;
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

function oneLine(text) {
  if (!text) return '';
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 160);
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
