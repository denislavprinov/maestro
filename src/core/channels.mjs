// src/core/channels.mjs
// Typed channel vocabulary + the dispatch-time binder. Pure: the only IO is the
// path STRINGS it computes via artifacts.mjs (no reads/writes). Replaces the
// role-coupled _nodeIo/_afterNode switch with data-driven channel wiring.

import { join } from 'node:path';
import { planPath, reviewPath } from './artifacts.mjs';

/** The closed set of channel ids for v1 (single source; imported by registry + validator). */
export const CHANNEL_IDS = ['userPrompt', 'plan', 'review', 'checklist', 'code'];

/**
 * Mint the concrete OUTPUT handle for a channel the node produces. This is the
 * relocated output half of the old _nodeIo switch; paths are byte-identical so
 * history/state.json/MOCK markers do not move.
 * @param {string} channel
 * @param {{projectDir,pipelineDir,baseName,datePrefix,cycle,key?}} ctx
 */
export function allocate(channel, ctx) {
  const { projectDir, pipelineDir, baseName, datePrefix, cycle, key } = ctx;
  switch (channel) {
    case 'plan': {
      // ▲ C1: the planner writes the canonical v1 file (it has no inbound loop, so
      // cycle is always 1) — exactly today's seeded `io.planPath`. Only the refiner
      // versions up to cycle+1 (matching _nodeIo's refiner arm). Producer-aware.
      const version = key === 'planner' ? 1 : cycle + 1;
      return { kind: 'artifact', path: planPath(projectDir, baseName, version, datePrefix) };
    }
    case 'review': {
      // Review json basename differs by producing role (keeps existing filenames).
      const base = key === 'refiner' ? 'refine-review' : key === 'manualWebUiTesting' ? 'webui-review' : 'impl-review';
      // ▲ C2: the refiner emits ONLY a json verdict (loop-gating); it has no review
      // md. A null md marks the review "private" so publish() never folds it onto the
      // shared `review` channel an implementer consumes.
      const mdPath = key === 'refiner'
        ? null
        : key === 'manualWebUiTesting'
          ? join(pipelineDir, `webui-review-cycle${cycle}.md`)
          : reviewPath(projectDir, baseName, datePrefix);
      return { kind: 'review', mdPath, jsonPath: join(pipelineDir, `${base}-cycle${cycle}.json`) };
    }
    case 'checklist':
      return { kind: 'artifact', path: join(pipelineDir, 'manual-tests-checklist.md') };
    case 'code':
      return { kind: 'worktree' }; // standing channel; nothing to allocate
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
      bus.review = { kind: 'review', mdPath, jsonPath: outputs.review?.jsonPath, verdict: result.review };
    } else if (c === 'checklist') {
      const path = result.checklistPath || outputs.checklist?.path;
      if (path) bus.checklist = { kind: 'artifact', path };
    } else if (c === 'code') {
      bus.review = null; // implementer superseded any pending review (fix-mode reset)
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
  switch (node.key) {
    case 'planner':
      return { planFilePath: outputs.plan?.path, baseName, answers: inputs.userPrompt?.answers || [] };
    case 'refiner':
      return { inPlanPath: inputs.plan?.path, outPlanPath: outputs.plan?.path, reviewJsonPath: outputs.review?.jsonPath, cycle };
    case 'implementer':
      // ▲ C2: gate `fix` on a real review MD (mirrors today's `io.reviewMdPath ? …`),
      // not mere truthiness of the review handle.
      return { planPath: inputs.plan?.path, reviewPath: inputs.review?.mdPath, mode: inputs.review?.mdPath ? 'fix' : 'implement', cycle };
    case 'reviewer':
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
