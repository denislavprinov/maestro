// src/core/config.mjs
// Per-project model + effort selection for each AGENT step of the pipeline.
// Persisted as JSON at <projectDir>/.maestro/config.json. Reads never throw
// (missing/corrupt => safe defaults); writes are atomic-ish (temp + rename).
//
// Agent steps are keyed by their orchestrator role name:
//   planner | refiner | implementer | reviewer
// (preflight and done are not agents, so they carry no model/effort.)
//
// NOTE: This per-project <projectDir>/.maestro is intentionally distinct from
// the global ~/.maestro/projects.json registry owned by src/core/projects.mjs.

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadAgentRegistry, registryToSteps } from './agent-registry.mjs';

/**
 * The agent steps, in pipeline order — now DERIVED from the agent registry
 * (agents/*.meta.json) rather than hardcoded, so adding an agent needs no edit
 * here. The original four roles keep their legacy short labels via
 * registryToSteps's LEGACY_LABELS, so this stays byte-identical for them while
 * also surfacing the two new agents. Drives the UI + orchestrator + per-step
 * config keys (STEP_KEYS, sanitizeSteps, resolveStepModels all read this).
 */
export const AGENT_STEPS = registryToSteps(loadAgentRegistry());

const STEP_KEYS = new Set(AGENT_STEPS.map((s) => s.key));

/** All effort levels the UI can offer (ordering is not a ranking). */
export const EFFORTS = ['medium', 'high', 'xhigh', 'max'];

/**
 * Built-in models. `efforts` is the subset of EFFORTS each model supports.
 * `xhigh` is listed only on models that support it; medium/high/max are broad.
 *
 * IMPORTANT: these ids are the aliases the installed `claude` CLI is expected to
 * accept. Verify them against your CLI (see "How success is verified"). The
 * canonical dated id for Haiku 4.5 is `claude-haiku-4-5-20251001`; the bare
 * alias `claude-haiku-4-5` is used here and must be confirmed to resolve. Any id
 * that does not resolve can be replaced here or added as a custom model.
 *
 * The `[1m]` suffix selects the 1M-token long-context variant. Opus 4.6–4.8 and
 * Sonnet 4.6 1M ids were verified to resolve via `claude --model`; Haiku 4.5 1M
 * is intentionally omitted — the CLI rejects it ("long context beta is not yet
 * available for this subscription").
 */
