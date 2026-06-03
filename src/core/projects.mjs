// src/core/projects.mjs
// Named project registry: a small persistent list of { name, path } entries the
// web UI uses to populate its project dropdown. Stored as a JSON array at
// <MAESTRO_HOME or os.homedir()>/.maestro/projects.json.
//
// Reads never throw: a missing or corrupt file yields an empty list. Writes are
// atomic-ish (temp file + rename) and create ~/.maestro on demand.

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getMaestroRoot, defaultRoot } from './settings.mjs';

/**
 * Absolute path to the .maestro data directory. Base resolution precedence:
 *   1. MAESTRO_HOME env (non-empty)  — tests/smoke isolation + CLI override
 *   2. persisted Settings root        — the user-chosen "Maestro root folder"
 *   3. defaultRoot()                  — the OS home
 * Read fresh every call, so a saved root applies to new operations w/o restart.
 */
export function maestroHome() {
  const env = process.env.MAESTRO_HOME;
  const base = env && env.trim() ? env : (getMaestroRoot() || defaultRoot());
  return join(resolve(base), '.maestro');
}

/** Absolute path to the registry file. */
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
 * Read the raw registry array. Missing file or invalid JSON -> []. Never throws.
 * @returns {Promise<Array<{name:string, path:string}>>}
 */
async function readRaw() {
  try {
    const text = await readFile(projectsFile(), 'utf8');
    const data = JSON.parse(text);
    if (!Array.isArray(data)) return [];
    return data.filter((e) => e && typeof e.name === 'string' && typeof e.path === 'string');
  } catch {
    return [];
  }
}

/** Atomically write the registry array. Creates ~/.maestro if needed. */
async function writeRaw(list) {
  await mkdir(maestroHome(), { recursive: true });
  const file = projectsFile();
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

/**
 * List saved projects, each annotated with a runtime `exists` flag (true when
 * the path is an existing directory). The flag is computed, never persisted.
 * @returns {Promise<Array<{name:string, path:string, exists:boolean}>>}
 */
export async function listProjects() {
  const list = await readRaw();
  return list.map((e) => ({ name: e.name, path: e.path, exists: isDir(e.path) }));
}

/**
 * Add a project. Validates and persists. Returns the updated annotated list.
 * @param {{name:string, path:string}} input
 * @throws {Error} on empty name/path, duplicate name, or a path that exists but
 *   is not a directory.
 */
export async function addProject(input) {
  const name = (input && typeof input.name === 'string' ? input.name : '').trim();
  if (!name) throw new Error('project name is required');
  const path = normalizeProjectPath(input && input.path);
  if (!path) throw new Error('project path is required');
  // A path that exists must be a directory; a non-existent path is allowed (the
  // run creates it), matching the orchestrator's mkdir-on-run behavior.
  if (existsSync(path) && !isDir(path)) throw new Error('path is not a directory');

  const list = await readRaw();
  if (list.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`a project named "${name}" already exists`);
  }
  list.push({ name, path });
  await writeRaw(list);
  return listProjects();
}

/**
 * Remove a project by name (case-insensitive). Absent name is a no-op.
 * @param {string} name
 * @returns {Promise<Array<{name:string, path:string, exists:boolean}>>}
 */
export async function removeProject(name) {
  const key = (typeof name === 'string' ? name : '').trim().toLowerCase();
  const list = await readRaw();
  const next = list.filter((e) => e.name.toLowerCase() !== key);
  if (next.length !== list.length) await writeRaw(next);
  return listProjects();
}
