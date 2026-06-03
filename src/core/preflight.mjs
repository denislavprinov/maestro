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
 * Detect graphify and HOW it is installed. Returns:
 *   { found: boolean, kind: 'cli'|'skill'|'output-cached'|null }
 *
 * The `kind` controls the instruction wording so the agent picks the right
 * dispatch mechanism (Bash CLI vs Skill tool vs read cached output). Priority:
 *   1. `which graphify`            → 'cli'   (executable on PATH)
 *   2. pipx / pip shows graphify   → 'cli'   (importable / on PATH soon)
 *   3. ~/.claude/skills/graphify/  → 'skill' (Claude Code skill, no binary)
 *   4. <projectDir>/graphify-out   → 'output-cached' (graph exists from prior run)
 *
 * Ordering matters: a host with both a CLI and a skill prefers the CLI because
 * an agent can drive it directly. An `output-cached` win is the weakest — it
 * means a graph exists but we don't know how it was built.
 */
async function detectGraphify(projectDir) {
  if (await whichOk('graphify')) return { found: true, kind: 'cli' };
  if (await pipxMentions('graphify')) return { found: true, kind: 'cli' };
  if (await pipShows('graphify')) return { found: true, kind: 'cli' };
  if (await pathExists(join(homedir(), '.claude', 'skills', 'graphify', 'SKILL.md'))) {
    return { found: true, kind: 'skill' };
  }
  if (await pathExists(join(projectDir, 'graphify-out'))) {
    return { found: true, kind: 'output-cached' };
  }
  return { found: false, kind: null };
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
 * The wording is branched by `kind` so the agent uses the right dispatch
 * mechanism (Bash CLI, Skill tool, or simply reading cached output).
 */
export function buildInstruction(tool, kind) {
  if (tool === 'graphify') {
    if (kind === 'skill') {
      return (
        'A code knowledge-graph SKILL named "graphify" is available. It is a ' +
        'Claude Code skill, NOT a shell command — do NOT try to run it via Bash. ' +
        'BEFORE analyzing or planning, invoke it via the `Skill` tool, e.g. ' +
        '`Skill(skill: "graphify", args: "<your question about the code>")`. ' +
        'Use its output to ground your work in real codebase structure rather ' +
        'than assumptions. A cached graph may already exist at ' +
        'graphify-out/ — consult it if present.'
      );
    }
    if (kind === 'output-cached') {
      return (
        'A graphify knowledge graph has ALREADY been built for this project at ' +
        'graphify-out/. No graphify binary or Skill was detected, so ' +
        'do NOT try to invoke or rebuild it — just READ the cached output. BEFORE ' +
        'analyzing or planning, read graphify-out/GRAPH_REPORT.md for the overview, ' +
        'then open graphify-out/graph.json to trace specific symbols and their ' +
        'edges, so your understanding is grounded in real structure rather than ' +
        'assumptions.'
      );
    }
    // 'cli' (or unspecified, treated as CLI for safety).
    // `graphify query` does literal token-matching to pick BFS start nodes, so a
    // natural-language PHRASE matches almost nothing (only stray tokens, often in
    // test files) and yields noise — which makes agents give up and fall back to
    // grep. The instruction therefore teaches one-concept-at-a-time querying and
    // points at the already-built graph instead of a nonexistent build command.
    return (
      'A code knowledge-graph CLI named "graphify" is available on PATH, and a ' +
      'graph has ALREADY been built at graphify-out/ (do NOT rebuild). ' +
      'BEFORE analyzing or planning, ground yourself in the real codebase: first ' +
      'read graphify-out/GRAPH_REPORT.md for the overview, then query the graph ' +
      'via Bash. Query ONE concept at a time — a single symbol or term, NOT a ' +
      'natural-language phrase (phrases match almost nothing and return noise). ' +
      'Useful commands:\n' +
      '  graphify query "<concept>"    # BFS neighborhood of one term, e.g. "effort"\n' +
      '  graphify explain "<symbol>"   # one node plus its direct connections\n' +
      '  graphify path "<A>" "<B>"     # how two symbols are connected\n' +
      'Run several single-concept queries rather than one long one. Use ' +
      'Glob/Grep/Read only for what the graph cannot answer.'
    );
  }
  if (tool === 'code-review-graph') {
    return (
      'A code-analysis CLI named "code-review-graph" is available in this ' +
      'environment. Run it via Bash to build a graph of the codebase and inform ' +
      'your analysis, planning, and review with its output rather than relying ' +
      'on assumptions about code structure.'
    );
  }
  return '';
}

/**
 * Detect optional tooling for a project directory.
 * @param {string} projectDir
 * @returns {Promise<{
 *   graphify:boolean,
 *   codeReviewGraph:boolean,
 *   tool:('graphify'|'code-review-graph'|null),
 *   kind:('cli'|'skill'|'output-cached'|null),
 *   instruction:string,
 * }>}
 */
export async function detectTools(projectDir) {
  const dir = projectDir || process.cwd();
  let graphifyInfo = { found: false, kind: null };
  let codeReviewGraph = false;
  try {
    [graphifyInfo, codeReviewGraph] = await Promise.all([
      detectGraphify(dir),
      detectCodeReviewGraph(dir),
    ]);
  } catch {
    // Absolute belt-and-suspenders: detection must never throw.
    graphifyInfo = { found: false, kind: null };
    codeReviewGraph = false;
  }
  // BOTH installed => prefer graphify.
  const tool = graphifyInfo.found ? 'graphify' : codeReviewGraph ? 'code-review-graph' : null;
  const kind = tool === 'graphify' ? graphifyInfo.kind : tool === 'code-review-graph' ? 'cli' : null;
  return {
    graphify: graphifyInfo.found,
    codeReviewGraph,
    tool,
    kind,
    instruction: buildInstruction(tool, kind),
  };
}
