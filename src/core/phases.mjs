// src/core/phases.mjs
//
// Per-phase agent runners. Each runner:
//   - loads the matching agents/*.md body (passed in via ctx.agentPrompts) and uses it
//     as the *appended* system prompt, *prepended* with the preflight toolInstruction,
//   - builds a per-role task prompt that ALSO carries the MOCK markers the offline mock
//     runner parses (MOCK_ROLE / MOCK_OUT / MOCK_JSON / MOCK_CYCLE / MOCK_IN / MOCK_BASE),
//     so a full pipeline can run with MAESTRO_MOCK=1 without spawning claude,
//   - sets allowedTools appropriate for the role,
//   - calls runClaude, then reads the produced artifact back through protocol and returns
//     the contracted shape.
//
// If an agent .md body is missing/empty, each runner falls back to a sensible inline role
// prompt so the system prompt is never empty. Interface is locked by docs/ARCHITECTURE.md §3.5.

import { runClaude } from './claude-runner.mjs';
import { readClarify, readReview } from './protocol.mjs';
import { renderAttachmentsBlock } from './channels.mjs';

// ── allowedTools per role ──────────────────────────────────────────────────────
// `Skill` lets agents invoke project (.claude/skills) and personal (~/.claude/skills)
// skills via the Skill tool; without it, headless `claude -p` denies skill calls.
const READ_WRITE_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Skill'];
// Implementer additionally gets MultiEdit for larger, multi-hunk edits.
const IMPLEMENTER_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Grep', 'Glob', 'Skill'];

/**
 * Effective `--allowedTools` for a node: the role's baseline file/exec tools UNION
 * the agent's frontmatter-declared tools (e.g. the Playwright MCP `browser_*` tools).
 *
 * Frontmatter only ADDS to the baseline — an agent that omits Write still keeps it
 * (so it can write its artifact JSON), and declaring MCP tools in the `.md` is all a
 * future agent needs to have them granted to its headless `claude -p` run. The list
 * is de-duplicated with the base entries kept first (stable, readable argv order).
 *
 * `declared` is `ctx.node?.tools`, already parsed from frontmatter by resolveWorkflow
 * (workflows.mjs parseFrontmatterTools). It is undefined for the clarify pre-step
 * (which runs off _phaseCtx and has no node), so callers pass it straight through and
 * get the base list back unchanged.
 *
 * @param {string[]} base       the role's default allow-list (READ_WRITE_TOOLS / IMPLEMENTER_TOOLS)
 * @param {string[]|undefined} declared  node.tools from frontmatter, may be undefined
 * @returns {string[]} de-duplicated union, base entries first
 */
export function effectiveAllowedTools(base, declared, fanOut = false) {
  const out = Array.isArray(base) ? [...base] : [];
  const seen = new Set(out);
  const add = (t) => {
    const name = String(t || '').trim();
    if (name && !seen.has(name)) { seen.add(name); out.push(name); }
  };
  for (const t of Array.isArray(declared) ? declared : []) add(t);
  // Fan-out: unlock the sub-agent tool so this agent can spawn its own sub-agents.
  // Grant BOTH names defensively: the installed `claude` CLI's sub-agent tool is
  // named `Task`; an allowed-but-nonexistent name is harmless. (Do NOT rely on the
  // orchestrator's `toolTarget` log-formatter as proof either name is honored.)
  if (fanOut) { add('Task'); add('Agent'); }
  return out;
}

