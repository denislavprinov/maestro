// src/core/workspaces.mjs
// Workspace registry: a small persistent list of named project sets (2+ onboarded
// git repos sharing one editable interconnection description). Stored as a JSON
// array at <maestroHome>/workspaces.json — a sibling of projects.json — reusing the
// exact temp+rename / never-throw discipline of projects.mjs.
//
// A workspace is a thin record (six persisted fields) plus a derived store namespace
// at store/workspaces/<workspaceKey>/. The key is derived ONCE at creation from the
// name slug + a sorted-canonical-roots hash, then frozen: rename never recomputes it
// (D1). projectKeys / exists[] are derived at read time and never persisted.
//
// Reads never throw: a missing or corrupt file yields []; per-entry filtering drops
// malformed records. Writes are atomic (temp file + rename) and create ~/.maestro on
// demand. Validation throws err(message, code) (mirrors pipeline-delete.mjs) so the
// server can map codes -> HTTP (BAD_REQUEST->400, DUPLICATE_*->409, NOT_FOUND->404).

import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

import { maestroHome, normalizeProjectPath } from './projects.mjs';
import { canonicalProjectRoot, projectKey, workspaceStorePath } from './store.mjs';
import { slugify } from './artifacts.mjs';

/** Object-shaped error carrying a machine code (mirrors pipeline-delete.mjs). */
function err(message, code) { return Object.assign(new Error(message), { code }); }

/**
 * The workspace-key shape: "wks-<slug>-<sha1[:8]>". The server imports this as
 * its single source of truth (M2 route validation), so core + route agree on one
 * invariant. Validating an id against it also forecloses any path-traversal: a
 * key matching this regex can never contain "/" or "..", so workspaceStorePath(id)
 * cannot escape the store namespace even before a registry-membership check.
 */
export const WORKSPACE_KEY_RE = /^wks-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$/;

/** Absolute path to the workspace registry file. Sibling of projects.json. */
export function workspacesFile() {
  return join(maestroHome(), 'workspaces.json');
}

/** True when the path exists and is a directory. */
function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * True when `p` is inside a git work tree (and a directory). Never throws.
 * Exported so the server's run-target loop can reject a member that exists but is
 * no longer a git repo (§2.6 step 3) using the SAME check createWorkspace applies.
 */
export function isGitRepo(p) {
  if (!isDir(p)) return false;
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'],
      { cwd: p, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch { return false; }
}

/**
 * Roots-only dedupe hash (D1): sha1 of the sorted canonical roots, joined by "\n",
 * sliced to 8 hex. Name-independent and order-independent, so it identifies a
 * project SET regardless of the workspace's name or the input ordering.
 * @param {string[]} projectPaths
 * @returns {string} 8 hex chars
 */
export function rootsHash(projectPaths) {
  const roots = (Array.isArray(projectPaths) ? projectPaths : [])
    .map((p) => canonicalProjectRoot(p))
    .sort();
  return createHash('sha1').update(roots.join('\n')).digest('hex').slice(0, 8);
}

/**
 * Stable workspace key == id: "wks-" + slugify(name) + "-" + rootsHash(paths).
 * The wks- prefix guarantees no collision with any projectKey in the same store.
 * @param {{name:string, projectPaths:string[]}} ws
 * @returns {string}
 */
export function workspaceKey(ws) {
  const name = ws && typeof ws.name === 'string' ? ws.name : '';
  const paths = ws && Array.isArray(ws.projectPaths) ? ws.projectPaths : [];
  return `wks-${slugify(name)}-${rootsHash(paths)}`;
}

/** True for a record that has the exactly-six-field persisted shape (loose). */
function isValidEntry(e) {
  return (
    e && typeof e === 'object' &&
    typeof e.id === 'string' &&
    typeof e.name === 'string' &&
    typeof e.description === 'string' &&
    Array.isArray(e.projectPaths) &&
    e.projectPaths.length >= 2 &&
    e.projectPaths.every((p) => typeof p === 'string')
  );
}

/**
 * Read the raw registry array. Missing file / invalid JSON -> []; malformed
 * records are dropped. Never throws.
 * @returns {Promise<Array<object>>}
 */
async function readRaw() {
  try {
    const text = await readFile(workspacesFile(), 'utf8');
    const data = JSON.parse(text);
    if (!Array.isArray(data)) return [];
    return data.filter(isValidEntry).map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      projectPaths: e.projectPaths.slice(),
      createdAt: typeof e.createdAt === 'string' ? e.createdAt : '',
      updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : '',
    }));
  } catch {
    return [];
  }
}

