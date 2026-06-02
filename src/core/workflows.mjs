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
import { slugify } from './artifacts.mjs';

/**
 * Default feedback cycle count when run-config does not override it. DEFAULT_WORKFLOW's
 * feedback loops fall back to this (5), reproducing today's gate timing.
 */
const DEFAULT_MAX_CYCLES = 5;

/** Default location of the agent prompt markdown files (mirrors orchestrator.mjs). */
const DEFAULT_AGENTS_DIR = new URL('../../agents/', import.meta.url).pathname;

/**
 * Read an agent prompt file and pull its declared tools from YAML frontmatter.
 * Returns { prompt, tools }. A missing file => { prompt:'', tools:[] } (fails
 * safe; the orchestrator already tolerates an empty agent body). The frontmatter
 * `tools:` line is a comma-separated list (matches agents/*.md convention).
 * @param {string} agentsDir
 * @param {string|null} agentFile
 * @returns {Promise<{prompt:string, tools:string[]}>}
 */
async function loadAgentFile(agentsDir, agentFile) {
  if (!agentFile) return { prompt: '', tools: [] };
  let text = '';
  try {
    text = await readFile(join(agentsDir, agentFile), 'utf8');
  } catch {
    return { prompt: '', tools: [] };
  }
  return { prompt: text, tools: parseFrontmatterTools(text) };
}