// ── inline fallbacks (used only when agents/*.md is missing/empty) ──────────────
const FALLBACK_PROMPTS = {
  'planner-clarify':
    'You are the Planner in clarify mode. Before planning a software task you MUST surface ' +
    'conceptual questions instead of assuming anything. For each thing you would otherwise ' +
    'assume, write a question offering exactly THREE options plus a free-text field. Output a ' +
    'JSON file (path given in the task) shaped as ' +
    '{ "questions": [ { "id", "question", "options": [a,b,c], "allowFreeText": true } ] }. ' +
    'If you genuinely have no open questions, write { "questions": [] }.',
  'planner-plan':
    'You are the Planner. Write a thorough implementation plan to the markdown path given in ' +
    'the task. The plan MUST include concrete code snippets for the features and MUST end with ' +
    'a "## Clarifications (Q&A)" section listing what was asked and how the user answered. ' +
    'When done, hand off naming the plan file location.',
  refiner:
    'You are the Plan Refiner. Critically review the given plan (including its code snippets), ' +
    'write a refined version to the output path, and emit a review JSON ' +
    '({ "issues": [ { "severity", "title", "detail", "location" } ], "summary" }) using ' +
    'severities critical|major|minor|suggestion. Only critical/major are blocking.',
  implementer:
    'You are the Implementer. Follow the latest plan with NO deviation, using TDD ' +
    '(red-green-refactor). Deviate only if something does not work at all. In fix mode, address ' +
    'every critical/major issue in the referenced review.',
  reviewer:
    'You are the Code Reviewer. Review the git diff of what was implemented against the plan. ' +
    'Write a human-readable review markdown AND a review JSON ' +
    '({ "issues": [ { "severity", "title", "detail", "location" } ], "summary" }). ' +
    'Use severities critical|major|minor|suggestion; only critical/major block.',
  'manual-tests-checklist':
    'You are the Manual Tests author. Read the plan and the implemented diff, then write a ' +
    'markdown checklist of manual test cases (each a `- [ ]` line with steps + expected result) ' +
    'to the path given in the task.',
  'manual-web-ui-testing':
    'You are the Manual Web UI Tester. Run each case in the manual checklist against the live ' +
    'web UI using the Playwright tools, then write a result markdown AND a review JSON ' +
    '({ "issues": [ { "severity", "title", "detail", "location" } ], "summary" }). Use severities ' +
    'critical|major|minor|suggestion; a failing case is at least major.',
  'plan-review':
    'You are the Plan Reviewer. Review the implementation PLAN (its structure, correctness, ' +
    'completeness, feasibility, and code snippets) against the original request and the real ' +
    'codebase. Do NOT rewrite the plan. Write a human-readable review markdown AND a review JSON ' +
    '({ "issues": [ { "severity", "title", "detail", "location" } ], "summary" }) using severities ' +
    'critical|major|minor|suggestion; only critical/major block (the planner then revises).',
};

/**
 * Build the full appended system prompt: toolInstruction first (if any), then the agent
 * body (or a sensible inline fallback when the body is missing/empty).
 */
function buildSystemPrompt(toolInstruction, agentBody, role) {
  const parts = [];
  const tool = (toolInstruction || '').trim();
  if (tool) parts.push(tool);
  const body = (agentBody || '').trim();
  parts.push(body || FALLBACK_PROMPTS[role] || '');
  return parts.filter(Boolean).join('\n\n');
}

/** Render the MOCK marker block appended to every task prompt. */
function mockMarkers(fields) {
  const lines = [];
  for (const [key, val] of Object.entries(fields)) {
    if (val === undefined || val === null || val === '') continue;
    lines.push(`${key}: ${val}`);
  }
  return lines.join('\n');
}

/** Map the orchestrator's claudeOpts into runClaude options shared by every role. */
function runOpts(ctx, { role, prompt, systemPrompt, allowedTools }) {
  const c = ctx.claudeOpts || {};
  return {
    cwd: ctx.projectDir,
    systemPrompt,
    prompt,
    // Grant the role's baseline tools PLUS whatever the agent declared in its
    // frontmatter (e.g. the Playwright MCP browser_* tools). ctx.node is present
    // for every dispatched node (orchestrator._nodeCtx); the clarify pre-step has
    // no node, so this falls back to the base list. Fixes "Browser permission not
    // granted" for the Manual Web UI Testing agent and makes future MCP agents work.
    allowedTools: effectiveAllowedTools(allowedTools, ctx.node?.tools, !!(ctx.node && ctx.node.fanOut)),
    permissionMode: c.permissionMode || 'acceptEdits',
    model: c.model,
    effort: c.effort,          // per-role effort from the orchestrator
    bin: c.bin,
    mock: c.mock,
    signal: ctx.signal,
    onEvent: (e) => {
      if (typeof ctx.onEvent === 'function') ctx.onEvent({ ...e, role });
    },
  };
}

