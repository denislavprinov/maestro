// src/core/worktree.mjs
// Per-pipeline git worktree isolation. Every helper is async, returns plain data,
// and never throws on missing files / non-zero git exits unless explicitly noted
// (createWorktree throws on a fatal git failure because the run cannot continue).
//
// Layout: <projectDir>/.maestro/worktrees/<pipelineId>/   <- checkout
//         shared .git store stays in <projectDir>/.git    <- no duplication
//
// Branch naming: callers pass a fully-formed feature branch (e.g. "maestro/foo-abc12345")
// OR the orchestrator derives one via suggestBranchName(). sanitizeBranchName is the
// single source of truth for what reaches `git branch`.

import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { slugify } from './artifacts.mjs';
import { runClaude } from './claude-runner.mjs';

const WORKTREES_DIRNAME = join('.maestro', 'worktrees');
const BRANCH_PREFIX = 'maestro/';
const MAX_BRANCH_LEN = 80;
// suggestBranchName trims the prompt before sending it to claude so large
// pasted plans don't balloon the request payload (the suggester only needs the
// gist for a 3-6 word name).
const SUGGEST_PROMPT_BUDGET = 600;

/** Run git and resolve to { ok, stdout, stderr, code }. Never throws. */
function git(cwd, args, { signal } = {}) {
  return new Promise((res) => {
    let child;
    try {
      child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal });
    } catch (err) {
      res({ ok: false, stdout: '', stderr: err.message, code: -1 });
      return;
    }
    let stdout = '', stderr = '';
    child.stdout?.on('data', (b) => (stdout += b.toString()));
    child.stderr?.on('data', (b) => (stderr += b.toString()));
    child.on('error', (err) => res({ ok: false, stdout, stderr: stderr || err.message, code: -1 }));
    child.on('close', (code) => res({ ok: code === 0, stdout, stderr, code: code ?? -1 }));
  });
}

/**
 * Reduce arbitrary text to a git-safe branch name fragment.
 */
export function sanitizeBranchName(raw) {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-/_.]+|[-/_.]+$/g, '');
  return s.slice(0, MAX_BRANCH_LEN);
}

/**
 * Propose a branch name from the prompt. In mock mode (or when claude is
 * unavailable / errors), derive it deterministically from the slug. Always
 * returns a sanitized "<prefix><slug>-<shortId>" string.
 */
export async function suggestBranchName({ prompt, pipelineId, mock = false, projectDir, signal, onEvent } = {}) {
  const shortId = String(pipelineId || '').slice(0, 8) || 'run';
  const fallback = sanitizeBranchName(
    `${BRANCH_PREFIX}${slugify(firstLine(prompt) || 'feature').slice(0, 40)}-${shortId}`,
  );
  if (mock) return fallback;

  const trimmed = String(prompt || '').trim().slice(0, SUGGEST_PROMPT_BUDGET);
  const ask =
    'Suggest a concise kebab-case git branch name (max 6 words, no spaces, ' +
    'no leading slash, no trailing punctuation) for this task. Reply with ONLY ' +
    'the name on a single line, no quotes, no prose:\n\n' + trimmed;
  try {
    const { text } = await runClaude({
      cwd: projectDir || process.cwd(),
      prompt: ask,
      allowedTools: [],
      permissionMode: 'default',
      mock: false,
      signal,
      onEvent,
    });
    const first = (text || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
    const sane = sanitizeBranchName(`${BRANCH_PREFIX}${first}-${shortId}`);
    return sane || fallback;
  } catch {
    return fallback;
  }
}

/** All local branch names (no remotes). Empty array on a non-repo. */
export async function listLocalBranches(projectDir) {
  const r = await git(projectDir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
  if (!r.ok) return [];
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** The branch HEAD currently points to in `projectDir`, or null. */
export async function currentBranch(projectDir) {
  const r = await git(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!r.ok) return null;
  const name = r.stdout.trim();
  return name && name !== 'HEAD' ? name : null;
}

/**
 * Best-effort default-branch resolution. HEAD branch, then init.defaultBranch,
 * then origin/HEAD, then first local branch, finally 'main'.
 */
export async function resolveDefaultBranch(projectDir) {
  const head = await currentBranch(projectDir);
  if (head) return head;
  const cfg = await git(projectDir, ['config', '--get', 'init.defaultBranch']);
  if (cfg.ok && cfg.stdout.trim()) return cfg.stdout.trim();
  const originHead = await git(projectDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead.ok && originHead.stdout.trim()) {
    return originHead.stdout.trim().replace(/^origin\//, '');
  }
  const branches = await listLocalBranches(projectDir);
  return branches.sort()[0] || 'main';
}

/**
 * Create a worktree at <projectDir>/.maestro/worktrees/<pipelineId> checking out
 * a new branch <featureBranch> off <sourceBranch>. When the branch already exists
 * locally we attach to it instead of forking (resume semantics) and set
 * reusedExisting=true.
 */
export async function createWorktree({ projectDir, pipelineId, sourceBranch, featureBranch, signal }) {
  if (!projectDir) throw new Error('projectDir required');
  if (!pipelineId) throw new Error('pipelineId required');
  if (!sourceBranch) throw new Error('sourceBranch required');
  const branch = sanitizeBranchName(featureBranch);
  if (!branch) throw new Error('featureBranch resolves to empty after sanitize');

  const base = join(resolve(projectDir), WORKTREES_DIRNAME);
  await mkdir(base, { recursive: true });
  const worktreeDir = join(base, pipelineId);

  const branches = await listLocalBranches(projectDir);
  const reusedExisting = branches.includes(branch);
  const args = reusedExisting
    ? ['worktree', 'add', worktreeDir, branch]
    : ['worktree', 'add', '-b', branch, worktreeDir, sourceBranch];
  const r = await git(projectDir, args, { signal });
  if (!r.ok) {
    throw new Error(`git worktree add failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }
  return { worktreeDir, branch, sourceBranch, reusedExisting };
}

/**
 * Remove a worktree dir + (optionally) its branch. Best-effort.
 */
export async function removeWorktree({ projectDir, worktreeDir, branch, force = false } = {}) {
  if (worktreeDir) {
    const args = force
      ? ['worktree', 'remove', '--force', worktreeDir]
      : ['worktree', 'remove', worktreeDir];
    await git(projectDir, args);
    if (force) await rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
  }
  if (branch) {
    await git(projectDir, ['branch', force ? '-D' : '-d', branch]);
  }
}

function firstLine(text) {
  if (!text) return '';
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.replace(/^#+\s*/, '').trim();
    if (t) return t;
  }
  return '';
}
