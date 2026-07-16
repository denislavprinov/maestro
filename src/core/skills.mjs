// src/core/skills.mjs
// Declared-skill resolution, validation, and worktree injection.
//
// Maestro agents may declare `requiresSkills: string[]` in their meta sidecar.
// A skill is only reachable by the headless `claude -p` child when it sits on a
// scan path: `<cwd>/.claude/skills/<name>/` or `~/.claude/skills/<name>/`.
// Maestro's own repo `skills/` dir is on NEITHER, so a bundled skill must be
// COPIED into the run's worktree before any node runs. This module:
//   - resolveSkill()          pure: where does a skill live? (bundle|global|project|plugin|none)
//   - collectRequiredSkills() pure: union of requiresSkills across the plan's agents
//   - validateSkills()        gate: throw a structured abort if any are unresolvable
//   - injectSkills()          side-effect: copy bundle- and plugin-sourced skills into worktree(s)

import { existsSync, readdirSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Locate <cacheRoot>/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md.
 *  Read-only readdir probes; each level scanned in sorted order so resolution
 *  is deterministic when a skill name exists in several plugins. */
function findPluginSkillDir(cacheRoot, name) {
  const subdirs = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch { return []; }
  };
  for (const marketplace of subdirs(cacheRoot)) {
    for (const plugin of subdirs(join(cacheRoot, marketplace))) {
      for (const version of subdirs(join(cacheRoot, marketplace, plugin))) {
        const dir = join(cacheRoot, marketplace, plugin, version, 'skills', name);
        if (existsSync(join(dir, 'SKILL.md'))) return dir;
      }
    }
  }
  return null;
}

/**
 * Resolve a skill name to its source, in priority order:
 *   1. bundle  — <repoRoot>/skills/<name>/SKILL.md     (injectSkills copies this into the worktree)
 *   2. global  — <homeDir>/.claude/skills/<name>/SKILL.md   (already on the scan path)
 *   3. project — <projectDir>/.claude/skills/<name>/SKILL.md (committed; already on the scan path)
 *   4. plugin  — <homeDir>/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md
 *                (copied into the worktree like bundle)
 *   5. none    — unresolvable
 * Pure: only existsSync probes, no mutation. `searched` lists every path tried,
 * for actionable error messages.
 * @param {string} name
 * @param {{repoRoot:string, projectDir:string, homeDir?:string}} ctx
 * @returns {{source:'bundle'|'global'|'project'|'plugin'|null, path:string|null, searched:string[]}}
 */
export function resolveSkill(name, { repoRoot, projectDir, homeDir = homedir() }) {
  const bundleDir    = join(repoRoot, 'skills', name);
  const globalDir    = join(homeDir, '.claude', 'skills', name);
  const projSkillDir  = join(projectDir, '.claude', 'skills', name);
  const pluginCache   = join(homeDir, '.claude', 'plugins', 'cache');
  const searched = [
    join(bundleDir, 'SKILL.md'),
    join(globalDir, 'SKILL.md'),
    join(projSkillDir, 'SKILL.md'),
    join(pluginCache, '<marketplace>', '<plugin>', '<version>', 'skills', name, 'SKILL.md'),
  ];
  if (existsSync(searched[0])) return { source: 'bundle',  path: bundleDir,    searched };
  if (existsSync(searched[1])) return { source: 'global',  path: globalDir,    searched };
  if (existsSync(searched[2])) return { source: 'project', path: projSkillDir, searched };
  const pluginDir = findPluginSkillDir(pluginCache, name);
  if (pluginDir) return { source: 'plugin', path: pluginDir, searched };
  return { source: null, path: null, searched };
}

/**
 * Union of `requiresSkills` across the agents that appear in the resolved plan.
 * Returns one entry per distinct skill with the agent keys that require it (for
 * error attribution), sorted by skill name.
 *
 * `registry` is the plain object returned by loadAgentRegistry (keyed by agent
 * key); `plan.steps` is Array<Array<node>> and each node has `.key`.
 * @param {Record<string, {requiresSkills?: string[]}>} registry
 * @param {{steps?: Array<Array<{key:string}>>}} plan
 * @returns {Array<{skill:string, requiredBy:string[]}>}
 */
export function collectRequiredSkills(registry, plan) {
  const nodeKeys = new Set();
  for (const group of plan?.steps || []) for (const node of group) nodeKeys.add(node.key);
  /** @type {Map<string, Set<string>>} */
  const bySkill = new Map();
  for (const key of nodeKeys) {
    for (const skill of registry?.[key]?.requiresSkills || []) {
      if (!bySkill.has(skill)) bySkill.set(skill, new Set());
      bySkill.get(skill).add(key);
    }
  }
  return [...bySkill.keys()].sort().map((skill) => ({
    skill,
    requiredBy: [...bySkill.get(skill)].sort(),
  }));
}

/**
 * Preflight gate. Resolve every required skill; if ANY is unresolvable, throw a
 * single aggregated error naming each (requiring agent(s), skill, searched paths)
 * so the user fixes them all at once. On success, return the resolutions keyed by
 * skill (consumed by injectSkills). Throws BEFORE any node runs; the thrown plain
 * Error lands in run()'s error branch → run ends with status 'error', message
 * surfaced.
 * @param {Array<{skill:string, requiredBy:string[]}>} required
 * @param {{repoRoot:string, projectDir:string, homeDir?:string}} ctx
 * @returns {Map<string, {source:string, path:string, requiredBy:string[]}>}
 */
export function validateSkills(required, ctx) {
  const resolved = new Map();
  const missing = [];
  for (const { skill, requiredBy } of required) {
    const r = resolveSkill(skill, ctx);
    if (r.source === null) missing.push({ skill, requiredBy, searched: r.searched });
    else resolved.set(skill, { source: r.source, path: r.path, requiredBy });
  }
  if (missing.length) {
    const lines = missing.map(
      (m) =>
        `  - skill "${m.skill}" (required by ${m.requiredBy.join(', ')}) not found. Searched:\n` +
        m.searched.map((p) => `      ${p}`).join('\n'),
    );
    throw new Error(
      `Preflight failed: ${missing.length} required skill(s) unavailable. ` +
        `Bundle them in the maestro repo (skills/<name>/) or install under ~/.claude/skills/:\n` +
        lines.join('\n'),
    );
  }
  return resolved;
}

/**
 * Copy each BUNDLE- or PLUGIN-sourced skill into every given worktree's
 * .claude/skills/ (global/project skills are already on the scan path —
 * nothing to copy). Plugin-cache skills, like bundle ones, are not on the
 * headless scan path, so they are copied too. Runs ONLY after validateSkills
 * passes. A copy failure rejects, aborting the run before any node starts (no
 * half-injected skill dir reaches a node).
 *
 * `worktrees` MUST be real isolated checkout dirs (never the main projectDir) —
 * the orchestrator guards this before calling (see §5) so injection cannot
 * pollute the user's working tree.
 * @param {Map<string, {source:string, path:string}>} resolutions
 * @param {{worktrees:string[]}} ctx
 * @returns {Promise<string[]>} skill names actually injected
 */
export async function injectSkills(resolutions, { worktrees }) {
  const injected = [];
  for (const [skill, r] of resolutions) {
    if (r.source !== 'bundle' && r.source !== 'plugin') continue;
    for (const wt of worktrees) {
      await cp(r.path, join(wt, '.claude', 'skills', skill), { recursive: true });
    }
    injected.push(skill);
  }
  return injected;
}
