// src/core/git-info.mjs
// Read-only git facts + gh (GitHub CLI) actions that the History UI needs.
// Leaf module: depends only on node:child_process so artifacts.mjs and the UI
// server can both import it without the worktree.mjs <-> artifacts.mjs cycle.
// Every command goes through an injectable runner (_testing.setRunner) so tests
// never shell out to real git/gh/GitHub. Nothing here ever throws.

import { spawn } from 'node:child_process';

/** Default runner: spawn `cmd args` in `cwd`, resolve { ok, stdout, stderr, code }. */
function defaultRun(cmd, args, { cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: err.message, code: -1 });
      return;
    }
    let stdout = '', stderr = '';
    child.stdout?.on('data', (b) => (stdout += b.toString()));
    child.stderr?.on('data', (b) => (stderr += b.toString()));
    child.on('error', (err) => resolve({ ok: false, stdout, stderr: stderr || err.message, code: -1 }));
    child.on('close', (code) => resolve({ ok: code === 0, stdout, stderr, code: code ?? -1 }));
  });
}

let _run = defaultRun;
let _ghCache = null;

/** Parse `git diff --shortstat` output into { added, removed }. */
export function parseShortstat(out) {
  const ins = /(\d+)\s+insertion/.exec(String(out || ''));
  const del = /(\d+)\s+deletion/.exec(String(out || ''));
  return { added: ins ? Number(ins[1]) : 0, removed: del ? Number(del[1]) : 0 };
}

/** Added/removed line counts for source...feature (merge-base/3-dot). 0/0 on any failure. */
export async function diffShortstat(projectDir, source, feature) {
  if (!projectDir || !source || !feature) return { added: 0, removed: 0 };
  const r = await _run('git', ['diff', '--shortstat', `${source}...${feature}`], { cwd: projectDir });
  if (!r.ok) return { added: 0, removed: 0 };
  return parseShortstat(r.stdout);
}

/** True iff `branch` exists locally in `projectDir`. False on a missing repo/branch. */
export async function branchExists(projectDir, branch) {
  if (!projectDir || !branch) return false;
  const r = await _run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: projectDir });
  return r.ok && !!r.stdout.trim();
}

/** True iff the GitHub CLI is on PATH. Memoized (reset via _testing.reset()). */
export async function hasGh() {
  if (_ghCache !== null) return _ghCache;
  const r = await _run('gh', ['--version']);
  _ghCache = r.ok;
  return _ghCache;
}

/** Push the branch and set upstream. Idempotent; surfaces stderr on failure. */
export async function pushBranch(projectDir, branch) {
  const r = await _run('git', ['push', '-u', 'origin', branch], { cwd: projectDir });
  return { ok: r.ok, stderr: (r.stderr || '').trim() };
}

/**
 * Open a PR with `gh pr create`. On "already exists", recover the open PR's URL
 * via `gh pr view` so the button is still useful. Returns { ok, url, existed } |
 * { ok:false, error }.
 */
export async function createPr({ projectDir, base, head, title, body = '' }) {
  const args = ['pr', 'create', '--base', base, '--head', head, '--title', title || head, '--body', body || title || head];
  const r = await _run('gh', args, { cwd: projectDir });
  if (r.ok) {
    // gh prints the PR URL as the last stdout line.
    const url = (r.stdout.trim().split(/\r?\n/).pop() || '').trim();
    return { ok: true, url, existed: false };
  }
  if (/already exists/i.test(r.stderr || '')) {
    const v = await _run('gh', ['pr', 'view', head, '--json', 'url', '-q', '.url'], { cwd: projectDir });
    if (v.ok && v.stdout.trim()) return { ok: true, url: v.stdout.trim(), existed: true };
  }
  return { ok: false, error: (r.stderr || '').trim() || `gh exited ${r.code}` };
}

/** Normalize gh's `mergeable` / `mergeStateStatus` to MERGEABLE | CONFLICTING | UNKNOWN. */
export function normalizeMergeable(raw) {
  const s = String(raw || '').toUpperCase();
  if (s === 'MERGEABLE' || s === 'CLEAN') return 'MERGEABLE';
  if (s === 'CONFLICTING' || s === 'DIRTY') return 'CONFLICTING';
  return 'UNKNOWN';
}

/** Read mergeability for the PR whose head is `head`. UNKNOWN on any failure. */
export async function prMergeable({ projectDir, head }) {
  const r = await _run('gh', ['pr', 'view', head, '--json', 'mergeable', '-q', '.mergeable'], { cwd: projectDir });
  if (!r.ok) return 'UNKNOWN';
  return normalizeMergeable(r.stdout.trim());
}

// Test seam: swap the command runner + clear the gh memo. Mirrors server.mjs#_testing.
export const _testing = {
  setRunner(fn) { _run = typeof fn === 'function' ? fn : defaultRun; _ghCache = null; },
  reset() { _run = defaultRun; _ghCache = null; },
};
