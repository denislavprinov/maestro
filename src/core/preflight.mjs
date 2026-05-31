// src/core/preflight.mjs
// Detect optional knowledge-graph tooling in the user's environment so agents
// can be told to use it. Two tools are supported:
//   - graphify              (github.com/safishamsi/graphify)
//   - code-review-graph     (github.com/tirth8205/code-review-graph)
//
// Rule: if BOTH are present, prefer graphify.
//
// Every probe is wrapped so that a missing binary, missing file, or failing
// subprocess resolves to `false` and NEVER throws.

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { constants as FS } from 'node:fs';

/**
 * Run a command and resolve to its trimmed stdout, or null on any failure.
 * Times out defensively so a hung probe can't block preflight.
 */
function execSafe(cmd, args, { timeout = 4000 } = {}) {
  return new Promise((resolveP) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolveP(null);
      return;
    }
    let out = '';
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP(val);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      done(null);
    }, timeout);

    child.stdout?.on('data', (d) => {
      out += d.toString();
    });
    // Drain stderr so the child can't block on a full pipe.
    child.stderr?.on('data', () => {});
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 ? out.trim() : null));
  });
}

/** True if `which <name>` resolves to a path. */
async function whichOk(name) {
  const out = await execSafe('which', [name]);
  return typeof out === 'string' && out.length > 0;
}

/** True if a filesystem path is accessible. */
async function pathExists(p) {
  try {
    await access(p, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** True if `pipx list` output mentions `needle` (case-insensitive). */
async function pipxMentions(needle) {
  const out = await execSafe('pipx', ['list']);
  return !!out && out.toLowerCase().includes(needle.toLowerCase());
}

/** True if `pip show <pkg>` (or pip3) reports an installed package. */
async function pipShows(pkg) {
  for (const pip of ['pip', 'pip3']) {
    const out = await execSafe(pip, ['show', pkg]);
    if (out && out.toLowerCase().includes('name:')) return true;
  }
  return false;
}

/**
 * Detect graphify. ANY of:
 *  - `which graphify`
 *  - ~/.claude/skills/graphify/SKILL.md exists
 *  - <projectDir>/graphify-out exists
 *  - pipx list / pip show graphify mentions graphify
 */
async function detectGraphify(projectDir) {
  const checks = await Promise.all([
    whichOk('graphify'),
    pathExists(join(homedir(), '.claude', 'skills', 'graphify', 'SKILL.md')),
    pathExists(join(projectDir, 'graphify-out')),
    pipxMentions('graphify'),
    pipShows('graphify'),
  ]);
  return checks.some(Boolean);
}

/**
 * Detect code-review-graph. ANY of:
 *  - `which code-review-graph`
 *  - pipx list / pip show code-review-graph mentions it
 *  - a cloned dir named code-review-graph reachable (cwd or home)
 */
async function detectCodeReviewGraph(projectDir) {
  const checks = await Promise.all([
    whichOk('code-review-graph'),
    pipxMentions('code-review-graph'),
    pipShows('code-review-graph'),
    pathExists(join(projectDir, 'code-review-graph')),
    pathExists(join(homedir(), 'code-review-graph')),
  ]);
  return checks.some(Boolean);
}

/**
 * Build the human-readable instruction injected into agent system prompts.
 */
function buildInstruction(tool) {
  if (tool === 'graphify') {
    return (
      'A code knowledge-graph tool named "graphify" is available in this ' +
      'environment. Before analyzing or planning, use graphify to build/query a ' +
      'knowledge graph of the relevant code (e.g. run it to produce graphify-out/ ' +
      'and consult it) so your understanding of the codebase is grounded in real ' +
      'structure rather than assumptions.'
    );
  }
  if (tool === 'code-review-graph') {
    return (
      'A code-analysis tool named "code-review-graph" is available in this ' +
      'environment. Use it to build a graph of the codebase and inform your ' +
      'analysis, planning, and review with its output rather than relying on ' +
      'assumptions about code structure.'
    );
  }
  return '';
}

/**
 * Detect optional tooling for a project directory.
 * @param {string} projectDir
 * @returns {Promise<{graphify:boolean, codeReviewGraph:boolean, tool:('graphify'|'code-review-graph'|null), instruction:string}>}
 */
export async function detectTools(projectDir) {
  const dir = projectDir || process.cwd();
  let graphify = false;
  let codeReviewGraph = false;
  try {
    [graphify, codeReviewGraph] = await Promise.all([
      detectGraphify(dir),
      detectCodeReviewGraph(dir),
    ]);
  } catch {
    // Absolute belt-and-suspenders: detection must never throw.
    graphify = false;
    codeReviewGraph = false;
  }
  // BOTH installed => prefer graphify.
  const tool = graphify ? 'graphify' : codeReviewGraph ? 'code-review-graph' : null;
  return {
    graphify,
    codeReviewGraph,
    tool,
    instruction: buildInstruction(tool),
  };
}