export const PREDEFINED_MODELS = [
  { id: 'claude-opus-4-8',        label: 'Opus 4.8',        efforts: ['medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-opus-4-8[1m]',    label: 'Opus 4.8 (1M)',   efforts: ['medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-opus-4-7',        label: 'Opus 4.7',        efforts: ['medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-opus-4-7[1m]',    label: 'Opus 4.7 (1M)',   efforts: ['medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-opus-4-6',        label: 'Opus 4.6',        efforts: ['medium', 'high', 'max'] },
  { id: 'claude-opus-4-6[1m]',    label: 'Opus 4.6 (1M)',   efforts: ['medium', 'high', 'max'] },
  { id: 'claude-sonnet-4-6',      label: 'Sonnet 4.6',      efforts: ['medium', 'high', 'max'] },
  { id: 'claude-sonnet-4-6[1m]',  label: 'Sonnet 4.6 (1M)', efforts: ['medium', 'high', 'max'] },
  { id: 'claude-haiku-4-5',       label: 'Haiku 4.5',       efforts: ['medium', 'high'] },
];

/** Absolute path to <projectDir>/.maestro . */
export function configDir(projectDir) {
  return join(resolve(projectDir), '.maestro');
}

/** Absolute path to the per-project config file. */
export function configFile(projectDir) {
  return join(configDir(projectDir), 'config.json');
}

function defaultConfig() {
  return { steps: {}, customModels: [] };
}

/** Keep only known step keys carrying a non-empty model and/or effort string. */
function sanitizeSteps(steps) {
  const out = {};
  for (const [k, v] of Object.entries(steps || {})) {
    if (!STEP_KEYS.has(k) || !v || typeof v !== 'object') continue;
    const model = typeof v.model === 'string' ? v.model.trim() : '';
    const effort = typeof v.effort === 'string' ? v.effort.trim() : '';
    if (model || effort) out[k] = { ...(model && { model }), ...(effort && { effort }) };
  }
  return out;
}

/** Keep well-formed, de-duplicated custom models that don't shadow a predefined id. */
function sanitizeCustom(list) {
  const seen = new Set(PREDEFINED_MODELS.map((m) => m.id.toLowerCase()));
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || typeof e !== 'object') continue;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    out.push({ id, label: (typeof e.label === 'string' && e.label.trim()) || id });
  }
  return out;
}

/** Read + sanitize the config. Missing/corrupt => { steps:{}, customModels:[] }. */
async function readRaw(projectDir) {
  try {
    const data = JSON.parse(await readFile(configFile(projectDir), 'utf8'));
    if (!data || typeof data !== 'object') return defaultConfig();
    return { steps: sanitizeSteps(data.steps), customModels: sanitizeCustom(data.customModels) };
  } catch {
    return defaultConfig();
  }
}

/** Atomically write the legacy {steps,customModels} view WITHOUT dropping the
 *  run-config layer (workflows/activeWorkflowId) or other top-level keys (e.g.
 *  webUiTesting) that this sanitized view does not model. */
async function writeRaw(projectDir, cfg) {
  await mkdir(configDir(projectDir), { recursive: true });
  const file = configFile(projectDir);
  const existing = await readWholeFile(projectDir);            // preserve unknown keys
  const merged = { ...existing, steps: cfg.steps, customModels: cfg.customModels };
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

/** Public read. */
export async function readConfig(projectDir) {
  return readRaw(projectDir);
}

/**
 * All selectable models = predefined + this project's custom models.
 * Custom models advertise the full effort set (their support is unknown — the
 * user added the raw id and is responsible for it).
 */
export async function listModels(projectDir) {
  const { customModels } = await readRaw(projectDir);
  const predefined = PREDEFINED_MODELS.map((m) => ({ ...m, custom: false }));
  const custom = customModels.map((m) => ({ id: m.id, label: m.label, efforts: [...EFFORTS], custom: true }));
  return [...predefined, ...custom];
}

/**
 * Set (or clear) the model + effort for one agent step. An empty model means
 * "inherit the global/CLI default"; an empty effort means "model default".
 * Effort must be supported by the chosen model.
 * @returns {Promise<{steps:object, customModels:Array}>} the updated config
 */
export async function setStep(projectDir, step, selection = {}) {
  if (!STEP_KEYS.has(step)) throw new Error(`unknown step "${step}"`);
  const model = typeof selection.model === 'string' ? selection.model.trim() : '';
  const effort = typeof selection.effort === 'string' ? selection.effort.trim() : '';

  const models = await listModels(projectDir);
  const entry = model ? models.find((m) => m.id === model) : null;
  if (model && !entry) throw new Error(`unknown model "${model}"`);
  if (effort) {
    if (!EFFORTS.includes(effort)) throw new Error(`unknown effort "${effort}"`);
    if (!entry) throw new Error('select a model before choosing an effort');
    if (!entry.efforts.includes(effort)) {
      throw new Error(`model "${model}" does not support effort "${effort}"`);
    }
  }

  const cfg = await readRaw(projectDir);
  const steps = { ...cfg.steps };
  if (!model && !effort) delete steps[step];
  else steps[step] = { ...(model && { model }), ...(effort && { effort }) };

  const updated = { ...cfg, steps };
  await writeRaw(projectDir, updated);
  return updated;
}

/** Add a custom model by raw id (optional label). Rejects empties + duplicates. */
export async function addCustomModel(projectDir, input = {}) {
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!id) throw new Error('model id is required');
  if (PREDEFINED_MODELS.some((m) => m.id.toLowerCase() === id.toLowerCase())) {
    throw new Error(`"${id}" is already a predefined model`);
  }
  const cfg = await readRaw(projectDir);
  if (cfg.customModels.some((m) => m.id.toLowerCase() === id.toLowerCase())) {
    throw new Error(`a model with id "${id}" already exists`);
  }
  const label = (typeof input.label === 'string' && input.label.trim()) || id;
  const updated = { ...cfg, customModels: [...cfg.customModels, { id, label }] };
  await writeRaw(projectDir, updated);
  return updated;
}

/** Remove a custom model (case-insensitive) and clear any step referencing it. */
export async function removeCustomModel(projectDir, id) {
  const key = (typeof id === 'string' ? id : '').trim().toLowerCase();
  const cfg = await readRaw(projectDir);
  const customModels = cfg.customModels.filter((m) => m.id.toLowerCase() !== key);
  const steps = {};
  for (const [k, v] of Object.entries(cfg.steps)) {
    if (v?.model && v.model.toLowerCase() === key) continue; // drop dangling reference
    steps[k] = v;
  }
  const updated = { ...cfg, customModels, steps };
  // Persist if EITHER the model list OR a referencing step changed.
  const stepsChanged = Object.keys(steps).length !== Object.keys(cfg.steps).length;
  if (customModels.length !== cfg.customModels.length || stepsChanged) {
    await writeRaw(projectDir, updated);
  }
  return updated;
}

/**
 * Resolve the effective per-role { model, effort } for a run. A role with no
 * configured model inherits `fallbackModel` (the global --model). Effort has no
 * global fallback (it didn't exist before), so it is undefined when unset.
 * @returns {Promise<Record<string,{model:(string|undefined),effort:(string|undefined)}>>}
 */
export async function resolveStepModels(projectDir, fallbackModel) {
  const cfg = await readRaw(projectDir);
  const out = {};
  for (const { key } of AGENT_STEPS) {
    const sel = cfg.steps[key] || {};
    out[key] = { model: sel.model || fallbackModel || undefined, effort: sel.effort || undefined };
  }
  return out;
}

// ── run-config: per-project model/effort/cycles for composed workflows ─────────
// Layered ON TOP of the legacy { steps, customModels } config in the SAME file.
// readRaw()/writeRaw() above intentionally drop unknown keys, so these helpers
// read and write the file directly to preserve `workflows` + `activeWorkflowId`
// alongside the sanitized legacy keys.

/** Read the whole config file untouched. Missing/corrupt => {}. Never throws. */
async function readWholeFile(projectDir) {
  try {
    const data = JSON.parse(await readFile(configFile(projectDir), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/** Atomically persist the whole config object. Creates <projectDir>/.maestro. */
async function writeWholeFile(projectDir, obj) {
  await mkdir(configDir(projectDir), { recursive: true });
  const file = configFile(projectDir);
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

/** Coerce a per-node selection to a clean {model?,effort?} or null (both blank). */
function cleanNodeSel(selection) {
  const model = typeof selection?.model === 'string' ? selection.model.trim() : '';
  const effort = typeof selection?.effort === 'string' ? selection.effort.trim() : '';
  if (!model && !effort) return null;
  return { ...(model && { model }), ...(effort && { effort }) };
}

/**
 * Read the full RunConfig: the sanitized legacy view (steps/customModels) plus
 * the run-config layer (workflows + activeWorkflowId). Missing => empty layer.
 * Never throws.
 * @param {string} projectDir
 * @returns {Promise<{steps:object,customModels:Array,workflows:object,activeWorkflowId?:string}>}
 */
export async function readRunConfig(projectDir) {
  const legacy = await readRaw(projectDir); // sanitized { steps, customModels }
  const whole = await readWholeFile(projectDir);
  const workflows =
    whole.workflows && typeof whole.workflows === 'object' ? whole.workflows : {};
  const out = { ...legacy, workflows };
  if (whole.webUiTesting && typeof whole.webUiTesting === 'object') out.webUiTesting = whole.webUiTesting;
  if (typeof whole.activeWorkflowId === 'string' && whole.activeWorkflowId.trim()) {
    out.activeWorkflowId = whole.activeWorkflowId.trim();
  }
  return out;
}

/** Get (creating as needed) the nested workflows[id] bucket on a raw config obj. */
function bucket(whole, workflowId) {
  if (!whole.workflows || typeof whole.workflows !== 'object') whole.workflows = {};
  if (!whole.workflows[workflowId] || typeof whole.workflows[workflowId] !== 'object') {
    whole.workflows[workflowId] = {};
  }
  const wf = whole.workflows[workflowId];
  if (!wf.nodes || typeof wf.nodes !== 'object') wf.nodes = {};
  if (!wf.feedbacks || typeof wf.feedbacks !== 'object') wf.feedbacks = {};
  return wf;
}

/**
 * Set (or clear) the model+effort for one node instance of a workflow. Both
 * blank => the node entry is removed. Writes preserve all other config keys.
 * @param {string} projectDir
 * @param {string} workflowId
 * @param {string} nodeId
 * @param {{model?:string,effort?:string}} selection
 * @returns {Promise<void>}
 */
export async function setNodeModel(projectDir, workflowId, nodeId, selection = {}) {
  const whole = await readWholeFile(projectDir);
  const wf = bucket(whole, workflowId);
  const sel = cleanNodeSel(selection);
  if (sel) wf.nodes[nodeId] = sel;
  else delete wf.nodes[nodeId];
  await writeWholeFile(projectDir, whole);
}

/**
 * Set the cycle count for one feedback loop of a workflow. Coerced to an integer
 * >= 1 (a loop runs at least once). Preserves all other config keys.
 * @param {string} projectDir
 * @param {string} workflowId
 * @param {string} fbId
 * @param {number} maxCycles
 * @returns {Promise<void>}
 */
export async function setFeedbackCycles(projectDir, workflowId, fbId, maxCycles) {
  const n = Math.max(1, Math.floor(Number(maxCycles) || 0) || 1);
  const whole = await readWholeFile(projectDir);
  const wf = bucket(whole, workflowId);
  wf.feedbacks[fbId] = { maxCycles: n };
  await writeWholeFile(projectDir, whole);
}

/**
 * Remember the last workflow selected in New Pipeline. Preserves other keys.
 * @param {string} projectDir
 * @param {string} workflowId
 * @returns {Promise<void>}
 */
export async function setActiveWorkflow(projectDir, workflowId) {
  const whole = await readWholeFile(projectDir);
  whole.activeWorkflowId = String(workflowId || '').trim();
  await writeWholeFile(projectDir, whole);
}

/**
 * Resolve just the run-config for one workflow into { nodes, feedbacks } maps
 * (the inputs resolveWorkflow overlays on the template). Unconfigured => empties.
 * @param {string} projectDir
 * @param {string} workflowId
 * @returns {Promise<{nodes:Record<string,{model?:string,effort?:string}>,feedbacks:Record<string,{maxCycles:number}>}>}
 */
export async function resolveRunConfig(projectDir, workflowId) {
  const rc = await readRunConfig(projectDir);
  const wf = rc.workflows[workflowId] || {};
  return {
    nodes: wf.nodes && typeof wf.nodes === 'object' ? wf.nodes : {},
    feedbacks: wf.feedbacks && typeof wf.feedbacks === 'object' ? wf.feedbacks : {},
  };
}