/** A compact task header reused across roles. Exported for testing. */
export function taskHeader(ctx, title) {
  // Who gets the raw request? The ENTRY node (step 0) always — it stands in for any
  // missing upstream artifact and owns the user's attachments. Otherwise: userPrompt
  // consumers, plus the refiner & reviewer by policy; the clarify pre-step (no inputs).
  const key = ctx.node?.key;
  const isEntry = !!ctx.isEntry;
  const consumesPrompt = !ctx.inputs || ('userPrompt' in ctx.inputs);
  const wantsPrompt = isEntry || consumesPrompt || key === 'refiner' || key === 'reviewer' || key === 'planReviewer';
  const requestBlock = wantsPrompt
    ? `## Original request\n\n${(ctx.taskPrompt || '').trim() || '(no prompt text)'}\n`
    : `## Upstream input\n\nYour input is the output of the preceding step(s); the file paths to read are named below.\n`;
  const attachBlock = isEntry ? renderAttachmentsBlock(ctx.extras) : '';
  return (
    `# Task: ${title}\n\n` +
    `Project directory (your cwd): ${ctx.projectDir}\n` +
    `Pipeline directory (shared artifacts): ${ctx.pipelineDir}\n\n` +
    `Project and personal skills (.claude/skills in this project and ~/.claude/skills) are ` +
    `available via the Skill tool — invoke any that fit (e.g. design, framework-pattern, or ` +
    `knowledge-graph skills) rather than guessing conventions.\n\n` +
    requestBlock +
    attachBlock
  );
}

/**
 * Build the clarify task prompt. When the user has already answered questions in
 * an earlier round, those are injected so the planner never re-asks them.
 * Exported for testing. Pure (no IO).
 * @param {import('./phases.mjs').PhaseContext} ctx
 * @param {{ round?: number, priorAnswers?: Array<{id,question,choice}> }} [opts]
 */
export function buildClarifyPrompt(ctx, opts = {}) {
  const round = Number(opts.round) > 0 ? Number(opts.round) : 1;
  const priorAnswers = Array.isArray(opts.priorAnswers) ? opts.priorAnswers : [];
  const outPath = joinPipeline(ctx.pipelineDir, 'clarify.json');
  const role = 'planner-clarify';
  const answered =
    priorAnswers.length > 0
      ? '## Already answered — DO NOT ask these again\n\n' +
        'The user already answered the questions below in an earlier round. Do NOT re-ask, ' +
        'rephrase, or split them. Ask ONLY genuinely new questions that are still material and ' +
        'not implied by these answers. If nothing material remains open, write ' +
        '{ "questions": [] } to the path below.\n\n' +
        renderAnswers(priorAnswers) +
        '\n'
      : '';
  return (
    taskHeader(ctx, 'Clarify before planning') +
    '\n## What to do\n\n' +
    'Identify ONLY the few highest-impact decisions you cannot safely resolve from the task text ' +
    'or the real codebase. For each, produce one conceptual question with exactly three options ' +
    'and a free-text fallback. Prefer the smallest set of questions that unblocks a correct plan; ' +
    'for low-impact details, pick a sensible default rather than asking. If you have no material ' +
    'open questions, write { "questions": [] } to that same path.\n\n' +
    `Write the clarify JSON to: ${outPath}\n\n` +
    answered +
    mockMarkers({
      MOCK_ROLE: role,
      MOCK_OUT: outPath,
      MOCK_CYCLE: round,
      MOCK_PRIOR: priorAnswers.length,
    })
  );
}

/**
 * Planner — clarify role. Writes clarify.json; returns { questions }.
 * @param {import('./phases.mjs').PhaseContext} ctx
 * @param {{ round?: number, priorAnswers?: Array<{id,question,choice}> }} [opts]
 *   `priorAnswers` are the Q&A already resolved in earlier rounds; injecting them
 *   lets the planner ask only NEW questions, so the loop terminates naturally.
 */
export async function runPlannerClarify(ctx, opts = {}) {
  const round = Number(opts.round) > 0 ? Number(opts.round) : 1;
  const priorAnswers = Array.isArray(opts.priorAnswers) ? opts.priorAnswers : [];
  const role = 'planner-clarify';
  const systemPrompt = buildSystemPrompt(ctx.toolInstruction, ctx.agentPrompts?.planner, role);
  const prompt = buildClarifyPrompt(ctx, { round, priorAnswers });

  await runClaude(runOpts(ctx, { role, prompt, systemPrompt, allowedTools: READ_WRITE_TOOLS }));

  const clarify = await readClarify(ctx.pipelineDir);
  return { questions: clarify.questions };
}

/**
 * Planner — plan role. Writes the plan markdown; returns { planPath }.
 * @param {import('./phases.mjs').PhaseContext} ctx
 * @param {{ answers: Array<{id,question,choice}>, planFilePath: string, baseName: string }} opts
 */
