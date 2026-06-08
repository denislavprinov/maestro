// src/core/channels.mjs
// Typed channel vocabulary + the dispatch-time binder. Pure: the only IO is the
// path STRINGS it computes via artifacts.mjs (no reads/writes). Replaces the
// role-coupled _nodeIo/_afterNode switch with data-driven channel wiring.

import { join } from 'node:path';
import { planPath, reviewPath } from './artifacts.mjs';

/** The closed set of channel ids (single source; imported by registry + validator).
 *  `workspace` (M3) is a read-only metadata channel carrying the frozen workspace
 *  description + member set; it is seeded once and never re-published (CONV-6). */
export const CHANNEL_IDS = ['userPrompt', 'plan', 'review', 'checklist', 'code', 'workspace', 'clarify'];

/**
 * Mint the concrete OUTPUT handle for a channel the node produces. This is the
 * relocated output half of the old _nodeIo switch; paths are byte-identical so
 * history/state.json/MOCK markers do not move.
 * @param {string} channel
 * @param {{projectDir,pipelineDir,baseName,datePrefix,cycle,key?}} ctx
 */
export function allocate(channel, ctx) {
  const { projectDir, pipelineDir, baseName, datePrefix, cycle, key, workspaceKey } = ctx;
  switch (channel) {
    case 'plan': {
      // The planner is cycle-aware so a plan-review -> planner loop writes a fresh
      // -vN on each replan instead of clobbering v1 (cycle is 1 on the first pass,
      // so v1 has NO -v suffix, matching today's seeded io.planPath). The refiner
      // versions up to cycle+1 (a self-loop never produces v1). workspaceKey (when
      // present) routes the unified plan to the workspace store; absent it is byte-
      // identical to the single-project path.
      const version = key === 'planner' ? cycle : cycle + 1;
      return { kind: 'artifact', path: planPath(projectDir, baseName, version, datePrefix, workspaceKey) };
    }
    case 'review': {
      // Review json basename differs by producing role (keeps existing filenames).
      const base = key === 'refiner'
        ? 'refine-review'
        : key === 'manualWebUiTesting'
          ? 'webui-review'
          : key === 'planReviewer'
            ? 'plan-review'
            : key === 'workspaceReviewer'
              ? 'ws-review'
              : 'impl-review';
      // ▲ C2: the refiner emits ONLY a json verdict (its md is null => private to its
      // self-loop). Every other verifier carries a review md so publish() folds it
      // onto the shared `review` channel its loop target consumes. workspaceKey routes
      // the review md to the workspace store (the json stays per-cycle in the pipeline
      // dir, store-root independent); absent it is byte-identical.
      const mdPath = key === 'refiner'
        ? null
        : key === 'manualWebUiTesting'
          ? join(pipelineDir, `webui-review-cycle${cycle}.md`)
          : key === 'planReviewer'
            ? reviewPath(projectDir, baseName, datePrefix, 'plan-review', workspaceKey)
            : key === 'workspaceReviewer'
              ? reviewPath(projectDir, baseName, datePrefix, 'ws-review', workspaceKey)
              : reviewPath(projectDir, baseName, datePrefix, 'impl-review', workspaceKey);
      return { kind: 'review', mdPath, jsonPath: join(pipelineDir, `${base}-cycle${cycle}.json`), reviewKind: base };
    }
    case 'checklist':
      return { kind: 'artifact', path: join(pipelineDir, 'manual-tests-checklist.md') };
    case 'code':
      return { kind: 'worktree' }; // standing channel; nothing to allocate
    case 'workspace':
      // Read-only metadata handle: the frozen workspace description snapshot. The
      // member set + description are seeded onto the bus directly by the orchestrator
      // (this just names the on-disk path of the frozen snapshot).
      return { kind: 'metadata', path: join(pipelineDir, 'workspace-description.md') };
    case 'clarify':
      // The clarify agent writes clarify.json into the pipeline dir as scratch; the
      // DB clarify row is authoritative. Same path the legacy pre-step used.
      return { kind: 'clarify', path: join(pipelineDir, 'clarify.json') };
    default:
      return null;
  }
}

/**
 * Resolve a node's inputs from the bus (latest-writer-wins). Required channels that
 * are null still pass through (the agent/mock proceeds, e.g. a pre-seeded but
 * unwritten plan path). Optional channels that are null are omitted entirely.
 */
