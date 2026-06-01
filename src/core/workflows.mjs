// src/core/workflows.mjs
// Global workflow-template store + the built-in DEFAULT_WORKFLOW + resolveWorkflow.
//
// Templates are TOPOLOGY ONLY (steps + feedbacks, by node-instance id); they live
// under ~/.maestro/workflows/<id>.json (global, honoring MAESTRO_HOME like
// projects.mjs). Per-project model/effort/cycle data is the run-config in
// config.mjs and is merged in by resolveWorkflow.
//
// Reads never throw: a missing/corrupt store yields []/null. Writes are atomic
// (temp file + rename), mirroring config.mjs / projects.mjs.

import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { maestroHome } from './projects.mjs';
import { resolveRunConfig } from './config.mjs';

/**
 * The built-in default workflow: the CURRENT pipeline Plan -> Refine -> Implement
 * -> Review, with the two feedback loops that reproduce today's _refineLoop and
 * _reviewLoop (orchestrator.mjs:331-459):
 *   - refiner self-loop  (s1_0 -> s1_0): re-run the refine step on blocking issues.
 *   - review -> implement (s3_0 -> s2_0): on blocking review issues, run an
 *     implementer fix pass (the 'to' step) then re-review.
 * Default cycle counts come from run-config resolution (resolveRunConfig falls
 * back to DEFAULT_MAX_CYCLES = 5, matching orchestrator maxRefine/maxReviewCycles).
 * NOT persisted to the user store; always present; readWorkflow('wf_default')
 * returns it.
 * @type {{id:string,name:string,version:number,steps:Array<Array<{id:string,key:string}>>,feedbacks:Array<{id:string,from:string,to:string}>,createdAt:string,updatedAt:string}}
 */
export const DEFAULT_WORKFLOW = Object.freeze({
  id: 'wf_default',
  name: 'Default',
  version: 1,
  steps: [
    [{ id: 's0_0', key: 'planner' }],
    [{ id: 's1_0', key: 'refiner' }],
    [{ id: 's2_0', key: 'implementer' }],
    [{ id: 's3_0', key: 'reviewer' }],
  ],
  feedbacks: [
    { id: 'fb_refine', from: 's1_0', to: 's1_0' },
    { id: 'fb_review', from: 's3_0', to: 's2_0' },
  ],
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
});

/** Absolute path to ~/.maestro/workflows (honors MAESTRO_HOME via projects.mjs). */
export function workflowsDir() {
  return join(maestroHome(), 'workflows');
}

/** Absolute path to a single template file. */
function workflowFile(id) {
  return join(workflowsDir(), `${id}.json`);
}

export function listWorkflows() { return []; }            // Task 2
export function readWorkflow(_id) { return null; }         // Task 2
export function writeWorkflow(_tpl) { throw new Error('not implemented'); } // Task 2
export function deleteWorkflow(_id) { return false; }      // Task 3
export function resolveWorkflow(_projectDir, _workflowId, _registry) { throw new Error('not implemented'); } // Task 6