export async function runPlannerPlan(ctx, opts) {
  const { answers = [], planFilePath, baseName, reviewPath } = opts || {};
  const role = 'planner-plan';
  const systemPrompt = buildSystemPrompt(ctx.toolInstruction, ctx.agentPrompts?.planner, role);
  const replanBlock = reviewPath
    ? '\n## Revise to address the review\n\n' +
      'A reviewer found issues with the previous plan. Re-plan from scratch (cold start) and ' +
      'address EVERY critical and major finding in the review below. Preserve the ' +
      '"## Clarifications (Q&A)" section.\n\n' +
      `Review to address: ${reviewPath}\n`
    : '';
  const prompt =
    taskHeader(ctx, reviewPath ? 'Revise the implementation plan' : 'Write the implementation plan') +
    '\n## What to do\n\n' +
    'Write a complete, build-ready implementation plan. It MUST contain concrete code snippets ' +
    'for the features and MUST end with a "## Clarifications (Q&A)" section reproducing the ' +
    'questions and the user answers below so the reviewer can see them.\n\n' +
    `Write the plan markdown to: ${planFilePath}\n` +
    replanBlock +
    '\n## Clarifications already answered\n\n' +
    renderAnswers(answers) +
    '\n' +
    mockMarkers({ MOCK_ROLE: role, MOCK_OUT: planFilePath, MOCK_BASE: baseName, MOCK_IN: reviewPath });

  await runClaude(runOpts(ctx, { role, prompt, systemPrompt, allowedTools: READ_WRITE_TOOLS }));

  return { planPath: planFilePath };
}

/**
 * Plan Refiner — one cycle. Reads inPlanPath, writes refined plan to outPlanPath and a
 * review JSON to reviewJsonPath. Returns { outPlanPath, review }.
 * @param {import('./phases.mjs').PhaseContext} ctx
 * @param {{ inPlanPath: string, outPlanPath: string, cycle: number, reviewJsonPath: string }} opts
 */
export async function runRefiner(ctx, opts) {
  const { inPlanPath, outPlanPath, cycle, reviewJsonPath } = opts || {};
  const role = 'refiner';
  const systemPrompt = buildSystemPrompt(ctx.toolInstruction, ctx.agentPrompts?.refiner, role);
  const prompt =
    taskHeader(ctx, `Refine the plan (cycle ${cycle})`) +
    '\n## What to do\n\n' +
    `Read the current plan, critically review it INCLUDING its code snippets, then write an ` +
    `improved version and a machine-readable review.\n\n` +
    `Current plan to refine: ${inPlanPath}\n` +
    `Write the refined plan to: ${outPlanPath}\n` +
    `Write the review JSON to: ${reviewJsonPath}\n\n` +
    'The review JSON shape is { "issues": [ { "severity", "title", "detail", "location" } ], ' +
    '"summary" }. Use severities critical|major|minor|suggestion. Mark a finding critical/major ' +
    'only if it must be fixed before implementation.\n\n' +
    mockMarkers({
      MOCK_ROLE: role,
      MOCK_OUT: outPlanPath,
      MOCK_JSON: reviewJsonPath,
      MOCK_CYCLE: cycle,
      MOCK_IN: inPlanPath,
    });

  await runClaude(runOpts(ctx, { role, prompt, systemPrompt, allowedTools: READ_WRITE_TOOLS }));

  const review = await readReview(reviewJsonPath);
  return { outPlanPath, review };
}

/**
 * Implementer — implement or fix. Returns { summary }.
 * @param {import('./phases.mjs').PhaseContext} ctx
 * @param {{ planPath: string, reviewPath?: string, mode: "implement"|"fix" }} opts
 */
export async function runImplementer(ctx, opts) {
  const { planPath, reviewPath, mode = 'implement' } = opts || {};
  const role = 'implementer';
  const systemPrompt = buildSystemPrompt(ctx.toolInstruction, ctx.agentPrompts?.implementer, role);

  const body =
    mode === 'fix'
      ? `Address EVERY critical and major issue in the review below, then re-run the tests. ` +
        `Follow the plan; deviate only if something does not work at all.\n\n` +
        `Plan: ${planPath}\n` +
        `Review to fix: ${reviewPath}\n`
      : `Implement the plan using TDD (red-green-refactor). Follow it with NO deviation; ` +
        `deviate slightly only if a step does not work at all.\n\n` +
        `Plan: ${planPath}\n`;

  const prompt =
    taskHeader(ctx, mode === 'fix' ? 'Fix the implementation' : 'Implement the plan') +
    '\n## What to do\n\n' +
    body +
    '\nWork inside the project directory (your cwd). Commit nothing; just edit files and tests.\n\n' +
    mockMarkers({ MOCK_ROLE: role, MOCK_IN: planPath, MOCK_OUT: reviewPath });

  const { text } = await runClaude(
    runOpts(ctx, { role, prompt, systemPrompt, allowedTools: IMPLEMENTER_TOOLS }),
  );

  const summary = (text || '').trim() || `Implementer (${mode}) completed.`;
  return { summary };
}

