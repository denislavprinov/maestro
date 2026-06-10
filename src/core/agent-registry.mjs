// src/core/agent-registry.mjs
// Data-driven agent registry. Scans agents/*.meta.json into an in-memory map
// keyed by agent key, sorted by `.order`. This replaces what used to be hardcoded
// across AGENT_FILES (orchestrator.mjs) and AGENT_STEPS (config.mjs): adding an
// agent is now "drop agents/<key>.md + agents/<key>.meta.json", no core edit.
//
// Read synchronously so it can back a synchronous AGENT_STEPS constant in
// config.mjs. Tolerant: a malformed sidecar, or one missing `key`/`order`, is
// skipped rather than throwing (mirrors the tolerant readers elsewhere).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHANNEL_IDS as CHANNEL_ID_LIST } from './channels.mjs'; // single source (m2)
import { maestroHome } from './projects.mjs'; // user agent layer root (read fresh per call)

/** Default location of the agent metadata sidecars, relative to this module. */
const DEFAULT_AGENTS_DIR = new URL('../../agents/', import.meta.url).pathname;

const COLORS = new Set(['green', 'peach', 'red', 'blue', 'violet', 'amber']);
const RUNNER_TYPES = new Set(['producer', 'verifier', 'clarifier']);
const CHANNEL_IDS = new Set(CHANNEL_ID_LIST);

/**
 * Built-in channel/governance spec per agent key. Used when a sidecar omits the
 * fields, so the six shipped agents behave byte-identically to today's _nodeIo
 * switch and every saved pipeline stays connectsTo-legal.
 */
const DEFAULT_SPEC = {
  clarify:              { consumes: ['userPrompt'],                       produces: ['clarify'],         connectsTo: ['planner'] },
  planner:              { consumes: ['userPrompt', 'clarify', 'review'],  optionalConsumes: ['clarify', 'review'], produces: ['plan'], connectsTo: ['refiner', 'implementer', 'planReviewer', 'decomposer'] },
  refiner:              { consumes: ['plan'],              produces: ['plan', 'review'],  connectsTo: ['implementer', 'refiner', 'decomposer'] },
  decomposer:           { consumes: ['plan'],              produces: ['decomposition'],   connectsTo: ['implementer'] },
  implementer:          { consumes: ['plan', 'review'],    optionalConsumes: ['review'],  produces: ['code'], connectsTo: ['reviewer', 'manualTestsChecklist'] },
  reviewer:             { consumes: ['plan', 'code'],      produces: ['review'],          connectsTo: ['implementer', 'manualTestsChecklist'] },
  manualTestsChecklist: { consumes: ['plan', 'code'],      produces: ['checklist'],       connectsTo: ['manualWebUiTesting'] },
  manualWebUiTesting:   { consumes: ['checklist', 'code'], produces: ['review'],          connectsTo: ['implementer'] },
  planReviewer:         { consumes: ['plan'],              produces: ['review'],          connectsTo: ['planner', 'implementer', 'decomposer'] },
  // Workspace agents (scope:'workspace-only', §6.2). The scanner is off-pipeline
  // (connectsTo:[] -> non-composable); the reviewer slots into the code->review->
  // implementer loop exactly like `reviewer`.
  workspaceScanner:     { consumes: ['userPrompt'],        produces: ['workspace'],       connectsTo: [] },
  workspaceReviewer:    { consumes: ['plan', 'code'],      produces: ['review'],          connectsTo: ['implementer'] },
};

/** Array of known channel ids from raw input; warns on (and drops) unknown ids (m1). */
function channelList(raw, key, field) {
  if (!Array.isArray(raw)) return undefined;
  const out = [];
  for (const s of raw) {
    const id = String(s || '').trim();
    if (CHANNEL_IDS.has(id)) out.push(id);
    else if (id) console.warn(`[agent-registry] ${key}.${field}: unknown channel id "${id}" ignored`);
  }
  return out;
}

/** Normalize connectsTo: '*' | string[] of agent keys. Anything else => fallback.
 * A raw value of '*' is treated as "unset" so DEFAULT_SPEC can override it. */
function normalizeConnectsTo(raw, fallback) {
  if (Array.isArray(raw)) {
    const out = raw.map((s) => String(s || '').trim()).filter(Boolean);
    return out.length ? out : (fallback ?? '*');
  }
  // raw === '*' or anything else: use the fallback (spec array or '*')
  return fallback ?? '*';
}

/**
 * Legacy short labels for the original four roles, so the derived AGENT_STEPS is
 * byte-identical to the hardcoded one the UI/orchestrator have always used. New
 * agents fall back to their `displayName`.
 */
const LEGACY_LABELS = {
  planner: 'Plan',
  refiner: 'Refine',
  implementer: 'Implement',
  reviewer: 'Review',
};