/** Extract a comma-separated `tools:` list from leading --- YAML frontmatter. */
function parseFrontmatterTools(text) {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  if (!m) return [];
  const line = m[1].split(/\r?\n/).find((l) => /^tools\s*:/.test(l));
  if (!line) return [];
  return line
    .replace(/^tools\s*:/, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The built-in default workflow: the CURRENT pipeline Plan -> Refine -> Implement
 * -> Review, with the two feedback loops that reproduce today's _refineLoop and
 * _reviewLoop (orchestrator.mjs:331-459):
 *   - refiner self-loop  (s1_0 -> s1_0): re-run the refine step on blocking issues.
 *   - review -> implement (s3_0 -> s2_0): on blocking review issues, run an
 *     implementer fix pass (the 'to' step) then re-review.
 * Default cycle counts come from run-config resolution (resolveRunConfig falls
 * back to DEFAULT_MAX_CYCLES = 5).
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

/** A workflow id is a filename stem; reject anything that could escape the store
 *  (path separators, "..", dots, spaces). Valid ids are wf_<slug> / wf_default. */
const SAFE_WORKFLOW_ID = /^[A-Za-z0-9_-]+$/;
function isSafeWorkflowId(id) { return typeof id === 'string' && SAFE_WORKFLOW_ID.test(id); }

/** Absolute path to a single template file. */
function workflowFile(id) {
  return join(workflowsDir(), `${id}.json`);
}

/** Atomically write the JSON store file. Creates ~/.maestro/workflows on demand. */
async function writeRaw(id, tpl) {
  await mkdir(workflowsDir(), { recursive: true });
  const file = workflowFile(id);
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(tpl, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

/** Read + shallow-validate one stored template. Missing/corrupt => null. */
async function readRaw(id) {
  if (!isSafeWorkflowId(id)) return null; // SECURITY: reject path-traversal / unsafe ids
  try {
    const data = JSON.parse(await readFile(workflowFile(id), 'utf8'));
    if (!data || typeof data !== 'object' || !Array.isArray(data.steps)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Persist a template atomically. Stamps a wf_<slug> id (from the name) when
 * missing, version 1, createdAt (preserved across re-saves) and a fresh
 * updatedAt. Returns the stored object. Never mutates the input.
 * @param {object} tpl { id?, name, steps, feedbacks }
 * @returns {Promise<object>}
 */
export async function writeWorkflow(tpl) {
  const now = new Date().toISOString();
  const name = (tpl && typeof tpl.name === 'string' && tpl.name.trim()) || 'Untitled';
  const id = (tpl && typeof tpl.id === 'string' && tpl.id.trim()) || `wf_${slugify(name)}`;
  // Preserve the original createdAt if this id already exists (re-save).
  const existing = await readRaw(id);
  const createdAt =
    (tpl && typeof tpl.createdAt === 'string' && tpl.createdAt) ||
    existing?.createdAt ||
    now;
  const stored = {
    id,
    name,
    version: 1,
    steps: Array.isArray(tpl?.steps) ? tpl.steps : [],
    feedbacks: Array.isArray(tpl?.feedbacks) ? tpl.feedbacks : [],
    createdAt,
    updatedAt: now,
  };
  await writeRaw(id, stored);
  return stored;
}

/**
 * Read a template by id. Returns the built-in DEFAULT_WORKFLOW for "wf_default";
 * otherwise the stored template, or null when absent/corrupt.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function readWorkflow(id) {
  if (id === DEFAULT_WORKFLOW.id) return DEFAULT_WORKFLOW;
  return readRaw(id);
}

/**
 * List user templates (NOT DEFAULT_WORKFLOW — callers prepend it), newest first
 * by createdAt. Missing store => []. Never throws.
 * @returns {Promise<object[]>}
 */
export async function listWorkflows() {
  let names;
  try {
    names = await readdir(workflowsDir());
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const tpl = await readRaw(f.slice(0, -'.json'.length));
    if (tpl && tpl.id !== DEFAULT_WORKFLOW.id) out.push(tpl);
  }
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return out;
}

/**
 * Delete a saved template by id. Refuses to delete the built-in DEFAULT_WORKFLOW
 * (returns false). Returns false when the file does not exist; true on removal.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteWorkflow(id) {
  if (id === DEFAULT_WORKFLOW.id) return false; // built-in default is undeletable
  if (!isSafeWorkflowId(id)) return false; // SECURITY: reject path-traversal / unsafe ids
  const file = workflowFile(id);
  if (!existsSync(file)) return false;
  try {
    await unlink(file);
    return true;
  } catch {
    return false;
  }
}
/**
 * Merge a workflow template + the project's run-config + the agent registry into
 * an ExecutablePlan the dispatcher runs:
 *   { id, name, steps:[[Node]], feedbacks:[{id,from,to,maxCycles,gate}] }
 *   Node = { nodeId, key, uiPhase, runnerType, agentFile, agentPrompt, model, effort, tools, loopSource }
 * model/effort come from run-config (undefined when unset; the orchestrator folds
 * in the global fallback at dispatch). maxCycles defaults to DEFAULT_MAX_CYCLES.
 * @param {string} projectDir
 * @param {string} workflowId
 * @param {Record<string,object>} registry  loadAgentRegistry() output
 * @param {string} [agentsDir]  override for tests; defaults to ../../agents
 * @returns {Promise<object>} ExecutablePlan
 * @throws {Error} when the workflow id is unknown
 */
export async function resolveWorkflow(projectDir, workflowId, registry, agentsDir = DEFAULT_AGENTS_DIR) {
  const tpl = await readWorkflow(workflowId);
  if (!tpl) throw new Error(`workflow not found: ${workflowId}`);
  const reg = registry && typeof registry === 'object' ? registry : {};
  const { nodes: nodeCfg, feedbacks: fbCfg } = await resolveRunConfig(projectDir, workflowId);
  // CONV-4: map each agent key to the UI stepper bucket the live view understands,
  // so the dispatcher can emit a real `'phase'` per node (every node gets its own
  // stepper cell via the snapshotted manifest; see buildStepperManifest).
  const UI_PHASE = {
    planner: 'plan', refiner: 'refine', implementer: 'implement', reviewer: 'review',
    manualTestsChecklist: 'manual-checklist', manualWebUiTesting: 'manual-web',
  };

  const steps = [];
  for (const group of tpl.steps) {
    const resolvedGroup = [];
    for (const node of group) {
      const meta = reg[node.key] || {};
      const { prompt, tools } = await loadAgentFile(agentsDir, meta.agentFile ?? null);
      const sel = nodeCfg[node.id] || {};
      resolvedGroup.push({
        nodeId: node.id,
        key: node.key,
        uiPhase: UI_PHASE[node.key] || node.key,   // CONV-4: live-UI stepper bucket
        runnerType: meta.runnerType || 'producer',
        agentFile: meta.agentFile ?? null,
        agentPrompt: prompt,
        model: sel.model,            // undefined unless configured (folded later)
        effort: sel.effort,          // undefined unless configured
        tools,
        loopSource: !!meta.loopSource,
      });
    }
    steps.push(resolvedGroup);
  }

  const feedbacks = (Array.isArray(tpl.feedbacks) ? tpl.feedbacks : []).map((fb) => ({
    id: fb.id,
    from: fb.from,
    to: fb.to,
    maxCycles: Number(fbCfg[fb.id]?.maxCycles) > 0 ? Number(fbCfg[fb.id].maxCycles) : DEFAULT_MAX_CYCLES,
    gate: 'hasBlocking',
  }));

  return { id: tpl.id, name: tpl.name, steps, feedbacks };
}

/**
 * Build the UI stepper manifest from a resolved ExecutablePlan + agent registry.
 * The manifest is the snapshot the Running/History views render from, so it is
 * persisted into state.json (and flows through every 'state' event). It brackets
 * the workflow's step-cells with the framework's real Preflight and Done phases.
 *
 * @param {object} plan  resolveWorkflow() output: { id, name, steps, feedbacks }
 * @param {Record<string,object>} registry  loadAgentRegistry() output
 * @returns {{version:1, steps:Array<{kind:string, nodes:object[]}>}}  node shape includes model, effort
 */
export function buildStepperManifest(plan, registry) {
  const reg = registry && typeof registry === 'object' ? registry : {};
  const fbs = Array.isArray(plan?.feedbacks) ? plan.feedbacks : [];
  const isCycleTarget = (nodeId) => fbs.some((fb) => fb && fb.to === nodeId);

  const agentCells = (Array.isArray(plan?.steps) ? plan.steps : []).map((group) => ({
    kind: 'agents',
    nodes: group.map((node) => {
      const meta = reg[node.key] || {};
      return {
        id: node.nodeId,
        key: node.key,
        uiPhase: node.uiPhase || node.key,
        label: meta.displayName || node.key,
        color: meta.color || '',
        sub: meta.description || '',
        cycles: isCycleTarget(node.nodeId),
        model: node.model || '',
        effort: node.effort || '',
      };
    }),
  }));

  return {
    version: 1,
    steps: [
      { kind: 'preflight', nodes: [{ id: 'preflight', label: 'Preflight', sub: 'checks' }] },
      ...agentCells,
      { kind: 'done', nodes: [{ id: 'done', label: 'Done', sub: 'complete' }] },
    ],
  };
}