export function bindInputs(consumes, optionalConsumes, bus) {
  const optional = new Set(optionalConsumes || []);
  const inputs = {};
  for (const c of consumes || []) {
    const v = bus[c];
    if (v == null && optional.has(c)) continue; // omit absent optional channel
    inputs[c] = v;
  }
  return inputs;
}

/**
 * Fold a node's result back onto the bus for each produced channel, in node order.
 * Clearing `review` on a `code` publish fixes the sticky fix-mode bug: a later
 * implementer no longer sees a stale review.
 */
export function publish(produces, result, outputs, bus) {
  if (!result) return;
  for (const c of produces || []) {
    if (c === 'plan') {
      const path = result.outPlanPath || result.planPath || outputs.plan?.path;
      if (path) bus.plan = { kind: 'artifact', path };
    } else if (c === 'review') {
      // ▲ C2: only a review carrying an md (reviewer / manualWebUiTesting) is shared.
      // The refiner's md-less verdict stays private to its self-loop (read from the
      // results array by _reviewOf, never the bus), so it can't flip a later
      // implementer into `fix` mode.
      const mdPath = result.reviewMdPath ?? outputs.review?.mdPath;
      if (!mdPath) continue;
      bus.review = { kind: 'review', mdPath, jsonPath: outputs.review?.jsonPath, verdict: result.review, reviewKind: outputs.review?.reviewKind };
    } else if (c === 'checklist') {
      const path = result.checklistPath || outputs.checklist?.path;
      if (path) bus.checklist = { kind: 'artifact', path };
    } else if (c === 'code') {
      bus.review = null; // implementer superseded any pending review (fix-mode reset)
    } else if (c === 'workspace') {
      // Read-only metadata: seeded once by the orchestrator, NEVER re-published
      // (CONV-6: the frozen per-step snapshot must not change mid-run). No-op.
    } else if (c === 'clarify') {
      // The clarify node carries questions (from the agent) + answers (from the
      // interactive gate) in its result; fold both onto the bus so the planner reads
      // inputs.clarify.answers.
      bus.clarify = {
        kind: 'clarify',
        path: outputs.clarify?.path,
        questions: result.questions || [],
        answers: result.answers || [],
      };
    }
  }
}

/**
 * Adapter: flatten typed inputs/outputs into the EXACT field names the phases.mjs
 * runners already read (verified against runners.mjs), so runners.mjs/phases.mjs and
 * the runner/dispatcher tests need ZERO changes. This is one of two role switches
 * (the other is runners.mjs's producer/verifier); it names fields, it does not
 * compute data flow.
 */
export function legacyFields(node, inputs, outputs, cycle, baseName) {
  const fields = legacyRoleFields(node, inputs, outputs, cycle, baseName);
  // Workspace runs: surface the read-only metadata channel (description + member
  // set) onto the flattened ctx so phases.mjs runners read ctx.workspace. Absent
  // the channel (every single-project node) the field is never added, so the ctx
  // shape stays byte-identical.
  if (inputs && inputs.workspace) fields.workspace = inputs.workspace;
  return fields;
}

