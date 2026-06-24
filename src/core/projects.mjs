// src/core/projects.mjs
// Named project registry: a small persistent list of { name, path } entries the
// web UI uses to populate its project dropdown.
//
// node:sqlite migration: now persisted in the `projects` table; path helpers vestigial.
//
// Reads never throw: a fresh/empty DB yields an empty list. Writes validate then
// persist inside a single db.mjs tx(). Each row is keyed by projectKey(path)
// (store.mjs), so every worktree of a repo maps to one row.

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getMaestroRoot, defaultRoot } from './settings.mjs';
import { getDb, prepare, tx } from './db.mjs';
import { projectKey } from './store.mjs';

/**
 * Absolute path to the .maestro data directory. Base resolution precedence:
 *   1. MAESTRO_HOME env (non-empty)  — tests/smoke isolation + CLI override
 *   2. persisted Settings root        — the user-chosen "Maestro root folder"
 *   3. defaultRoot()                  — the OS home
 * Read fresh every call, so a saved root applies to new operations w/o restart.
 */
export function maestroHome() {
  const env = process.env.MAESTRO_HOME;
  if (!(env && env.trim()) && process.env.NODE_TEST_CONTEXT &&
      !process.env.MAESTRO_TEST_ALLOW_HOME_FALLBACK) {
    // Under the node:test runner the real ~/.maestro must be unreachable: a test
    // (or a fire-and-forget write outliving its teardown) that resolves the home
    // with no MAESTRO_HOME set would silently pollute the user's real store.
    // MAESTRO_TEST_ALLOW_HOME_FALLBACK opts out for tests that exercise the
    // settings/home fallback tiers and sandbox HOME/USERPROFILE themselves.
    throw new Error(
      'maestroHome(): MAESTRO_HOME is unset under the node:test runner — ' +
      'tests must never touch the real ~/.maestro (use test/helpers/temp-home.mjs#useTempHome)'
    );
  }
  const base = env && env.trim() ? env : (getMaestroRoot() || defaultRoot());
  return join(resolve(base), '.maestro');
}

/**
 * Absolute path to the (legacy) registry file.
 *
 * VESTIGIAL (node:sqlite migration §0.6): the registry now lives in the `projects`
 * table, not this JSON file. This export is retained only for backward
 * import-compatibility (test imports); it no longer describes where data lives.
 */
export function projectsFile() {
  return join(maestroHome(), 'projects.json');
}

/**
 * Expand a leading ~ and resolve to an absolute path. Mirrors the web server's
 * historical resolveProjectDir so the registry and runs agree on a path.
 * @param {string} input
 * @returns {string|null} absolute path, or null for empty/non-string input
 */
export function normalizeProjectPath(input) {
  if (!input || typeof input !== 'string' || !input.trim()) return null;
  let p = input.trim();
  if (p.startsWith('~')) p = join(process.env.HOME || process.env.USERPROFILE || '', p.slice(1));
  return resolve(p);
}

/** True when the path exists and is a directory. */
function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read the raw registry rows from the DB, ordered by creation then name for a
 * stable list. Never throws (a fresh DB simply has no rows). The DB call is
 * synchronous (node:sqlite); we return the plain array.
 * @returns {Array<{key:string, name:string, path:string}>}
 */
function readRows() {
  getDb(); // ensure the singleton is open + migrated before preparing
  return prepare(
    'SELECT key, name, path FROM projects ORDER BY created_at, name'
  ).all();
}

/**
 * List saved projects, each annotated with a runtime `exists` flag (true when the
 * path is an existing directory). The flag is computed, never persisted. Reads
 * from the projects table; never throws.
 * @returns {Promise<Array<{name:string, path:string, exists:boolean}>>}
 */
export async function listProjects() {
  return readRows().map((e) => ({ name: e.name, path: e.path, exists: isDir(e.path) }));
}

