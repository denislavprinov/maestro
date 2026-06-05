// src/core/artifacts.mjs
// Filesystem layout, naming, and pipeline persistence/audit helpers.
//
// All paths returned are absolute and rooted in the EXTERNAL store at
// <maestroHome>/store/<projectKey>/ (see store.mjs) — NOT inside the project
// working tree. This keeps history machine-wide and out of git. Pipelines are
// self-describing: each gets a directory containing the prompt, any extra files,
// a human-readable audit log (pipeline.md), and machine state (state.json).

import { mkdir, writeFile, readFile, copyFile, readdir, stat, appendFile } from 'node:fs/promises';
import { join, basename, resolve, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { projectKey, projectStorePath, canonicalProjectRoot, storeRoot, workspaceStorePath, workspacesStoreRoot } from './store.mjs';
import { listProjects } from './projects.mjs';
import { branchExists, diffShortstat, hasGh, findPrForBranch } from './git-info.mjs';

/** Hard cap for the FROZEN workspace description copied into a run (cap-on-freeze). */
const WORKSPACE_DESCRIPTION_CAP = 2000;

/**
 * Convert an arbitrary string to a safe kebab-case slug.
 * - Lowercases, replaces non-alphanumerics with hyphens, collapses repeats,
 *   trims leading/trailing hyphens.
 * - Returns "untitled" for empty input.
 * @param {string} s
 * @returns {string}
 */
export function slugify(s) {
  const out = String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'untitled';
}

/**
 * Current date as "DD-MM-YY" using the runtime system clock.
 * @returns {string}
 */
export function today() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear() % 100).padStart(2, '0');
  return `${dd}-${mm}-${yy}`;
}

/**
 * Absolute artifact directory paths in the external store for `projectDir`,
 * i.e. <maestroHome>/store/<projectKey(projectDir)>/{plans,reviews,pipelines}.
 * Every reader/writer (plans, reviews, pipeline history) routes through here, so
 * redirecting this one function moves all three out of the working tree at once.
 * When `workspaceKey` is given, the root is the workspace store namespace
 * (<maestroHome>/store/workspaces/<workspaceKey>) instead of the per-project key
 * dir. Single-project callers (no second arg) are byte-identical.
 * @param {string} projectDir
 * @param {string} [workspaceKey] when set, routes to the workspace store
 * @returns {{root:string, plans:string, reviews:string, pipelines:string}}
 */
export function artifactPaths(projectDir, workspaceKey) {
  const root = workspaceKey
    ? workspaceStorePath(workspaceKey)
    : projectStorePath(projectKey(projectDir));
  return {
    root,
    plans: join(root, 'plans'),
    reviews: join(root, 'reviews'),
    pipelines: join(root, 'pipelines'),
  };
}

/**
 * Read or create the per-project meta.json. Returns the meta object either way.
 * Never throws: a failed write still returns the computed meta so callers
 * (createPipeline) get a project name without re-reading disk.
 */