/** Per-role field naming (the original legacyFields body). */
function legacyRoleFields(node, inputs, outputs, cycle, baseName) {
  switch (node.key) {
    case 'planner':
      // reviewPath is set only when a review is bound (a plan-review -> planner
      // rewind), which switches runPlannerPlan into its cold-replan branch.
      return { planFilePath: outputs.plan?.path, baseName, answers: inputs.clarify?.answers || inputs.userPrompt?.answers || [], reviewPath: inputs.review?.mdPath };
    case 'refiner':
      return { inPlanPath: inputs.plan?.path, outPlanPath: outputs.plan?.path, reviewJsonPath: outputs.review?.jsonPath, cycle };
    case 'implementer':
      // The implementer fixes CODE reviews (impl-review / webui-review). A plan-review
      // left on the shared `review` bus by a planReviewer -> planner loop is NOT for the
      // implementer (it bounces to the planner), so it must not flip a first-pass
      // implementer into fix mode. Discriminate by review provenance (reviewKind), not
      // cycle — a linear `... -> reviewer -> implementer` forward edge legitimately fixes
      // a code review at cycle 1 (see saved-pipeline-parity).
      return { planPath: inputs.plan?.path, reviewPath: inputs.review?.mdPath, mode: (inputs.review?.mdPath && inputs.review?.reviewKind !== 'plan-review') ? 'fix' : 'implement', cycle };
    case 'planReviewer':
      return { planPath: inputs.plan?.path, reviewMdPath: outputs.review?.mdPath, reviewJsonPath: outputs.review?.jsonPath, cycle };
    case 'reviewer':
      return { planPath: inputs.plan?.path, reviewMdPath: outputs.review?.mdPath, reviewJsonPath: outputs.review?.jsonPath, cycle };
    case 'workspaceReviewer':
      // Identical field shape to `reviewer` — the workspace synthesizer reads the
      // same planPath/reviewMd/reviewJson/cycle and folds its merged verdict onto
      // the shared `review` channel its implementer loop target consumes.
      return { planPath: inputs.plan?.path, reviewMdPath: outputs.review?.mdPath, reviewJsonPath: outputs.review?.jsonPath, cycle };
    case 'manualTestsChecklist':
      return { planPath: inputs.plan?.path, checklistPath: outputs.checklist?.path };
    case 'manualWebUiTesting':
      return { checklistPath: inputs.checklist?.path, reviewMdPath: outputs.review?.mdPath, reviewJsonPath: outputs.review?.jsonPath, cycle };
    default:
      return { cycle };
  }
}

/** Channels materializable from plain prompt text (markdown artifacts). userPrompt
 *  is already the prompt; code is the standing worktree; review is not pre-seeded and
 *  is optional for its only consumer — so none of those ever seed. */
const SEEDABLE = new Set(['plan', 'checklist']);

/**
 * Decide which materializable channels must be seeded from the user prompt because
 * the topology REQUIRES them before any step produces them (a pipeline that starts
 * mid-stream — implementer/refiner/... first). Mirrors the validator's step-ordered
 * reachability walk (workflow-validator.mjs:112-144) but returns the channels to fill
 * rather than warnings. Reads the channel spec carried on each resolved node, so no
 * registry argument is needed (resolveWorkflow already stamped consumes/produces).
 * @param {Array<Array<{key,consumes,optionalConsumes,produces}>>} steps
 * @returns {string[]} channel ids to seed (subset of SEEDABLE), in first-needed order
 */
export function entrySeedChannels(steps) {
  const seeded = new Set();
  const produced = new Set();
  for (const group of steps || []) {
    for (const node of group || []) {
      const optional = new Set(node?.optionalConsumes || []);
      for (const c of node?.consumes || []) {
        if (!SEEDABLE.has(c) || optional.has(c) || produced.has(c) || seeded.has(c)) continue;
        seeded.add(c);
      }
    }
    // Producers fold in AFTER the step (matches the validator's frozen-snapshot model),
    // so a node that both consumes AND produces the same channel (the refiner) still
    // triggers a seed at its own step.
    for (const node of group || []) for (const c of node?.produces || []) produced.add(c);
  }
  return [...seeded];
}

/**
 * Render the `## Attached files` block listing each attachment by path + name.
 * Single source of truth shared by renderPromptArtifact (the seeded file body) and
 * phases.mjs taskHeader (the entry agent's inline header) so the two cannot drift.
 * Returns '' when there are no attachments.
 * @param {Array<{name:string,path:string}>} [extras]
 */
export function renderAttachmentsBlock(extras = []) {
  if (!Array.isArray(extras) || extras.length === 0) return '';
  return (
    `\n## Attached files\n\nThe user attached these files; read any that are relevant:\n\n` +
    extras.map((e) => `- \`${e.path}\` (${e.name})`).join('\n') +
    '\n'
  );
}

/**
 * Render the markdown a seeded artifact channel holds: the user's request stands in
 * for the missing upstream artifact, with any attached files listed by path.
 * @param {string} promptText
 * @param {Array<{name:string,path:string}>} [extras]
 */
export function renderPromptArtifact(promptText, extras = []) {
  const body = (promptText || '').trim() || '(no prompt text)';
  return (
    `# Task (from the user prompt)\n\n` +
    `No upstream agent produced this artifact, so the user's request below stands in for it.\n\n` +
    `## Original request\n\n${body}\n` +
    renderAttachmentsBlock(extras)
  );
}