/** Coerce one parsed sidecar into a normalized AgentMeta, or null if unusable. */
function normalizeMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  if (!key) return null;
  const order = Number(raw.order);
  if (!Number.isFinite(order)) return null;
  const color = COLORS.has(raw.color) ? raw.color : 'amber';
  const runnerType = RUNNER_TYPES.has(raw.runnerType) ? raw.runnerType : 'producer';
  // §6.6 scope coercion (fail-safe, mirrors color): anything but the explicit
  // 'workspace-only' marker is a normal 'project'-scope agent, so a typo fails
  // safe to a VISIBLE project agent (surfaced by the palette test) rather than a
  // silently-hidden one.
  const scope = raw.scope === 'workspace-only' ? 'workspace-only' : 'project';
  const spec = DEFAULT_SPEC[key] || {};
  const rtFallbackConsumes = runnerType === 'verifier' ? ['code'] : ['userPrompt'];
  const consumes = channelList(raw.consumes, key, 'consumes') || spec.consumes || rtFallbackConsumes;
  const produces = channelList(raw.produces, key, 'produces') || spec.produces || (runnerType === 'verifier' ? ['review'] : []);
  const optionalConsumes = channelList(raw.optionalConsumes, key, 'optionalConsumes') || spec.optionalConsumes || [];
  const connectsTo = normalizeConnectsTo(raw.connectsTo, spec.connectsTo || '*');
  return {
    key,
    displayName: typeof raw.displayName === 'string' && raw.displayName.trim()
      ? raw.displayName.trim()
      : key,
    description: typeof raw.description === 'string' ? raw.description : '',
    color,
    icon: typeof raw.icon === 'string' ? raw.icon : '',
    agentFile: typeof raw.agentFile === 'string' && raw.agentFile.trim() ? raw.agentFile.trim() : null,
    runnerType,
    scope,
    loopSource: !!raw.loopSource,
    fanOut: !!raw.fanOut,
    consumes,
    optionalConsumes,
    produces,
    connectsTo,
    order,
  };
}

/**
 * Directory of USER agents: <maestroHome()>/agents (~/.maestro/agents). Resolved
 * fresh on every call (mirrors maestroHome's read-fresh contract). Returns null
 * when the home cannot be resolved (e.g. under the node:test runner with no
 * MAESTRO_HOME — projects.mjs throws there to protect the real store), so module
 * import and registry loads never throw.
 */
export function userAgentsDir() {
  try { return join(maestroHome(), 'agents'); } catch { return null; }
}

/** Scan one layer dir for *.meta.json; stamps the COMPUTED origin/agentPath fields. */
function scanLayer(dir, origin) {
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return []; // missing layer dir => empty layer (fails safe)
  }
  const metas = [];
  for (const f of files) {
    if (!f.endsWith('.meta.json')) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch {
      continue; // skip unreadable / malformed sidecars
    }
    const meta = normalizeMeta(parsed);
    if (!meta) continue;
    meta.origin = origin;                                              // computed, never stored
    meta.agentPath = meta.agentFile ? join(dir, meta.agentFile) : null; // layer-correct abs path
    metas.push(meta);
  }
  return metas;
}

/**
 * Scan the built-in layer (`agentsDir`) AND the user layer (~/.maestro/agents) and
 * build the merged registry. Built-ins are IMMUTABLE: a user sidecar whose key
 * collides with a built-in is skipped with a warning. Re-scans both layers on
 * every call (no module-level cache), so the registry is always reloadable.
 * @param {string} [agentsDir]   built-in layer (repo agents/)
 * @param {{userAgentsDir?: string|null}} [opts]  user layer override; null disables
 * @returns {Record<string, object>} agent key -> AgentMeta, sorted by `.order`
 */
export function loadAgentRegistry(agentsDir = DEFAULT_AGENTS_DIR, opts = {}) {
  const builtins = scanLayer(agentsDir, 'builtin');
  const builtinKeys = new Set(builtins.map((m) => m.key));
  const userDir = opts.userAgentsDir === undefined ? userAgentsDir() : opts.userAgentsDir;
  const users = [];
  if (userDir) {
    for (const m of scanLayer(userDir, 'user')) {
      if (builtinKeys.has(m.key)) {
        console.warn(
          `[agent-registry] user agent "${m.key}" shadows a built-in and was skipped (built-ins are immutable)`,
        );
        continue;
      }
      users.push(m);
    }
  }
  const metas = [...builtins, ...users].sort((a, b) => a.order - b.order); // stable sort
  const registry = {};
  for (const m of metas) registry[m.key] = m;
  return registry;
}

/**
 * Derive the legacy `[{key,label}]` step list from a registry (replacement source
 * for the hardcoded AGENT_STEPS). The original four roles keep their short legacy
 * labels; any additional agent uses its `displayName`.
 *
 * §6.6/C9: `scope:'workspace-only'` agents are EXCLUDED — they are not part of the
 * single-project UI stepper / per-step config keyspace that AGENT_STEPS drives, so
 * this returns the 9 built-in project-scope steps plus any user-layer project
 * agents (without the exclusion the two workspace sidecars would add 2 more).
 * @param {Record<string, object>} registry
 * @returns {Array<{key:string,label:string,fanOut:boolean}>}
 */
export function registryToSteps(registry) {
  return Object.values(registry || {})
    .filter((m) => m.scope !== 'workspace-only')
    .sort((a, b) => a.order - b.order)
    .map((m) => ({ key: m.key, label: LEGACY_LABELS[m.key] || m.displayName, fanOut: !!m.fanOut }));
}