async function ensureMeta(projectDir, root) {
  const metaPath = join(root, 'meta.json');
  try { return JSON.parse(await readFile(metaPath, 'utf8')); } catch { /* not written yet */ }
  const canonical = canonicalProjectRoot(projectDir);
  let name = basename(canonical) || 'project';
  try {
    const projects = await listProjects();
    const hit = projects.find((pr) => {
      try { return realpathSync(pr.path) === canonical; } catch { return resolve(pr.path) === canonical; }
    });
    if (hit) name = hit.name;
  } catch { /* registry optional */ }
  const meta = { key: projectKey(projectDir), path: canonical, name, firstSeenAt: new Date().toISOString() };
  try { await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8'); } catch { /* never block a run */ }
  return meta;
}

/**
 * Workspace variant of ensureMeta. Writes the §5.2 workspace meta.json shape
 * ({key,id,name,projectKeys,projectPaths,firstSeenAt}) — distinct from the project
 * shape. Name resolution prefers the registry (readWorkspace(workspaceId).name) and
 * falls back to the primary canonical root basename. Never throws, never blocks a run.
 * `projectKeys`/`projectPaths` are index-aligned and sorted by projectKey ascending.
 */
async function ensureWorkspaceMeta(primaryProjectDir, workspaceKey, opts = {}) {
  const metaPath = join(workspaceStorePath(workspaceKey), 'meta.json');
  try { return JSON.parse(await readFile(metaPath, 'utf8')); } catch { /* not written yet */ }

  const members = Array.isArray(opts.projects) ? opts.projects.slice() : [];
  members.sort((a, b) => {
    const ka = a?.projectKey ?? '';
    const kb = b?.projectKey ?? '';
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  let name = typeof opts.workspaceName === 'string' && opts.workspaceName ? opts.workspaceName : '';
  if (!name) {
    try {
      const { readWorkspace } = await import('./workspaces.mjs');
      const ws = await readWorkspace(opts.workspaceId || workspaceKey);
      if (ws && ws.name) name = ws.name;
    } catch { /* registry optional */ }
  }
  if (!name) name = basename(canonicalProjectRoot(primaryProjectDir)) || 'workspace';

  const meta = {
    key: workspaceKey,
    id: opts.workspaceId || workspaceKey,
    name,
    projectKeys: members.map((m) => m.projectKey),
    projectPaths: members.map((m) => resolve(m.projectDir)),
    firstSeenAt: new Date().toISOString(),
  };
  try { await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8'); } catch { /* never block a run */ }
  return meta;
}

/**
 * Ensure the artifact directories (plans/reviews/pipelines) + meta.json exist.
 * When `workspaceKey` is set, routes to the workspace store and writes the
 * workspace meta shape; `opts` carries {workspaceId, workspaceName, projects}.
 * Single-project callers (no second arg) are byte-identical.
 */
export async function ensureArtifactDirs(projectDir, workspaceKey, opts = {}) {
  const p = artifactPaths(projectDir, workspaceKey);
  await mkdir(p.plans, { recursive: true });
  await mkdir(p.reviews, { recursive: true });
  await mkdir(p.pipelines, { recursive: true });
  const meta = workspaceKey
    ? await ensureWorkspaceMeta(projectDir, workspaceKey, opts)
    : await ensureMeta(projectDir, p.root);
  return { ...p, meta };
}

/**
 * Path for a plan markdown file.
 * version 1 => <DD-MM-YY-baseName>.md ; version N>1 => <...>-vN.md
 *
 * The date prefix is stamped at call time by default. Long-running pipelines
 * that cross midnight would otherwise give v1 one date and v2/v3 the next day's
 * date, breaking the shared-base linkage. The orchestrator therefore captures
 * the prefix once at run start and passes it as `datePrefix` so every -vN
 * version shares the v1 prefix.
 * @param {string} projectDir
 * @param {string} baseName already-slugified base (date is prefixed here)
 * @param {number} [version=1]
 * @param {string} [datePrefix] fixed DD-MM-YY prefix (defaults to today())
 * @param {string} [workspaceKey] when set, routes to the workspace store
 * @returns {string}
 */
export function planPath(projectDir, baseName, version = 1, datePrefix, workspaceKey) {
  const { plans } = artifactPaths(projectDir, workspaceKey);
  const v = Number(version) > 1 ? `-v${Number(version)}` : '';
  const date = datePrefix || today();
  return join(plans, `${date}-${baseName}${v}.md`);
}

/**
 * Path for an implementation review markdown file.
 * @param {string} projectDir
 * @param {string} baseName
 * @param {string} [datePrefix] fixed DD-MM-YY prefix (defaults to today())
 * @param {string} [kind='impl-review']
 * @param {string} [workspaceKey] when set, routes to the workspace store
 * @returns {string}
 */
export function reviewPath(projectDir, baseName, datePrefix, kind = 'impl-review', workspaceKey) {
  const { reviews } = artifactPaths(projectDir, workspaceKey);
  const date = datePrefix || today();
  return join(reviews, `${date}-${baseName}-${kind}.md`);
}

/** Short random id (8 hex chars) used to make pipeline dirs unique. */
function shortId() {
  return randomBytes(4).toString('hex');
}

/**
 * Freeze a workspace description into a run: hard cap at WORKSPACE_DESCRIPTION_CAP
 * total chars (.length, i.e. UTF-16 code units), truncating with a trailing
 * ellipsis when over (the ellipsis counts toward the cap so the result is never
 * longer than the cap). Cap-on-freeze only — the editable registry copy in
 * workspaces.json is never truncated.
 *
 * Truncation is code-point aware: it accumulates whole code points until the next
 * one would push past CAP-1 code units, so it never splits a surrogate pair (a
 * naive s.slice(0, CAP-1) could leave a lone surrogate before the ellipsis).
 * @param {string} text
 * @returns {string}
 */
function freezeDescription(text) {
  const s = typeof text === 'string' ? text : '';
  if (s.length <= WORKSPACE_DESCRIPTION_CAP) return s;
  const budget = WORKSPACE_DESCRIPTION_CAP - 1; // reserve one code unit for the ellipsis
  let out = '';
  for (const cp of s) {                          // iterates by code point, never mid-pair
    if (out.length + cp.length > budget) break;
    out += cp;
  }
  return out + '…';
}

/**
 * Resolve a possibly-relative path against a base directory.
 */
function resolveAgainst(base, p) {
  return isAbsolute(p) ? p : resolve(base, p);
}

/**
 * Create a new pipeline directory and seed it with the prompt, extras, an audit
 * header (pipeline.md) and initial state (state.json).
 *
 * When `opts.workspaceKey` is set the pipeline is written to the WORKSPACE store
 * (store/workspaces/<key>/), state.json carries the §5.2 workspace superset
 * (target:'workspace', workspaceId/Key/Name, frozen workspaceDescription, sorted
 * projectKeys, projects[], empty checkpointRefs/branches), and a frozen
 * workspace-description.md snapshot is written into the pipeline dir. The frozen
 * description is hard-capped at 2000 chars (cap-on-freeze; the editable registry
 * copy is untouched). `projectDir` is the PRIMARY member (projects[0] after sort).
 * Absent the workspace opts the single-project path is byte-identical.
 *
 * @param {string} projectDir   single-project dir, or the workspace primary dir
 * @param {object} opts
 * @param {string} [opts.prompt]      inline prompt text
 * @param {string} [opts.promptFile]  path to a markdown file to use as the prompt
 * @param {string[]} [opts.extras]    paths to extra files copied into dir/extras
 * @param {string} [opts.title]       human title (defaults to derived text)
 * @param {string} [opts.workspaceKey]   opt-in: route to the workspace store
 * @param {string} [opts.workspaceId]    == workspaceKey
 * @param {string} [opts.workspaceName]
 * @param {string} [opts.workspaceDescription]  frozen verbatim (capped at 2000)
 * @param {Array<{projectKey,projectDir,projectName}>} [opts.projects]  sorted members
 * @returns {Promise<{id:string, dir:string, promptText:string}>}
 */
export async function createPipeline(projectDir, opts = {}) {
  const {
    prompt, promptFile, extras = [], title,
    workspaceKey = null, workspaceId = null, workspaceName = null,
    workspaceDescription = '', projects = null,
  } = opts;
  const paths = await ensureArtifactDirs(projectDir, workspaceKey || undefined, {
    workspaceId: workspaceId || workspaceKey,
    workspaceName,
    projects,
  });
  const key = projectKey(projectDir);
  const projectName = (paths.meta && paths.meta.name) || basename(resolve(projectDir));

  // Resolve the prompt text from inline text or a markdown file.
  let promptText = typeof prompt === 'string' ? prompt : '';
  if (!promptText && promptFile) {
    try {
      promptText = await readFile(resolveAgainst(projectDir, promptFile), 'utf8');
    } catch {
      promptText = '';
    }
  }

  const resolvedTitle =
    (title && String(title).trim()) ||
    firstMeaningfulLine(promptText) ||
    'orchestration';

  const id = shortId();
  const slug = slugify(resolvedTitle).slice(0, 48) || 'pipeline';
  const dirName = `${today()}-${slug}-${id}`;
  const dir = join(paths.pipelines, dirName);
  await mkdir(dir, { recursive: true });

  // Seed the prompt. If a markdown file was provided, copy it verbatim;
  // otherwise persist the inline text. Either way prompt.md is the source.
  const promptDest = join(dir, 'prompt.md');
  if (promptFile) {
    try {
      await copyFile(resolveAgainst(projectDir, promptFile), promptDest);
    } catch {
      await writeFile(promptDest, promptText, 'utf8');
    }
  } else {
    await writeFile(promptDest, promptText, 'utf8');
  }

  // Copy optional extra files.
  if (Array.isArray(extras) && extras.length) {
    const extrasDir = join(dir, 'extras');
    await mkdir(extrasDir, { recursive: true });
    for (const ex of extras) {
      if (!ex) continue;
      const src = resolveAgainst(projectDir, ex);
      try {
        await copyFile(src, join(extrasDir, basename(src)));
      } catch {
        // Skip unreadable extras; never fail pipeline creation on a bad path.
      }
    }
  }

  const startedAt = new Date().toISOString();
  const state = {
    id,
    title: resolvedTitle,
    projectDir: resolve(projectDir),
    projectKey: key,
    projectName,
    status: 'created',
    phase: 'created',
    cycle: 0,
    startedAt,
    updatedAt: startedAt,
    artifacts: [],
  };

  // Workspace runs carry the §5.2 superset, discriminated by target:'workspace'.
  // The description is FROZEN here (capped at 2000) so later registry edits never
  // retroactively alter a started run; branches/checkpointRefs start empty and are
  // populated by the orchestrator at worktree/checkpoint setup.
  if (workspaceKey) {
    const members = (Array.isArray(projects) ? projects.slice() : []).sort(
      (a, b) => {
        const ka = a?.projectKey ?? '';
        const kb = b?.projectKey ?? '';
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      },
    );
    const frozenDescription = freezeDescription(workspaceDescription);
    state.target = 'workspace';
    state.workspaceId = workspaceId || workspaceKey;
    state.workspaceKey = workspaceKey;
    state.workspaceName = workspaceName || (paths.meta && paths.meta.name) || '';
    state.workspaceDescription = frozenDescription;
    state.projectKeys = members.map((m) => m.projectKey);
    state.projects = members.map((m) => ({
      projectKey: m.projectKey,
      projectDir: resolve(m.projectDir),
      projectName: m.projectName ?? basename(resolve(m.projectDir)),
    }));
    state.checkpointRefs = {};
    state.branches = {};
    await writeFile(join(dir, 'workspace-description.md'), frozenDescription, 'utf8');
  }

  await writeState(dir, state);

  const header =
    `# Pipeline: ${resolvedTitle}\n\n` +
    `- **id**: ${id}\n` +
    `- **project**: ${resolve(projectDir)}\n` +
    `- **started**: ${startedAt}\n` +
    `- **prompt file**: prompt.md\n\n` +
    `## Prompt\n\n` +
    fenceIfNeeded(promptText) +
    `\n## Timeline\n\n`;
  await writeFile(join(dir, 'pipeline.md'), header, 'utf8');

  return { id, dir, promptText };
}

function firstMeaningfulLine(text) {
  if (!text) return '';
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.replace(/^#+\s*/, '').trim();
    if (t) return t.slice(0, 80);
  }
  return '';
}

function fenceIfNeeded(text) {
  const t = String(text ?? '').trim();
  if (!t) return '_(empty prompt)_\n';
  return t + '\n';
}

/**
 * Append a single markdown line (timeline entry) to the pipeline audit file.
 * Each line is timestamped and rendered as a list item.
 * @param {string} pipelineDir
 * @param {string} markdownLine
 * @returns {Promise<void>}
 */
export async function appendAudit(pipelineDir, markdownLine) {
  const ts = new Date().toISOString();
  const line = `- \`${ts}\` ${String(markdownLine ?? '').trim()}\n`;
  await appendFile(join(pipelineDir, 'pipeline.md'), line, 'utf8');
}

/**
 * Persist the full state object as state.json (pretty-printed), stamping
 * updatedAt. Returns the object actually written.
 * @param {string} pipelineDir
 * @param {object} stateObj
 * @returns {Promise<object>}
 */
export async function writeState(pipelineDir, stateObj) {
  const obj = { ...stateObj, updatedAt: new Date().toISOString() };
  await writeFile(join(pipelineDir, 'state.json'), JSON.stringify(obj, null, 2) + '\n', 'utf8');
  return obj;
}

/**
 * The pipeline's total spend for the history list. Prefer the persisted
 * `totalCostUsd`; when it is missing/non-number (older or partially written
 * state.json), fall back to summing per-step `costUsd` so a run that recorded
 * step costs is never shown as blank. Returns null only when there is genuinely
 * no cost data at all.
 * @param {object|null} state
 * @returns {number|null}
 */
function pipelineTotalCost(state) {
  if (typeof state?.totalCostUsd === 'number') return state.totalCostUsd;
  let sum = 0;
  let any = false;
  for (const s of Array.isArray(state?.steps) ? state.steps : []) {
    if (Number.isFinite(s?.costUsd)) {
      sum += s.costUsd;
      any = true;
    }
  }
  return any ? Math.round(sum * 1e4) / 1e4 : null;
}

/**
 * The pipeline's total active processing time (ms) for the history list. Prefer
 * the persisted `totalActiveMs`; fall back to summing per-step `activeMs` for
 * older/partial state.json. Returns null only when there's no timing data at all
 * (so the UI renders a blank chip rather than a misleading 0s).
 * @param {object|null} state
 * @returns {number|null}
 */
function pipelineTotalActiveMs(state) {
  if (typeof state?.totalActiveMs === 'number') return state.totalActiveMs;
  let sum = 0;
  let any = false;
  for (const s of Array.isArray(state?.steps) ? state.steps : []) {
    if (Number.isFinite(s?.activeMs)) { sum += s.activeMs; any = true; }
  }
  return any ? sum : null;
}

/** Build one history row from a pipeline directory. Never throws.
 *  `projectDir` is the git repo root used to compute live branch facts
 *  (survival + diff line-counts); falls back to state.projectDir. */
async function pipelineEntry(dir, projectDir = null, opts = {}) {
  let mtime = 0;
  try { mtime = (await stat(dir)).mtimeMs; } catch { /* ignore */ }
  let state = null;
  try { state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')); } catch { state = null; }
  const branch = state?.branch?.feature ?? (typeof state?.branch === 'string' ? state.branch : null);
  const sourceBranch = state?.branch?.source ?? null;

  // Live git facts: a branch "survived" iff its ref still exists in the repo; line
  // counts come from `git diff --shortstat <source>...<feature>` recomputed now.
  const repoDir = projectDir || state?.projectDir || null;
  let survived = false;
  let added = 0;
  let removed = 0;
  if (repoDir && branch) {
    survived = await branchExists(repoDir, branch);
    if (survived && sourceBranch) {
      const d = await diffShortstat(repoDir, sourceBranch, branch);
      added = d.added;
      removed = d.removed;
    }
  }

  const entry = {
    id: state?.id ?? basename(dir),
    dir,
    title: state?.title ?? basename(dir),
    status: state?.status ?? 'unknown',
    startedAt: state?.startedAt ?? null,
    branch,
    sourceBranch,
    survived,
    added,
    removed,
    totalCostUsd: pipelineTotalCost(state),
    totalActiveMs: pipelineTotalActiveMs(state),
    mtime,
  };

  // Live PR state (opt-in; only the UI history endpoints request it). One gh call
  // per entry that has a feature branch — including merged branches that no longer
  // exist locally, which is exactly the "already merged" case we must detect. When
  // gh is unavailable we still set pr:null (the field is present whenever requested),
  // so callers can distinguish "looked, none" from "did not look".
  if (opts.withPr && repoDir && branch) {
    entry.pr = (await hasGh()) ? await findPrForBranch({ projectDir: repoDir, head: branch }) : null;
  }

  return entry;
}

/**
 * List all pipelines for a project, newest first.
 * Each entry: { id, dir, title, status, startedAt, branch, totalCostUsd, totalActiveMs, mtime }.
 * Directories without a readable state.json fall back to filesystem metadata.
 * @param {string} projectDir
 * @returns {Promise<Array>}
 */
export async function listPipelines(projectDir, opts = {}, workspaceKey) {
  const { pipelines } = artifactPaths(projectDir, workspaceKey);
  let entries;
  try { entries = await readdir(pipelines, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    out.push(await pipelineEntry(join(pipelines, ent.name), projectDir, opts));
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/**
 * Walk one workspace key dir, pushing a row per pipeline. A workspace row carries
 * the literal store-relative composite key "workspaces/<wkey>" (round-trips through
 * projectStorePath) and target:'workspace'; name/primary-dir come from the
 * workspace meta. Live branch facts are best-effort against the primary repo only.
 */
async function pushWorkspaceRows(out, wkey, opts) {
  const keyDir = join(workspacesStoreRoot(), wkey);
  let meta = null;
  try { meta = JSON.parse(await readFile(join(keyDir, 'meta.json'), 'utf8')); } catch { meta = null; }
  const primaryDir = Array.isArray(meta?.projectPaths) ? (meta.projectPaths[0] ?? null) : null;
  const pipelinesDir = join(keyDir, 'pipelines');
  let entries;
  try { entries = await readdir(pipelinesDir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const e = await pipelineEntry(join(pipelinesDir, ent.name), primaryDir, opts);
    e.projectKey = `workspaces/${wkey}`;
    e.projectName = meta?.name ?? wkey;
    e.projectDir = primaryDir;
    e.target = 'workspace';
    out.push(e);
  }
}

/** Every pipeline across every store key, newest-first, tagged with project. */
export async function listAllPipelines(opts = {}) {
  const root = storeRoot();
  let keys;
  try { keys = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const k of keys) {
    if (!k.isDirectory()) continue;
    // The "workspaces" entry is a CONTAINER, not a pipeline-bearing key: recurse one
    // level and treat each <workspaceKey>/ child as a key dir.
    if (k.name === 'workspaces') {
      let wkeys;
      try { wkeys = await readdir(join(root, k.name), { withFileTypes: true }); } catch { continue; }
      for (const wk of wkeys) {
        if (!wk.isDirectory()) continue;
        await pushWorkspaceRows(out, wk.name, opts);
      }
      continue;
    }
    const keyDir = join(root, k.name);
    let meta = null;
    try { meta = JSON.parse(await readFile(join(keyDir, 'meta.json'), 'utf8')); } catch { meta = null; }
    const pipelinesDir = join(keyDir, 'pipelines');
    let entries;
    try { entries = await readdir(pipelinesDir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const e = await pipelineEntry(join(pipelinesDir, ent.name), meta?.path ?? null, opts);
      e.projectKey = k.name;
      e.projectName = meta?.name ?? k.name;
      e.projectDir = meta?.path ?? null;
      out.push(e);
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/**
 * Read a single pipeline by id, returning its parsed state and audit markdown.
 * Returns null when no pipeline with that id exists (so callers can map a
 * not-found to a 404 rather than a 500).
 * @param {string} projectDir
 * @param {string} id
 * @returns {Promise<{state:object|null, auditMarkdown:string}|null>}
 */
export async function readPipeline(projectDir, id) {
  const list = await listPipelines(projectDir);
  const match = list.find((p) => p.id === id || basename(p.dir) === id);
  if (!match) {
    return null;
  }
  let state = null;
  try {
    state = JSON.parse(await readFile(join(match.dir, 'state.json'), 'utf8'));
  } catch {
    state = null;
  }
  let auditMarkdown = '';
  try {
    auditMarkdown = await readFile(join(match.dir, 'pipeline.md'), 'utf8');
  } catch {
    auditMarkdown = '';
  }
  return { state, auditMarkdown };
}

/**
 * Read a single pipeline from an absolute pipelines/ directory, matching by
 * directory basename then by state.id. Returns the {state, auditMarkdown} pair, or
 * null when the dir or id is unknown. Shared by the project- and workspace-rooted
 * readers so the match/read logic stays identical.
 */
async function readPipelineFromDir(pipelinesDir, id) {
  let entries;
  try { entries = await readdir(pipelinesDir, { withFileTypes: true }); } catch { return null; }
  let matchDir = null;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name === id) { matchDir = join(pipelinesDir, ent.name); break; }
    try {
      const st = JSON.parse(await readFile(join(pipelinesDir, ent.name, 'state.json'), 'utf8'));
      if (st && st.id === id) { matchDir = join(pipelinesDir, ent.name); break; }
    } catch { /* skip unreadable */ }
  }
  if (!matchDir) return null;
  let state = null;
  try { state = JSON.parse(await readFile(join(matchDir, 'state.json'), 'utf8')); } catch { state = null; }
  let auditMarkdown = '';
  try { auditMarkdown = await readFile(join(matchDir, 'pipeline.md'), 'utf8'); } catch { auditMarkdown = ''; }
  return { state, auditMarkdown };
}

/**
 * Read a pipeline directly from a store key (project-agnostic). Matches by
 * pipeline short-id (state.id) or by directory basename. Returns null when the
 * key or id is unknown (so the API maps it to a 404). Accepts a workspace
 * composite key "workspaces/<workspaceKey>" as-is (projectStorePath joins it under
 * storeRoot()).
 */
export async function readPipelineByKey(key, id) {
  return readPipelineFromDir(join(projectStorePath(key), 'pipelines'), id);
}

/**
 * List pipelines for a workspace from its OWN store namespace
 * (store/workspaces/<workspaceKey>/pipelines), newest-first. `primaryDir` supplies
 * live branch facts (best-effort, primary repo only). Mirrors listPipelines.
 * @param {string} workspaceKey
 * @param {string} [primaryDir]
 * @param {object} [opts]
 */
export async function listWorkspacePipelines(workspaceKey, primaryDir = null, opts = {}) {
  const pipelinesDir = join(workspaceStorePath(workspaceKey), 'pipelines');
  let entries;
  try { entries = await readdir(pipelinesDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    out.push(await pipelineEntry(join(pipelinesDir, ent.name), primaryDir, opts));
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/**
 * Read a single workspace pipeline by id, rooted in the workspace store. Mirrors
 * readPipelineByKey but joins ONLY workspaceStorePath(workspaceKey) so there is no
 * path-traversal surface (the server validates the key against WORKSPACE_ID_RE).
 * Returns null when the workspace or id is unknown.
 */
export async function readWorkspacePipeline(workspaceKey, id) {
  return readPipelineFromDir(join(workspaceStorePath(workspaceKey), 'pipelines'), id);
}
