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
import { mkdir, rm, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { slugify } from './artifacts.mjs';

const WORKTREES_DIRNAME = join('.maestro', 'worktrees');
const BRANCH_PREFIX = 'maestro/';
const MAX_BRANCH_LEN = 80;
// Keep branch names short and readable: at most this many significant words
// survive into the slug (the shortId is appended after).
const MAX_BRANCH_WORDS = 6;
// Generic filler dropped from a prompt-derived slug so the name carries the
// meaningful nouns, not boilerplate. Articles, prepositions, conjunctions,
// pronouns, and the imperative scaffolding that prefixes most task prompts
// ("build a…", "let's create…"). Deliberately conservative — domain verbs like
// add/fix/refactor are kept because they carry intent.
const BRANCH_STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'into', 'with',
  'at', 'by', 'from', 'we', 'i', 'you', 'it', 'that', 'this', 'these', 'those',
  'lets', 'let', 'please', 'just', 'also', 'should', 'would', 'could', 'can',
  'will', 'want', 'wants', 'need', 'needs', 'make', 'build', 'create', 'some',
  'our', 'my',
]);

// Checkout-heavy ops (worktree add/remove) legitimately exceed the default
// 30 s on large repos — give them a longer leash before the SIGKILL deadline.
const SLOW_GIT_TIMEOUT_MS = 120_000;

/** Run git and resolve to { ok, stdout, stderr, code }. Never throws. */
function git(cwd, args, { signal, timeout = 30_000 } = {}) {
  return new Promise((res) => {
    let child;
    try {
      child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal });
    } catch (err) {
      res({ ok: false, stdout: '', stderr: err.message, code: -1 });
      return;
    }
    let stdout = '', stderr = '';
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res(val);
    };
    const timer = timeout > 0
      ? setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
          done({ ok: false, stdout, stderr: stderr ? `git timed out: ${stderr}` : 'git timed out', code: -1 });
        }, timeout)
      : null;
    child.stdout?.on('data', (b) => (stdout += b.toString()));
    child.stderr?.on('data', (b) => (stderr += b.toString()));
    child.on('error', (err) => done({ ok: false, stdout, stderr: stderr || err.message, code: -1 }));
    child.on('close', (code) => done({ ok: code === 0, stdout, stderr, code: code ?? -1 }));
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
 * Reduce free text to a short, meaningful kebab slug: slugify, drop generic
 * stopwords, keep the first MAX_BRANCH_WORDS significant words. If stopword
 * removal would empty the slug (every word was filler), keep the raw words so
 * we never return nothing. Returns '' only for empty/punctuation-only input.
 */
function keywordSlug(text) {
  const line = firstLine(text);
  if (!line) return ''; // slugify('') yields 'untitled'; let the caller pick 'feature'
  const words = slugify(line).split('-').filter(Boolean);
  if (!words.length) return '';
  const kept = words.filter((w) => !BRANCH_STOPWORDS.has(w));
  return (kept.length ? kept : words).slice(0, MAX_BRANCH_WORDS).join('-');
}

/**
 * Propose a feature branch name WITHOUT an LLM (so preflight stays free and
 * fully deterministic). Title-first: a caller-supplied title is the clearest
 * intent, so slugify it directly; otherwise derive a keyword slug from the
 * prompt's first line. Always returns a sanitized "<prefix><slug>-<shortId>".
 */
export function suggestBranchName({ prompt, title, pipelineId } = {}) {
  const shortId = String(pipelineId || '').slice(0, 8) || 'run';
  // A title is explicit intent — slugify it verbatim (only word-cap for length),
  // never strip stopwords (would mangle deliberate names like "A/B Testing").
  const fromTitle = title
    ? slugify(title).split('-').filter(Boolean).slice(0, MAX_BRANCH_WORDS).join('-')
    : '';
  const core = fromTitle || keywordSlug(prompt) || 'feature';
  return sanitizeBranchName(`${BRANCH_PREFIX}${core}-${shortId}`);
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
 * then origin/HEAD, then first local branch. On a detached HEAD with no local
 * branches, fall back to the HEAD SHA (always a valid commit-ish for
 * `worktree add`) and only then to the literal 'main' (m1).
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
  if (branches.length) return branches.sort()[0];
  // Detached HEAD, no branches: a raw SHA is a valid source for `worktree add`.
  const sha = await git(projectDir, ['rev-parse', 'HEAD']);
  if (sha.ok && sha.stdout.trim()) return sha.stdout.trim();
  return 'main';
}

/**
 * True iff `ref` resolves to a commit in `projectDir`. Rejects any value
 * beginning with '-' (would be parsed as a git option). The single source of
 * truth for "is this a usable worktree source" — used both by createWorktree
 * (throws) and the API (clean 400) so an injected `--force`/`-q`/unknown ref
 * never reaches `git worktree add`. (M1)
 */
