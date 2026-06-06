// src/core/artifacts.mjs
// Filesystem layout, naming, and pipeline persistence/audit helpers.
//
// All paths returned are absolute and rooted in the EXTERNAL store at
// <maestroHome>/store/<projectKey>/ (see store.mjs) — NOT inside the project
// working tree. This keeps history machine-wide and out of git. Pipelines are
// self-describing: each gets a directory containing the prompt, any extra files,
// a human-readable audit log (pipeline.md), and machine state (state.json).

import { mkdir, writeFile, readFile, copyFile, readdir, stat } from 'node:fs/promises';
import { join, basename, resolve, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { projectKey, projectStorePath, canonicalProjectRoot, storeRoot, workspaceStorePath, workspacesStoreRoot } from './store.mjs';
import { listProjects } from './projects.mjs';
import { branchExists, diffShortstat, hasGh, findPrForBranch } from './git-info.mjs';
import { getDb, tx } from './db.mjs';

// ── DB row <-> state object mapping (Phase 3) ──────────────────────────────────
// JSON columns are TEXT; (de)serialize at THIS boundary only. Reads are fail-safe:
// a null/empty/corrupt column yields the fallback, never a throw.

/** Parse a TEXT JSON column to an object/array, or `fallback` on null/empty/bad. */
function j(text, fallback = null) {
  if (text == null || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}
/** Stringify a value for a TEXT JSON column, or null when the value is null/undefined. */
function s(value) {
  return value == null ? null : JSON.stringify(value);
}

/** The 8-hex pipeline id embedded as the final "-<id>" segment of a run dir name. */
const DIR_ID_RE = /-([0-9a-f]{8})$/i;

/**
 * Read a store_meta row's JSON payload by key, or null when absent. Replaces the
 * per-project / per-workspace meta.json file read. Fail-safe: a corrupt/empty
 * payload reads as null rather than throwing.
 * @param {string} key
 * @returns {object|null}
 */
export function readStoreMeta(key) {
  const row = getDb().prepare('SELECT data FROM store_meta WHERE key = ?').get(key);
  return row ? j(row.data, null) : null;
}

/**
 * Upsert a store_meta row. `kind` is 'project' | 'workspace'; `data` is the full
 * meta object (stored as a JSON string). Replaces writing meta.json.
 * @param {string} key
 * @param {'project'|'workspace'} kind
 * @param {object} data
 */
export function writeStoreMeta(key, kind, data) {
  tx(() => {
    getDb().prepare(`
      INSERT INTO store_meta (key, kind, data) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, data = excluded.data
    `).run(key, kind, JSON.stringify(data ?? {}));
  });
}

/**
 * Delete a store_meta row (used by workspace delete in Phase 2). No-op when absent.
 * @param {string} key
 */
export function deleteStoreMeta(key) {
  tx(() => { getDb().prepare('DELETE FROM store_meta WHERE key = ?').run(key); });
}

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
 * Read or create the per-project meta (now a store_meta row, was meta.json).
 * Returns the meta object either way. Never throws: a failed write still returns
 * the computed meta so callers (createPipeline) get a project name without
 * re-reading. `firstSeenAt` is preserved across re-runs because an existing row
 * short-circuits. `_root` is retained for signature stability (now unused).
 */
async function ensureMeta(projectDir, _root) {
  void _root;
  const key = projectKey(projectDir);
  const existing = readStoreMeta(key);
  if (existing) return existing;                       // firstSeenAt preserved
  const canonical = canonicalProjectRoot(projectDir);
  let name = basename(canonical) || 'project';
  try {
    const projects = await listProjects();
    const hit = projects.find((pr) => {
      try { return realpathSync(pr.path) === canonical; } catch { return resolve(pr.path) === canonical; }
    });
    if (hit) name = hit.name;
  } catch { /* registry optional */ }
  const meta = { key, path: canonical, name, firstSeenAt: new Date().toISOString() };
  try { writeStoreMeta(key, 'project', meta); } catch { /* never block a run */ }
  return meta;
}

/**
 * Workspace variant of ensureMeta. Persists the §5.2 workspace meta shape
 * ({key,id,name,projectKeys,projectPaths,firstSeenAt}) to a store_meta row —
 * distinct from the project shape. Name resolution prefers the registry
 * (readWorkspace(workspaceId).name) and falls back to the primary canonical root
 * basename. Never throws, never blocks a run. `projectKeys`/`projectPaths` are
 * index-aligned and sorted by projectKey ascending.
 */
async function ensureWorkspaceMeta(primaryProjectDir, workspaceKey, opts = {}) {
  const existing = readStoreMeta(workspaceKey);
  if (existing) return existing;

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
  try { writeStoreMeta(workspaceKey, 'workspace', meta); } catch { /* never block a run */ }
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
 * Append a timeline entry to the pipeline's audit trail (was a markdown line in
 * pipeline.md). Now inserts a pipeline_events row {ts, text}. The pipeline id is
 * resolved from the dir: a dir->id cache fast path (seeded by createPipeline/
 * writeState), falling back to parsing the trailing 8-hex id from the dir basename
 * (createPipeline names dirs "<DD-MM-YY>-<slug>-<id>", id = 8 lowercase hex). When
 * no id can be resolved the call is a safe no-op (audit is best-effort, exactly as
 * the old appendFile could fail silently). Signature + async-ness unchanged so the
 * ~20 orchestrator call sites need no edit (A4).
 * @param {string} pipelineDir
 * @param {string} markdownLine
 * @returns {Promise<void>}
 */
export async function appendAudit(pipelineDir, markdownLine) {
  const id = resolvePipelineId(pipelineDir);
  if (!id) return;
  const ts = new Date().toISOString();
  const text = String(markdownLine ?? '').trim();
  try {
    tx(() => {
      getDb().prepare('INSERT INTO pipeline_events (pipeline_id, ts, text) VALUES (?, ?, ?)')
        .run(id, ts, text);
    });
  } catch { /* audit is best-effort; never break a run on a logging failure */ }
}

/** Resolve the 8-hex pipeline id for a run dir: cache hit, else parse the basename. */
function resolvePipelineId(pipelineDir) {
  if (!pipelineDir) return null;
  const hit = _dirIdCache.get(resolve(pipelineDir));
  if (hit) return hit;
  const m = DIR_ID_RE.exec(basename(pipelineDir));
  return m ? m[1].toLowerCase() : null;
}

/** Absolute pipelineDir -> 8-hex id cache; the appendAudit (Task 3.4) fast path. */
const _dirIdCache = new Map();
/** Seed the dir->id cache (called by writeState and, later, createPipeline). */
function rememberDir(dir, id) { if (dir && id) _dirIdCache.set(resolve(dir), id); }

/**
 * Persist the full state object: UPSERT its pipelines row and REPLACE its
 * pipeline_steps rows, in one transaction. The id is resolved from stateObj.id.
 * `pipelineDir` is retained for signature stability + to seed the dir->id cache
 * (appendAudit fast path). Returns the object actually persisted (updatedAt
 * stamped), matching the legacy contract. node:sqlite is synchronous; the function
 * stays async so every existing `await writeState(...)` call site is unchanged.
 *
 * A11(a): the ON CONFLICT(id) DO UPDATE clause SETs ONLY the columns that
 * legitimately mutate during a run. It deliberately does NOT touch the
 * creation-immutable identity columns (project_key, prompt, target, title,
 * base_name, date_prefix, workspace_key, started_at) — the orchestrator's
 * this.state omits several of them (orchestrator.mjs:174-191), so a blanket
 * "SET <every column>=excluded.<column>" would null them on the first post-create
 * persist (and _persist's catch{} would hide the loss). The INSERT arm still
 * writes every column; only the UPDATE arm is curated.
 * @param {string} pipelineDir
 * @param {object} stateObj
 * @returns {Promise<object>}
 */
export async function writeState(pipelineDir, stateObj) {
  const obj = { ...stateObj, updatedAt: new Date().toISOString() };
  const id = obj.id;
  if (!id) return obj; // pre-id state (constructor default): nothing to persist yet
  rememberDir(pipelineDir, id); // dir->id cache for appendAudit
  tx(() => {
    getDb().prepare(`
      INSERT INTO pipelines (id, project_key, workspace_key, target, title, base_name,
        date_prefix, status, phase, cycle, started_at, updated_at, total_cost_usd,
        total_active_ms, prompt, branch, workspace_meta, stepper, tools)
      VALUES (@id,@project_key,@workspace_key,@target,@title,@base_name,@date_prefix,
        @status,@phase,@cycle,@started_at,@updated_at,@total_cost_usd,@total_active_ms,
        @prompt,@branch,@workspace_meta,@stepper,@tools)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, phase=excluded.phase, cycle=excluded.cycle,
        updated_at=excluded.updated_at, total_cost_usd=excluded.total_cost_usd,
        total_active_ms=excluded.total_active_ms, branch=excluded.branch,
        workspace_meta=excluded.workspace_meta, stepper=excluded.stepper,
        tools=excluded.tools
    `).run(toPipelineRow(obj));

    getDb().prepare('DELETE FROM pipeline_steps WHERE pipeline_id = ?').run(id);
    const ins = getDb().prepare(`
      INSERT INTO pipeline_steps (pipeline_id, key, node_id, phase, step_index, cycle,
        status, started_at, updated_at, active_ms, running_since, cost_usd)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const st of Array.isArray(obj.steps) ? obj.steps : []) {
      ins.run(
        id, st.key, st.nodeId ?? null, st.phase ?? null,
        st.stepIndex ?? null, st.cycle ?? null, st.status ?? null,
        st.startedAt ?? null, st.updatedAt ?? null,
        Number.isFinite(st.activeMs) ? st.activeMs : 0,
        st.runningSince == null ? null : String(st.runningSince),
        Number.isFinite(st.costUsd) ? st.costUsd : 0,
      );
    }
  });
  return obj;
}

/**
 * Map a live state object to the named params of the pipelines UPSERT. JSON columns
 * are stringified here; the workspace superset collapses into workspace_meta.
 *
 * C1: the orchestrator's this.state carries projectDir but NOT projectKey
 * (orchestrator.mjs:174-191), and _persist() writes this.state verbatim. Reading
 * o.projectKey alone would write NULL on every post-creation persist → project_key
 * NOT NULL violation (swallowed by _persist's catch) → the run would freeze at its
 * 'created' snapshot. Derive from the always-present projectDir when the key is
 * absent. (Single-project AND workspace runs both carry projectDir = the primary
 * member dir.) projectKey is imported into artifacts.mjs from store.mjs.
 */
function toPipelineRow(o) {
  const workspaceMeta = o.target === 'workspace'
    ? s({
        workspaceId: o.workspaceId ?? null,
        workspaceName: o.workspaceName ?? null,
        workspaceDescription: o.workspaceDescription ?? '',
        projectKeys: Array.isArray(o.projectKeys) ? o.projectKeys : [],
        projects: Array.isArray(o.projects) ? o.projects : [],
        checkpointRefs: o.checkpointRefs ?? {},
        branches: o.branches ?? {},
      })
    : null;
  return {
    id: o.id,
    project_key: o.projectKey ?? (o.projectDir ? projectKey(o.projectDir) : null),
    workspace_key: o.workspaceKey ?? null,
    target: o.target ?? 'project',
    title: o.title ?? null,
    base_name: o.baseName ?? null,
    date_prefix: o.datePrefix ?? null,
    status: o.status ?? 'created',
    phase: o.phase ?? 'created',
    cycle: Number.isFinite(o.cycle) ? o.cycle : 0,
    started_at: o.startedAt ?? null,
    updated_at: o.updatedAt ?? null,
    total_cost_usd: Number.isFinite(o.totalCostUsd) ? o.totalCostUsd : 0,
    total_active_ms: Number.isFinite(o.totalActiveMs) ? o.totalActiveMs : 0,
    prompt: o.prompt ?? null,
    branch: s(o.branch),
    workspace_meta: workspaceMeta,
    stepper: s(o.stepper),
    tools: s(o.tools),
  };
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
 * Enumerate (but do NOT build) every pipeline row for one workspace key. The
 * expensive per-pipeline git work runs later, in parallel batches. Mirrors the
 * exact field tagging the old inline push did (projectKey/projectName/
 * workspaceName/projectDir/target) — primaryDir = meta.projectPaths[0]. Returns
 * task descriptors so no shared array is mutated concurrently.
 */
async function workspaceRowTasks(wkey, opts) {
  const keyDir = join(workspacesStoreRoot(), wkey);
  // Meta now lives in store_meta (Phase 3.2); fall back to a legacy meta.json file
  // for stores written before the migration. (Task 3.6 formalizes the read path.)
  let meta = readStoreMeta(wkey);
  if (!meta) { try { meta = JSON.parse(await readFile(join(keyDir, 'meta.json'), 'utf8')); } catch { meta = null; } }
  const primaryDir = Array.isArray(meta?.projectPaths) ? (meta.projectPaths[0] ?? null) : null;
  const pipelinesDir = join(keyDir, 'pipelines');
  let entries;
  try { entries = await readdir(pipelinesDir, { withFileTypes: true }); } catch { return []; }
  const tag = {
    projectKey: `workspaces/${wkey}`,
    projectName: meta?.name ?? wkey,
    workspaceName: meta?.name ?? wkey, // explicit field the History UI prefers
    projectDir: primaryDir,
    target: 'workspace',
  };
  return entries
    .filter((ent) => ent.isDirectory())
    .map((ent) => ({ dir: join(pipelinesDir, ent.name), projectDir: primaryDir, tag, opts }));
}

/** Every pipeline across every store key, newest-first, tagged with project.
 *  The per-pipeline build (which spawns git/gh) runs in parallel batches so a
 *  large store does not pay N serialized git round-trips. Wire format unchanged. */
export async function listAllPipelines(opts = {}, { batchSize = 16 } = {}) {
  const root = storeRoot();
  let keys;
  try { keys = await readdir(root, { withFileTypes: true }); } catch { return []; }

  // Phase 1 — cheap enumeration only (readdir + meta.json reads, no git).
  const tasks = [];
  for (const k of keys) {
    if (!k.isDirectory()) continue;
    // The "workspaces" entry is a CONTAINER, not a pipeline-bearing key: recurse one
    // level and treat each <workspaceKey>/ child as a key dir.
    if (k.name === 'workspaces') {
      let wkeys;
      try { wkeys = await readdir(join(root, k.name), { withFileTypes: true }); } catch { continue; }
      for (const wk of wkeys) {
        if (!wk.isDirectory()) continue;
        tasks.push(...(await workspaceRowTasks(wk.name, opts)));
      }
      continue;
    }
    const keyDir = join(root, k.name);
    // Meta now lives in store_meta (Phase 3.2); fall back to a legacy meta.json file
    // for stores written before the migration. (Task 3.6 formalizes the read path.)
    let meta = readStoreMeta(k.name);
    if (!meta) { try { meta = JSON.parse(await readFile(join(keyDir, 'meta.json'), 'utf8')); } catch { meta = null; } }
    const pipelinesDir = join(keyDir, 'pipelines');
    let entries;
    try { entries = await readdir(pipelinesDir, { withFileTypes: true }); } catch { continue; }
    const tag = { projectKey: k.name, projectName: meta?.name ?? k.name, projectDir: meta?.path ?? null };
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      tasks.push({ dir: join(pipelinesDir, ent.name), projectDir: meta?.path ?? null, tag, opts });
    }
  }

  // Phase 2 — build rows in parallel, capped at `batchSize` concurrent git/gh fans.
  const out = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const rows = await Promise.all(tasks.slice(i, i + batchSize).map(async (t) => {
      const e = await pipelineEntry(t.dir, t.projectDir, t.opts);
      return Object.assign(e, t.tag); // same tag fields as before; tag has no `pr` key
    }));
    out.push(...rows);
  }

  // Newest-first, with a deterministic tiebreaker so equal-mtime rows do not
  // reorder run-to-run now that build order is non-deterministic (parallel).
  out.sort((a, b) =>
    (b.mtime - a.mtime) ||
    (a.projectKey < b.projectKey ? -1 : a.projectKey > b.projectKey ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/**
 * Re-walk the skeleton and resolve live PR state per branch, pushed to `onBatch`
 * in parallel batches. v1 sends ONLY `pr` (state OPEN/MERGED or null) —
 * findPrForBranch already distinguishes merged-vs-open. We do NOT compute live
 * mergeability (no prMergeable call). `onBatch(items, isFinal)` is awaited so a
 * caller can broadcast incrementally; the FINAL call always carries isFinal=true
 * (even with no gh / no targets) so a client spinner provably clears.
 */
export async function enrichPipelinesPr(onBatch, { batchSize = 16 } = {}) {
  if (!(await hasGh())) { await onBatch([], true); return; } // no gh: one empty final batch
  const rows = await listAllPipelines();                     // skeleton (no withPr), parallelized
  const targets = rows.filter((r) => r.projectDir && r.branch);
  if (targets.length === 0) { await onBatch([], true); return; }
  for (let i = 0; i < targets.length; i += batchSize) {
    const slice = targets.slice(i, i + batchSize);
    const items = await Promise.all(slice.map(async (r) => ({
      projectKey: r.projectKey,
      id: r.id,
      pr: (await findPrForBranch({ projectDir: r.projectDir, head: r.branch })) || null,
    })));
    await onBatch(items, i + batchSize >= targets.length); // (items, isFinal)
  }
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