/**
 * Code Reviewer — one cycle. Writes review markdown + review JSON. Returns { review }.
 * @param {import('./phases.mjs').PhaseContext} ctx
 * @param {{ planPath: string, reviewMdPath: string, reviewJsonPath: string, cycle: number }} opts
 */
export async function runReviewer(ctx, opts) {
  const { planPath, reviewMdPath, reviewJsonPath, cycle } = opts || {};
  const role = 'reviewer';
  const systemPrompt = buildSystemPrompt(ctx.toolInstruction, ctx.agentPrompts?.reviewer, role);
  // Prefer diffing against the recorded checkpoint commit. New files are made
  // visible via the orchestrator's intent-to-add staging after each implement
  // pass, so `git diff <ref>` and `git status` both show greenfield work.
  const ref = (ctx.checkpointRef || '').trim();
  const diffInstruction = ref
    ? `Inspect the diff with \`git diff ${ref}\` (the orchestrator's pre-implementation ` +
      `checkpoint) and \`git status\` in your cwd. New/untracked files are intent-to-added, ` +
      `so they DO appear in that diff; use \`git status\` to cross-check.`
    : 'Inspect the diff with `git diff` and `git status` in your cwd. If `git diff` looks ' +
      'empty, the changes may be newly-created files — confirm with `git status` and ' +
      '`git diff HEAD`.';
  const prompt =
    taskHeader(ctx, `Review the implementation (cycle ${cycle})`) +
    '\n## What to do\n\n' +
    'Review the git diff of what was implemented against the plan. Write a human-readable review ' +
    'markdown AND a machine-readable review JSON. ' +
    diffInstruction +
    '\n\n' +
    `Plan that was implemented: ${planPath}\n` +
    `Write the review markdown to: ${reviewMdPath}\n` +
    `Write the review JSON to: ${reviewJsonPath}\n\n` +
    'The review JSON shape is { "issues": [ { "severity", "title", "detail", "location" } ], ' +
    '"summary" }. Use severities critical|major|minor|suggestion; only critical/major block the ' +
    'pipeline.\n\n' +
    mockMarkers({
      MOCK_ROLE: role,
      MOCK_OUT: reviewMdPath,
      MOCK_JSON: reviewJsonPath,
      MOCK_CYCLE: cycle,
    });

  await runClaude(runOpts(ctx, { role, prompt, systemPrompt, allowedTools: READ_WRITE_TOOLS }));

  const review = await readReview(reviewJsonPath);
  return { review };
}

/**
 * Plan Reviewer — one cycle. Reviews the PLAN markdown (no git diff). Writes a review
 * markdown + review JSON. Returns { review }.
 * @param {import('./phases.mjs').PhaseContext} ctx
 * @param {{ planPath: string, reviewMdPath: string, reviewJsonPath: string, cycle: number }} opts
 */
export async function runPlanReviewer(ctx, opts) {
  const { planPath, reviewMdPath, reviewJsonPath, cycle } = opts || {};
  const role = 'plan-review';
  const systemPrompt = buildSystemPrompt(ctx.toolInstruction, ctx.agentPrompts?.planReviewer, role);
  const prompt =
    taskHeader(ctx, `Review the plan (cycle ${cycle})`) +
    '\n## What to do\n\n' +
    'Review the implementation PLAN against the original request and the real codebase. Do NOT ' +
    'rewrite the plan. Write a human-readable review markdown AND a machine-readable review JSON.\n\n' +
    `Plan to review: ${planPath}\n` +
    `Write the review markdown to: ${reviewMdPath}\n` +
    `Write the review JSON to: ${reviewJsonPath}\n\n` +
    'The review JSON shape is { "issues": [ { "severity", "title", "detail", "location" } ], ' +
    '"summary" }. Use severities critical|major|minor|suggestion; only critical/major block (the ' +
    'planner then revises).\n\n' +
    mockMarkers({
      MOCK_ROLE: role,
      MOCK_OUT: reviewMdPath,
      MOCK_JSON: reviewJsonPath,
      MOCK_CYCLE: cycle,
      MOCK_IN: planPath,
    });

  await runClaude(runOpts(ctx, { role, prompt, systemPrompt, allowedTools: READ_WRITE_TOOLS }));

  const review = await readReview(reviewJsonPath);
  return { review };
}

