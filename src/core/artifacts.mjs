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
import { projectKey, projectStorePath, canonicalProjectRoot, storeRoot } from './store.mjs';
import { listProjects } from './projects.mjs';

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
 * @param {string} projectDir
 * @returns {{root:string, plans:string, reviews:string, pipelines:string}}
 */
export function artifactPaths(projectDir) {
  const root = projectStorePath(projectKey(projectDir));
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

export async function ensureArtifactDirs(projectDir) {
  const p = artifactPaths(projectDir);
  await mkdir(p.plans, { recursive: true });
  await mkdir(p.reviews, { recursive: true });
  await mkdir(p.pipelines, { recursive: true });
  const meta = await ensureMeta(projectDir, p.root);
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
 * @returns {string}
 */
export function planPath(projectDir, baseName, version = 1, datePrefix) {
  const { plans } = artifactPaths(projectDir);
  const v = Number(version) > 1 ? `-v${Number(version)}` : '';
  const date = datePrefix || today();
  return join(plans, `${date}-${baseName}${v}.md`);
}

/**
 * Path for an implementation review markdown file.
 * @param {string} projectDir
 * @param {string} baseName
 * @param {string} [datePrefix] fixed DD-MM-YY prefix (defaults to today())
 * @returns {string}
 */
export function reviewPath(projectDir, baseName, datePrefix) {
  const { reviews } = artifactPaths(projectDir);
  const date = datePrefix || today();
  return join(reviews, `${date}-${baseName}-impl-review.md`);
}

/** Short random id (8 hex chars) used to make pipeline dirs unique. */
function shortId() {
  return randomBytes(4).toString('hex');
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
 * @param {string} projectDir
 * @param {object} opts
 * @param {string} [opts.prompt]      inline prompt text
 * @param {string} [opts.promptFile]  path to a markdown file to use as the prompt
 * @param {string[]} [opts.extras]    paths to extra files copied into dir/extras
 * @param {string} [opts.title]       human title (defaults to derived text)
 * @returns {Promise<{id:string, dir:string, promptText:string}>}
 */
export async function createPipeline(projectDir, opts = {}) {
  const { prompt, promptFile, extras = [], title } = opts;
  const paths = await ensureArtifactDirs(projectDir);
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

/** Build one history row from a pipeline directory. Never throws. */
async function pipelineEntry(dir) {
  let mtime = 0;
  try { mtime = (await stat(dir)).mtimeMs; } catch { /* ignore */ }
  let state = null;
  try { state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')); } catch { state = null; }
  const branch = state?.branch?.feature ?? (typeof state?.branch === 'string' ? state.branch : null);
  return {
    id: state?.id ?? basename(dir),
    dir,
    title: state?.title ?? basename(dir),
    status: state?.status ?? 'unknown',
    startedAt: state?.startedAt ?? null,
    branch,
    totalCostUsd: pipelineTotalCost(state),
    totalActiveMs: pipelineTotalActiveMs(state),
    mtime,
  };
}

/**
 * List all pipelines for a project, newest first.
 * Each entry: { id, dir, title, status, startedAt, branch, totalCostUsd, totalActiveMs, mtime }.
 * Directories without a readable state.json fall back to filesystem metadata.
 * @param {string} projectDir
 * @returns {Promise<Array>}
 */
export async function listPipelines(projectDir) {
  const { pipelines } = artifactPaths(projectDir);
  let entries;
  try { entries = await readdir(pipelines, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    out.push(await pipelineEntry(join(pipelines, ent.name)));
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** Every pipeline across every store key, newest-first, tagged with project. */
export async function listAllPipelines() {
  const root = storeRoot();
  let keys;
  try { keys = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const k of keys) {
    if (!k.isDirectory()) continue;
    const keyDir = join(root, k.name);
    let meta = null;
    try { meta = JSON.parse(await readFile(join(keyDir, 'meta.json'), 'utf8')); } catch { meta = null; }
    const pipelinesDir = join(keyDir, 'pipelines');
    let entries;
    try { entries = await readdir(pipelinesDir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const e = await pipelineEntry(join(pipelinesDir, ent.name));
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