export async function isValidSourceRef(projectDir, ref) {
  if (typeof ref !== 'string' || !ref || /^-/.test(ref)) return false;
  const r = await git(projectDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.ok && !!r.stdout.trim();
}

/**
 * Parse `git worktree list --porcelain` and return the path of the worktree
 * that currently has `branch` checked out, or null. Used to detect the
 * "branch already in use" conflict before a reuse `worktree add` (M2).
 */
export async function worktreePathForBranch(projectDir, branch) {
  const r = await git(projectDir, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return null;
  let curPath = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) curPath = line.slice('worktree '.length).trim();
    else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      if (ref === branch) return curPath;
    }
  }
  return null;
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
  // S2: pipelineId becomes a path segment and is later passed to a recursive
  // remove — reject anything that could escape the worktrees base.
  if (!/^[A-Za-z0-9._-]+$/.test(pipelineId) || pipelineId === '.' || pipelineId === '..') {
    throw new Error(`invalid pipelineId: ${JSON.stringify(pipelineId)}`);
  }
  const branch = sanitizeBranchName(featureBranch);
  if (!branch) throw new Error('featureBranch resolves to empty after sanitize');
  // Compare sanitized forms so case/format variants of the same name don't slip past.
  if (branch === sanitizeBranchName(sourceBranch)) {
    throw new Error(`featureBranch and sourceBranch both resolve to "${branch}" — they must differ`);
  }

  const base = join(resolve(projectDir), WORKTREES_DIRNAME);
  await mkdir(base, { recursive: true });
  // Canonicalize the base so worktreeDir matches what `git worktree list`
  // reports (git emits realpaths). Without this the M2 self-equality check below
  // mis-fires on symlinked roots (e.g. macOS /tmp -> /private/tmp).
  const baseReal = await realpath(base).catch(() => resolve(base));
  const worktreeDir = join(baseReal, pipelineId);
  // Belt-and-braces: the sanitized id can't traverse, but assert containment
  // so a future caller can't turn this into a delete-anything primitive.
  if (!worktreeDir.startsWith(baseReal + sep)) {
    throw new Error(`worktree path escapes base: ${worktreeDir}`);
  }

  const branches = await listLocalBranches(projectDir);
  const reusedExisting = branches.includes(branch);

  let args;
  if (reusedExisting) {
    // M2: git forbids checking out one branch in two worktrees at once. Reap
    // stale registrations first; if a *live* worktree still holds it, fail with
    // an actionable message rather than a raw exit-128 mid-pipeline.
    await git(projectDir, ['worktree', 'prune']);
    const inUse = await worktreePathForBranch(projectDir, branch);
    if (inUse && resolve(inUse) !== resolve(worktreeDir)) {
      throw new Error(`branch "${branch}" is already checked out in worktree ${inUse}`);
    }
    args = ['worktree', 'add', '--', worktreeDir, branch];
  } else {
    // M1: validate the source resolves to a real commit (rejects leading-dash
    // option injection and unknown refs); '--' stops git parsing the trailing
    // positionals as options as a second line of defense.
    if (!(await isValidSourceRef(projectDir, sourceBranch))) {
      throw new Error(`sourceBranch is not a valid ref: ${JSON.stringify(sourceBranch)}`);
    }
    args = ['worktree', 'add', '-b', branch, '--', worktreeDir, sourceBranch];
  }
  const r = await git(projectDir, args, { signal, timeout: SLOW_GIT_TIMEOUT_MS });
  if (!r.ok) {
    throw new Error(`git worktree add failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }
  return { worktreeDir, branch, sourceBranch, reusedExisting };
}

/**
 * Remove a worktree dir + (optionally) its branch. Returns
 * { ok, steps: [{ step, ok, stderr }] } so callers can log/assert — failures are
 * never silently swallowed (M3).
 *
 * IMPORTANT: the non-force path only succeeds on a *pristine* checkout — git
 * refuses to remove a worktree with modified/untracked files. Agents always
 * edit files, so teardown of an agent-run worktree MUST pass force:true or it
 * leaks. With force:true the dir is also removed directly as a backstop, and
 * the registration is pruned so a later reuse of the branch won't trip M2.
 */
export async function removeWorktree({ projectDir, worktreeDir, branch, force = false } = {}) {
  const steps = [];
  if (worktreeDir) {
    const args = force
      ? ['worktree', 'remove', '--force', worktreeDir]
      : ['worktree', 'remove', worktreeDir];
    const r = await git(projectDir, args, { timeout: SLOW_GIT_TIMEOUT_MS });
    steps.push({ step: 'worktree-remove', ok: r.ok, stderr: r.stderr.trim() });
    if (force) {
      const fsRes = await rm(worktreeDir, { recursive: true, force: true })
        .then(() => null)
        .catch((e) => e.message);
      if (fsRes) steps.push({ step: 'rm-dir', ok: false, stderr: fsRes });
    }
    // Reap the (now-missing) registration so it can't collide on reuse.
    await git(projectDir, ['worktree', 'prune']);
  }
  if (branch) {
    const r = await git(projectDir, ['branch', force ? '-D' : '-d', branch]);
    steps.push({ step: 'branch-delete', ok: r.ok, stderr: r.stderr.trim() });
  }
  return { ok: steps.every((s) => s.ok), steps };
}

function firstLine(text) {
  if (!text) return '';
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.replace(/^#+\s*/, '').trim();
    if (t) return t;
  }
  return '';
}
