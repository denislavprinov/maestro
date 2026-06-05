// src/core/pipeline-delete.mjs
// Delete a finished pipeline and everything that belongs to it: its store folder,
// its shared plan/review markdown (linked by name), and its local branch + worktree.
// The remote branch is never touched. Best-effort on git: filesystem store removal
// always proceeds; git failures are reported as warnings, not thrown.

import { rm, readdir, readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';

import { projectKey, projectStorePath } from './store.mjs';
import { slugify } from './artifacts.mjs';
import { removeWorktree } from './worktree.mjs';
import { branchExists } from './git-info.mjs';

// Statuses for which deletion is refused (the entry is or may be live).
const ACTIVE = new Set(['running', 'starting', 'created']);
const DATE_RE = /^(\d{2}-\d{2}-\d{2})-/;

function err(message, code) { return Object.assign(new Error(message), { code }); }
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** First non-empty, heading-stripped line — mirrors the orchestrator's firstLine. */
function firstLine(text) {
  if (!text) return '';
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.replace(/^#+\s*/, '').trim();
    if (t) return t;
  }
  return '';
}

/** Find the pipeline dir by directory basename, then by state.id. */
async function findPipelineDir(pipelinesDir, id) {
  let entries;
  try { entries = await readdir(pipelinesDir, { withFileTypes: true }); } catch { return null; }
  const dirs = entries.filter((e) => e.isDirectory());
  for (const e of dirs) if (e.name === id) return join(pipelinesDir, e.name);
  for (const e of dirs) {
    try {
      const st = JSON.parse(await readFile(join(pipelinesDir, e.name, 'state.json'), 'utf8'));
      if (st && st.id === id) return join(pipelinesDir, e.name);
    } catch { /* unreadable -> skip */ }
  }
  return null;
}

/**
 * Reconstruct the plan/review name linkage for an entry.
 *  - The exact base is `state.baseName` when persisted (orchestrator Step 1c).
 *  - For older entries we rebuild candidates that, combined, cover every way the
 *    orchestrator could have produced the base:
 *      a) _deriveBaseName-equivalent: title unless title === the dir basename (the
 *         auto title, which the orchestrator ignores), else the prompt's first
 *         line; slugified, capped at 40.
 *      b) the pipeline dir's own slug: <date>-<slug>-<id> with the date prefix and
 *         the trailing -<id> stripped.
 * Returns { datePrefix, bases:Set<string> } (all non-empty). Matching any
 * candidate is safe because the file regex is date-scoped and anchored.
 */
async function deriveNames(dir, state) {
  const dirBase = basename(dir);
  const m = DATE_RE.exec(dirBase);
  const datePrefix = (state?.datePrefix && String(state.datePrefix)) || (m ? m[1] : '');
  const bases = new Set();
  if (state?.baseName) bases.add(String(state.baseName));            // exact (persisted)

  const title = state?.title ? String(state.title) : '';
  const titleIsAuto = title && title === dirBase;                    // orchestrator ignores it
  let source = titleIsAuto ? '' : title;
  if (!source) {
    let prompt = '';
    try { prompt = await readFile(join(dir, 'prompt.md'), 'utf8'); } catch { /* none */ }
    source = firstLine(prompt);
  }
  const derived = slugify(source).slice(0, 40);
  if (derived) bases.add(derived);

  if (datePrefix && state?.id) {
    const inner = dirBase.slice(datePrefix.length + 1);              // drop "DD-MM-YY-"
    const suffix = `-${String(state.id)}`;
    const dirSlug = inner.endsWith(suffix) ? inner.slice(0, -suffix.length) : '';
    if (dirSlug) bases.add(dirSlug);
  }
  return { datePrefix, bases: new Set([...bases].filter(Boolean)) };
}

/**
 * Unlink every file in `dir` whose name matches `re`. Names returned by readdir
 * are single path segments (never contain a separator), so a matched name can
 * only ever resolve to a direct child of `dir` — no traversal is possible.
 */
async function removeMatching(dir, re) {
  const removed = [];
  let names;
  try { names = await readdir(dir); } catch { return removed; }
  for (const name of names) {
    if (!re.test(name)) continue;
    try { await unlink(join(dir, name)); removed.push(join(dir, name)); } catch { /* best-effort */ }
  }
  return removed;
}

/**
 * @param {{ projectDir?:string, key?:string, workspaceKey?:string, id:string }} args
 * @returns {Promise<null | { ok, id, pipelineDir, planFiles, reviewFiles, branch, worktree, warnings }>}
 *          null => no pipeline with that id (404). Throws err(code:'RUNNING'|'BAD_REQUEST') for guards.
 *
 * When `workspaceKey` is set the pipeline lives in the workspace store
 * (store/workspaces/<workspaceKey>/); branch/worktree cleanup iterates the
 * per-project `state.branches` map (each entry {feature,worktreeDir} keyed by
 * projectKey) against the matching `state.projects[].projectDir`, instead of the
 * single scalar `state.branch`. The ACTIVE-status guard and deriveNames are
 * unchanged. Result warnings[] aggregates per-project failures.
 */
export async function deletePipeline({ projectDir = null, key = null, workspaceKey = null, id } = {}) {
  if (!id || typeof id !== 'string') throw err('id is required', 'BAD_REQUEST');

  // Resolve the store key ONCE so the pipeline dir and the shared plan/review
  // files are always read from the same store root. A workspace pipeline lives
  // under the literal "workspaces/<workspaceKey>" segment (projectStorePath joins
  // it under storeRoot()), so the dir/plan/review resolution below is reused as-is.
  let storeKey = workspaceKey
    ? `workspaces/${workspaceKey}`
    : (key || (projectDir ? projectKey(projectDir) : null));
  if (!storeKey) throw err('projectKey, projectDir or workspaceKey is required', 'BAD_REQUEST');

  const dir = await findPipelineDir(join(projectStorePath(storeKey), 'pipelines'), id);
  if (!dir) return null;

  let state = null;
  try { state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')); } catch { state = null; }
  // When we derived the key from a projectDir, prefer the key the entry recorded
  // for itself (defensive; for a given repo these are equal). Never for a
  // workspace pipeline — its store key is the composite path, not state.projectKey.
  if (!workspaceKey && !key && state?.projectKey) storeKey = String(state.projectKey);

  if (ACTIVE.has(String(state?.status || '').toLowerCase())) {
    throw err('cannot delete a running pipeline', 'RUNNING');
  }

  const report = {
    ok: true, id, pipelineDir: dir,
    planFiles: [], reviewFiles: [], branch: null, worktree: null, warnings: [],
  };

  // 1) Shared plan/review markdown (linked only by <datePrefix>-<base> name).
  const { datePrefix, bases } = await deriveNames(dir, state);
  if (datePrefix && bases.size) {
    const root = projectStorePath(storeKey);
    const date = escapeRe(datePrefix);
    const alt = [...bases].map(escapeRe).join('|');
    report.planFiles = await removeMatching(
      join(root, 'plans'), new RegExp(`^${date}-(?:${alt})(-v\\d+)?\\.md$`));
    report.reviewFiles = await removeMatching(
      join(root, 'reviews'), new RegExp(`^${date}-(?:${alt})-(impl-review|plan-review)\\.md$`));
  } else {
    report.warnings.push('could not derive plan/review name; shared markdown left in place');
  }

  // 2) Local branch(es) + worktree(s) (remote untouched). Best-effort.
  if (workspaceKey) {
    // Per-project: iterate state.branches keyed by projectKey, cleaning each
    // member's worktree+branch in its OWN repo (state.projects[].projectDir).
    const branches = state?.branches && typeof state.branches === 'object' ? state.branches : {};
    const projects = Array.isArray(state?.projects) ? state.projects : [];
    const dirByKey = new Map(projects.map((p) => [p.projectKey, p.projectDir]));
    for (const [pk, br] of Object.entries(branches)) {
      const repoDir = dirByKey.get(pk) || null;
      const feature = br?.feature || null;
      const wt = br?.worktreeDir || null;
      if (!repoDir || (!feature && !wt)) continue;
      const liveWt = wt && existsSync(wt) ? wt : null;
      const liveBranch = feature && (await branchExists(repoDir, feature)) ? feature : null;
      if (!liveWt && !liveBranch) continue;
      const res = await removeWorktree({ projectDir: repoDir, worktreeDir: liveWt, branch: liveBranch, force: true });
      for (const s of res.steps.filter((x) => !x.ok)) {
        report.warnings.push(`${pk}: ${s.step}: ${s.stderr || 'failed'}`);
      }
    }
  } else {
    const repoDir = state?.projectDir || projectDir || null;
    const feature = state?.branch?.feature || null;
    const wt = state?.branch?.worktreeDir || null;
    if (repoDir && (feature || wt)) {
      const liveWt = wt && existsSync(wt) ? wt : null;                 // skip already-removed worktrees
      const liveBranch = feature && (await branchExists(repoDir, feature)) ? feature : null; // skip merged/deleted
      if (liveWt || liveBranch) {
        const res = await removeWorktree({ projectDir: repoDir, worktreeDir: liveWt, branch: liveBranch, force: true });
        report.branch = liveBranch;
        report.worktree = liveWt;
        for (const s of res.steps.filter((x) => !x.ok)) {
          report.warnings.push(`${s.step}: ${s.stderr || 'failed'}`);
        }
      }
    }
  }

  // 3) The pipeline folder itself (everything else lives inside it).
  await rm(dir, { recursive: true, force: true });

  return report;
}
