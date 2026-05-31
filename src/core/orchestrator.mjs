// src/core/orchestrator.mjs
// The deterministic state machine that sequences the whole pipeline:
//
//   preflight
//     -> ensure git repo + checkpoint
//     -> planner clarify loop  (ask questions until none remain)
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
 * @param {number} [opts.maxClarifyCycles=3]
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
    this.maxClarifyCycles = numOr(this.opts.maxClarifyCycles, 3);
    this.claude = {
      bin: this.opts.claude?.bin,
      permissionMode: this.opts.claude?.permissionMode || 'acceptEdits',
      model: this.opts.claude?.model,
      mock: !!this.opts.claude?.mock,
    };
    this.agentsDir = this.opts.agentsDir || DEFAULT_AGENTS_DIR;
    this.auto = !!this.opts.auto;

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
      const [agentPrompts, tools] = await Promise.all([
        this._loadAgentPrompts(),
        detectTools(this.projectDir),
      ]);
      this.agentPrompts = agentPrompts;
      this.toolInstruction = tools.instruction || '';
      this.state.tools = tools;
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

      // 4) Planner clarify loop.
      const answers = await this._clarifyLoop();
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
   * The clarify loop: run planner clarify; if it returns questions, emit a
   * clarify question, await answers, persist, and re-run until no questions
   * remain. Returns the accumulated answers array.
   */
  async _clarifyLoop() {
    const collected = [];
    let round = 0;
    // Guard against a pathological agent that never stops asking. Configurable
    // via maxClarifyCycles (default 3); also the natural exit is questions === 0.
    const maxRounds = this.maxClarifyCycles;
    while (round < maxRounds) {
      round += 1;
      this._phase('clarify', round, 'start');
      const { questions } = await runPlannerClarify(this._phaseCtx('planner'), {
        round,
        priorAnswers: collected,
      });
      this._checkAbort();
      if (!Array.isArray(questions) || questions.length === 0) {
        this._phase('clarify', round, 'done');
        await appendAudit(this.pipeline.dir, `Clarify round ${round}: no further questions.`);
        break;
      }
      this._artifact('clarify', join(this.pipeline.dir, 'clarify.json'));
      const id = `clarify-${round}`;
      const answer = await this._ask({ id, kind: 'clarify', questions });
      this._checkAbort();
      const answers = normalizeClarifyAnswer(answer, questions);
      // Persist this round's Q&A and reuse the enriched (question-text-bearing)
      // result for the fed-back prompt + the later plan phase.
      const enriched = await this._writeClarifyAnswers(questions, answers);
      for (const a of enriched) collected.push(a);
      await appendAudit(
        this.pipeline.dir,
        `Clarify round ${round}: answered ${answers.length} question(s).`,
      );
      this._phase('clarify', round, 'done');
    }
    return collected;
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
        model: this.claude.model,
        mock: this.claude.mock,
      },
    };
  }

  /** Translate a low-level claude/mock event into a pipeline 'log' event. */
  _onAgentEvent(role, e) {
    if (!e) return;
    const text = (e.text || '').trim();
    if (text) {
      this._log(role, 'info', text);
      return;
    }
    // Surface tool activity even without text.
    if (e.type && e.type !== 'assistant') {
      const t = e.raw?.file ? `${e.type}: ${e.raw.file}` : e.type;
      this._log(role, 'debug', t);
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
