// src/core/artifacts.mjs
// Filesystem layout, naming, and pipeline persistence/audit helpers.
//
// All paths returned are absolute and rooted at <projectDir>/ai-artifacts.
// Pipelines are self-describing: each gets a directory containing the prompt,
// any extra files, a human-readable audit log (pipeline.md), and machine state
// (state.json).

import { mkdir, writeFile, readFile, copyFile, readdir, stat, appendFile } from 'node:fs/promises';
import { join, basename, resolve, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';

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
 * Absolute artifact directory paths under <projectDir>/ai-artifacts.
 * @param {string} projectDir
 * @returns {{root:string, plans:string, reviews:string, pipelines:string}}
 */
export function artifactPaths(projectDir) {
  const root = join(resolve(projectDir), 'ai-artifacts');
  return {
    root,
    plans: join(root, 'plans'),
    reviews: join(root, 'reviews'),
    pipelines: join(root, 'pipelines'),
  };
}

/**
 * Ensure every artifact directory exists.
 * @param {string} projectDir
 * @returns {Promise<{root:string, plans:string, reviews:string, pipelines:string}>}
 */
export async function ensureArtifactDirs(projectDir) {
  const p = artifactPaths(projectDir);
  await mkdir(p.plans, { recursive: true });
  await mkdir(p.reviews, { recursive: true });
  await mkdir(p.pipelines, { recursive: true });
  return p;
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
 * List all pipelines for a project, newest first.
 * Each entry: { id, dir, title, status, startedAt, mtime }.
 * Directories without a readable state.json fall back to filesystem metadata.
 * @param {string} projectDir
 * @returns {Promise<Array>}
 */
export async function listPipelines(projectDir) {
  const { pipelines } = artifactPaths(projectDir);
  let entries;
  try {
    entries = await readdir(pipelines, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = join(pipelines, ent.name);
    let mtime = 0;
    try {
      mtime = (await stat(dir)).mtimeMs;
    } catch {
      /* ignore */
    }
    let state = null;
    try {
      state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    } catch {
      state = null;
    }
    out.push({
      id: state?.id ?? ent.name,
      dir,
      title: state?.title ?? ent.name,
      status: state?.status ?? 'unknown',
      startedAt: state?.startedAt ?? null,
      totalCostUsd: typeof state?.totalCostUsd === 'number' ? state.totalCostUsd : null,
      mtime,
    });
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