/**
 * Manual Tests Checklist — producer. Reads the plan (and any implementation diff)
 * and writes a markdown checklist of manual test cases as a pipeline artifact.
 * Returns { checklistPath, summary }.
 * @param {import('./phases.mjs').PhaseContext} ctx
 * @param {{ planPath: string, checklistPath: string }} opts
 */
export async function runManualTestsChecklist(ctx, opts) {
  const { planPath, checklistPath } = opts || {};
  const role = 'manual-tests-checklist';
  const systemPrompt = buildSystemPrompt(
    ctx.toolInstruction,
    ctx.agentPrompts?.manualTestsChecklist,
    role,
  );
  const prompt =
    taskHeader(ctx, 'Draft a manual test checklist') +
    '\n## What to do\n\n' +
    'Read the implementation plan and the implemented changes (via `git diff` in your cwd), ' +
    'then write a markdown checklist of concrete manual test cases a human can run against the ' +
    'app. Each case: a `- [ ]` line with steps and the expected result.\n\n' +
    `Plan: ${planPath}\n` +
    `Write the checklist markdown to: ${checklistPath}\n\n` +
    mockMarkers({ MOCK_ROLE: role, MOCK_OUT: checklistPath, MOCK_IN: planPath });

  const { text } = await runClaude(
    runOpts(ctx, { role, prompt, systemPrompt, allowedTools: READ_WRITE_TOOLS }),
  );

  const summary = (text || '').trim() || 'Manual test checklist written.';
  return { checklistPath, summary };
}

/**
 * Manual web UI testing — verifier (loopSource). Drives the running web UI through
 * the manual checklist (Playwright MCP, declared in the agent frontmatter) and
 * emits the protocol review verdict JSON. Returns { review }.
 * @param {import('./phases.mjs').PhaseContext} ctx
 * @param {{ checklistPath: string, reviewMdPath: string, reviewJsonPath: string, cycle: number }} opts
 */
export async function runManualWebUiTesting(ctx, opts) {
  const { checklistPath, reviewMdPath, reviewJsonPath, cycle } = opts || {};
  const role = 'manual-web-ui-testing';
  const systemPrompt = buildSystemPrompt(
    ctx.toolInstruction,
    ctx.agentPrompts?.manualWebUiTesting,
    role,
  );
  const prompt =
    taskHeader(ctx, `Run the manual web UI tests (cycle ${cycle})`) +
    '\n## What to do\n\n' +
    'Execute the manual test checklist against the running web UI using the Playwright tools. ' +
    'Write a human-readable result markdown AND a machine-readable review JSON.\n\n' +
    `Checklist to run: ${checklistPath}\n` +
    `Write the result markdown to: ${reviewMdPath}\n` +
    `Write the review JSON to: ${reviewJsonPath}\n\n` +
    'The review JSON shape is { "issues": [ { "severity", "title", "detail", "location" } ], ' +
    '"summary" }. Use severities critical|major|minor|suggestion; only critical/major block the ' +
    'pipeline (a failing manual case is at least major).\n\n' +
    mockMarkers({
      MOCK_ROLE: role,
      MOCK_OUT: reviewMdPath,
      MOCK_JSON: reviewJsonPath,
      MOCK_CYCLE: cycle,
    });

  await runClaude(runOpts(ctx, { role, prompt, systemPrompt, allowedTools: READ_WRITE_TOOLS }));

  const review = await readReview(reviewJsonPath);
  return { review };
}

// ── small local helpers ────────────────────────────────────────────────────────

/** Join a file name onto the pipeline dir without importing node:path's full surface. */
function joinPipeline(pipelineDir, name) {
  const base = String(pipelineDir || '').replace(/\/+$/, '');
  return `${base}/${name}`;
}

/** Render the answered clarifications as a markdown Q&A list for the plan prompt. */
function renderAnswers(answers) {
  if (!Array.isArray(answers) || answers.length === 0) {
    return '_No clarifying questions were asked._\n';
  }
  return (
    answers
      .map((a) => `- **Q:** ${String(a.question || '').trim()} — **A:** ${String(a.choice || '').trim()}`)
      .join('\n') + '\n'
  );
}