/** Atomically write the registry array. Creates ~/.maestro if needed. */
async function writeRaw(list) {
  await mkdir(maestroHome(), { recursive: true });
  const file = workspacesFile();
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

/**
 * Annotate a persisted entry with read-time derived fields:
 *   projectKeys (sorted ascending, index-aligned with the returned projectPaths)
 *   exists[]    (per-path on-disk presence)
 * Neither is ever persisted. projectPaths is re-ordered to align with the sorted
 * projectKeys so callers get the canonical member ordering used everywhere.
 */
function annotate(entry) {
  const pairs = entry.projectPaths.map((p) => ({ path: p, key: projectKey(p) }));
  pairs.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    projectPaths: pairs.map((x) => x.path),
    projectKeys: pairs.map((x) => x.key),
    exists: pairs.map((x) => isDir(x.path)),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/**
 * List saved workspaces, each annotated with derived projectKeys/exists.
 * @returns {Promise<Array<{id,name,description,projectPaths,projectKeys,exists:boolean[],createdAt,updatedAt}>>}
 */
export async function listWorkspaces() {
  const list = await readRaw();
  return list.map(annotate);
}

/**
 * Read one workspace by id, annotated. Returns null when absent.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function readWorkspace(id) {
  if (!id || typeof id !== 'string') return null;
  const list = await readRaw();
  const hit = list.find((e) => e.id === id);
  return hit ? annotate(hit) : null;
}

/**
 * Normalize + de-dupe member paths by canonical root. Returns the normalized
 * absolute paths in input order, with later paths that resolve to an
 * already-seen canonical root dropped.
 */
function normalizeMembers(projectPaths) {
  const out = [];
  const seenRoots = new Set();
  for (const raw of Array.isArray(projectPaths) ? projectPaths : []) {
    const norm = normalizeProjectPath(raw);
    if (!norm) continue;
    const root = canonicalProjectRoot(norm);
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    out.push(norm);
  }
  return out;
}

/**
 * Create a workspace. Validates name (non-empty + unique case-insensitive),
 * a 2+ distinct-git-repo member set (de-duped by canonical root), and a unique
 * project set (D1, by rootsHash). Persists EXACTLY the six fields; the id is the
 * derived workspaceKey, computed once and frozen. Returns the annotated entry.
 * @param {{name:string, projectPaths:string[], description?:string}} input
 * @throws err(code: BAD_REQUEST | DUPLICATE_NAME | DUPLICATE_SET)
 */
export async function createWorkspace(input = {}) {
  const name = (input && typeof input.name === 'string' ? input.name : '').trim();
  if (!name) throw err('workspace name is required', 'BAD_REQUEST');
  const description = typeof input.description === 'string' ? input.description : '';

  const members = normalizeMembers(input.projectPaths);
  if (members.length < 2) {
    throw err('a workspace needs at least 2 distinct member projects', 'BAD_REQUEST');
  }
  for (const p of members) {
    if (!isDir(p)) throw err(`member path does not exist or is not a directory: ${p}`, 'BAD_REQUEST');
    if (!isGitRepo(p)) throw err(`member path is not a git repository: ${p}`, 'BAD_REQUEST');
  }

  const list = await readRaw();
  if (list.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
    throw err(`a workspace named "${name}" already exists`, 'DUPLICATE_NAME');
  }
  const hash = rootsHash(members);
  if (list.some((e) => rootsHash(e.projectPaths) === hash)) {
    throw err('a workspace over this exact project set already exists', 'DUPLICATE_SET');
  }

  const now = new Date().toISOString();
  // projectPaths is PERSISTED in input order; annotate() returns it sorted by
  // projectKey (the canonical read-time view), so persisted vs returned order
  // intentionally differ. The id is order-independent regardless (rootsHash sorts).
  const entry = {
    id: workspaceKey({ name, projectPaths: members }),
    name,
    description,
    projectPaths: members,
    createdAt: now,
    updatedAt: now,
  };
  list.push(entry);
  await writeRaw(list);
  return annotate(entry);
}

/**
 * Update a workspace's name and/or description. NEVER touches projectPaths (the
 * project set is immutable) and NEVER recomputes the id (D1). Re-validates a new
 * name for case-insensitive uniqueness. Stamps updatedAt.
 * @param {string} id
 * @param {{name?:string, description?:string}} patch
 * @throws err(code: NOT_FOUND | BAD_REQUEST | DUPLICATE_NAME)
 */
export async function updateWorkspace(id, patch = {}) {
  const list = await readRaw();
  const idx = list.findIndex((e) => e.id === id);
  if (idx < 0) throw err(`workspace not found: ${id}`, 'NOT_FOUND');
  const entry = list[idx];

  if (patch && typeof patch.name === 'string') {
    const name = patch.name.trim();
    if (!name) throw err('workspace name is required', 'BAD_REQUEST');
    const clash = list.some((e, i) => i !== idx && e.name.toLowerCase() === name.toLowerCase());
    if (clash) throw err(`a workspace named "${name}" already exists`, 'DUPLICATE_NAME');
    entry.name = name;
  }
  if (patch && typeof patch.description === 'string') {
    // Cap-on-freeze, not cap-on-store: the editable text is persisted whole.
    entry.description = patch.description;
  }
  entry.updatedAt = new Date().toISOString();
  await writeRaw(list);
  return annotate(entry);
}

/** Thin setter: edit only the description. */
export async function updateWorkspaceDescription(id, text) {
  return updateWorkspace(id, { description: typeof text === 'string' ? text : '' });
}

/** Thin setter: rename only. Never recomputes the id (D1). */
export async function renameWorkspace(id, name) {
  return updateWorkspace(id, { name: typeof name === 'string' ? name : '' });
}

/**
 * Delete a workspace: remove the store/workspaces/<key>/ directory (best-effort)
 * and the registry entry. The module has no runs map — the live-run 409 guard
 * lives in the server route.
 *
 * Self-guarded (defense-in-depth; the server's WORKSPACE_ID_RE is not the only
 * line of defense): the id MUST match the workspace-key shape, and the entry MUST
 * already exist in the registry, before anything is removed. A bad/crafted id
 * (e.g. "../.." or "../../store/x") never reaches the rm — it throws NOT_FOUND, so
 * a malformed id reads as "not found" and deletes nothing outside the namespace.
 * @param {string} id
 * @returns {Promise<{ok:true, warnings:string[]}>}
 * @throws err(code: NOT_FOUND) for a malformed or unknown id
 */
export async function deleteWorkspace(id) {
  if (!id || typeof id !== 'string' || !WORKSPACE_KEY_RE.test(id)) {
    throw err(`workspace not found: ${id}`, 'NOT_FOUND');
  }
  // Membership-first: only remove the store dir for an id actually in the registry.
  const list = await readRaw();
  const next = list.filter((e) => e.id !== id);
  if (next.length === list.length) {
    throw err(`workspace not found: ${id}`, 'NOT_FOUND');
  }

  const warnings = [];
  try {
    await rm(workspaceStorePath(id), { recursive: true, force: true });
  } catch (e) {
    warnings.push(`store cleanup failed: ${e && e.message ? e.message : 'error'}`);
  }
  try { await writeRaw(next); }
  catch (e) { warnings.push(`registry write failed: ${e && e.message ? e.message : 'error'}`); }

  return { ok: true, warnings };
}
