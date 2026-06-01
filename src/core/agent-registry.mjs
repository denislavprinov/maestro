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

/** Default location of the agent metadata sidecars, relative to this module. */
const DEFAULT_AGENTS_DIR = new URL('../../agents/', import.meta.url).pathname;

const COLORS = new Set(['green', 'peach', 'red', 'blue', 'violet', 'amber']);
const RUNNER_TYPES = new Set(['producer', 'verifier']);

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
    loopSource: !!raw.loopSource,
    connectsTo: '*', // spec §4.1: only "*" is supported in this scope
    order,
  };
}

/**
 * Scan `agentsDir` for `*.meta.json` and build the registry.
 * @param {string} [agentsDir]
 * @returns {Record<string, object>} agent key -> AgentMeta, sorted by `.order`
 */
export function loadAgentRegistry(agentsDir = DEFAULT_AGENTS_DIR) {
  let files;
  try {
    files = readdirSync(agentsDir);
  } catch {
    return {};
  }
  const metas = [];
  for (const f of files) {
    if (!f.endsWith('.meta.json')) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(agentsDir, f), 'utf8'));
    } catch {
      continue; // skip unreadable / malformed sidecars
    }
    const meta = normalizeMeta(parsed);
    if (meta) metas.push(meta);
  }
  metas.sort((a, b) => a.order - b.order);
  const registry = {};
  for (const m of metas) registry[m.key] = m;
  return registry;
}

/**
 * Derive the legacy `[{key,label}]` step list from a registry (replacement source
 * for the hardcoded AGENT_STEPS). The original four roles keep their short legacy
 * labels; any additional agent uses its `displayName`.
 * @param {Record<string, object>} registry
 * @returns {Array<{key:string,label:string}>}
 */
export function registryToSteps(registry) {
  return Object.values(registry || {})
    .sort((a, b) => a.order - b.order)
    .map((m) => ({ key: m.key, label: LEGACY_LABELS[m.key] || m.displayName }));
}