/**
 * Number of registered projects (missing-on-disk rows included, matching the
 * Projects list + its sidebar count). Cheap COUNT(*); never throws.
 * Uses the bare `prepare` already imported at projects.mjs:14.
 * @returns {number}
 */
export function countProjects() {
  getDb(); // ensure the singleton is open + migrated before preparing
  const row = prepare('SELECT COUNT(*) AS n FROM projects').get();
  return row ? Number(row.n) : 0;
}

/**
 * Add a project. Validates and persists to the projects table. Returns the
 * updated annotated list. Keyed by projectKey(path) (store.mjs), so every worktree
 * of a repo maps to one row. Name uniqueness is case-insensitive (checked here AND
 * backed by the NOCASE unique index).
 * @param {{name:string, path:string}} input
 * @throws {Error} on empty name/path, a path that exists but is not a directory,
 *   a duplicate name (case-insensitive), or a duplicate path/key.
 */
export async function addProject(input) {
  const name = (input && typeof input.name === 'string' ? input.name : '').trim();
  if (!name) throw new Error('project name is required');
  const path = normalizeProjectPath(input && input.path);
  if (!path) throw new Error('project path is required');
  // A path that exists must be a directory; a non-existent path is allowed (the run
  // creates it), matching the orchestrator's mkdir-on-run behavior.
  if (existsSync(path) && !isDir(path)) throw new Error('path is not a directory');

  const key = projectKey(path);
  const createdAt = new Date().toISOString();
  tx(() => {
    // Case-insensitive duplicate-name guard (matches the legacy check + the index).
    const clash = prepare('SELECT 1 FROM projects WHERE name = ? COLLATE NOCASE').get(name);
    if (clash) throw new Error(`a project named "${name}" already exists`);
    // Same path -> same key -> PK collision; report it cleanly rather than crashing.
    const samePath = prepare('SELECT 1 FROM projects WHERE key = ?').get(key);
    if (samePath) throw new Error('this project path is already registered');
    prepare(
      'INSERT INTO projects (key, name, path, created_at) VALUES (?, ?, ?, ?)'
    ).run(key, name, path, createdAt);
  });
  return listProjects();
}

/**
 * Remove a project by name (case-insensitive). Absent name is a no-op.
 * @param {string} name
 * @returns {Promise<Array<{name:string, path:string, exists:boolean}>>}
 */
export async function removeProject(name) {
  const key = (typeof name === 'string' ? name : '').trim();
  if (key) {
    tx(() => {
      prepare('DELETE FROM projects WHERE name = ? COLLATE NOCASE').run(key);
    });
  }
  return listProjects();
}

/**
 * Rename a project. Identified by its CURRENT name (case-insensitive); only the
 * display `name` changes — the row key (derived from path) and every path/key
 * reference (workspaces, runs, worktrees) are untouched, so nothing else breaks.
 * @param {string} oldName  current name (case-insensitive)
 * @param {string} newName  new name
 * @returns {Promise<Array<{name:string, path:string, exists:boolean}>>}
 * @throws {Error} on empty newName, an unknown oldName, or a name that collides
 *   (case-insensitive) with a DIFFERENT project.
 */
export async function renameProject(oldName, newName) {
  const from = (typeof oldName === 'string' ? oldName : '').trim();
  const to = (typeof newName === 'string' ? newName : '').trim();
  if (!from) throw new Error('current project name is required');
  if (!to) throw new Error('new project name is required');
  tx(() => {
    const row = prepare('SELECT key FROM projects WHERE name = ? COLLATE NOCASE').get(from);
    if (!row) throw new Error(`no project named "${from}"`);
    // Collision only with a DIFFERENT row (a pure case-change of the same project
    // keeps its own key and is allowed).
    const clash = prepare(
      'SELECT 1 FROM projects WHERE name = ? COLLATE NOCASE AND key <> ?'
    ).get(to, row.key);
    if (clash) throw new Error(`a project named "${to}" already exists`);
    prepare('UPDATE projects SET name = ? WHERE key = ?').run(to, row.key);
  });
  return listProjects();
}
