// src/core/settings.mjs
// Global Maestro settings, persisted at a FIXED bootstrap location that never
// moves: <home>/.maestro/settings.json. The only setting today is `root` — the
// base folder under which Maestro keeps its .maestro data dir (history store,
// projects.json, workflows). projects.mjs#maestroHome() reads this to resolve
// where everything lives.
//
// node:sqlite migration note: `root` deliberately stays here in settings.json and
// is NOT moved into the DB — it is the bootstrap that LOCATES the DB file
// (maestroHome()/maestro.db), so it cannot live inside the DB (chicken/egg). The
// v1 schema has no settings table by design (YAGNI: root is the only setting).
//
// IMPORTANT: this module imports NOTHING from the core graph (Node builtins
// only). projects.mjs imports it, so importing projects.mjs back would make
// maestroHome() -> getMaestroRoot() -> projects.mjs an infinite cycle.
//
// Reads are synchronous + never-throwing (maestroHome's callers are sync). There
// is deliberately no in-module cache: maestroHome() is read fresh per operation,
// so a saved root takes effect for new runs/listing without a server restart.

import { mkdir, writeFile, rename } from 'node:fs/promises';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

/**
 * The real OS home base, honoring HOME/USERPROFILE so tests can sandbox it.
 * This is the DEFAULT Maestro root when nothing is configured, and the parent
 * of the fixed settings file. (Mirrors normalizeProjectPath's tilde idiom.)
 */
export function defaultRoot() {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

/** Fixed bootstrap path — ALWAYS under defaultRoot(), never the movable root. */
export function settingsFile() {
  return join(defaultRoot(), '.maestro', 'settings.json');
}

/** Read settings synchronously. Missing/corrupt/non-object -> {}. Never throws. */
export function readSettings() {
  try {
    const data = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** The configured root base, or '' when unset/blank. Synchronous, never throws. */
export function getMaestroRoot() {
  const r = readSettings().root;
  return typeof r === 'string' && r.trim() ? r : '';
}

function expandTilde(p) {
  return p.startsWith('~') ? join(defaultRoot(), p.slice(1)) : p;
}

/**
 * Persist the chosen root base. Pass '' / null / non-string to CLEAR it (reset
 * to default). A non-empty value is resolved to an absolute path and validated:
 * it must not be an existing non-directory, and <base>/.maestro must be
 * creatable (this both validates writability and pre-creates the dir). Atomic
 * temp+rename. Returns { root, default } describing the resulting state.
 * @throws {Error} when the path cannot be used as a root.
 */
export async function setMaestroRoot(input) {
  await mkdir(join(defaultRoot(), '.maestro'), { recursive: true }); // bootstrap dir
  const raw = typeof input === 'string' ? input.trim() : '';
  const settings = readSettings();

  if (!raw) {
    delete settings.root; // reset to default
  } else {
    const base = resolve(expandTilde(raw));
    if (existsSync(base) && !statSync(base).isDirectory()) {
      throw new Error('path is not a directory');
    }
    try {
      await mkdir(join(base, '.maestro'), { recursive: true });
    } catch (err) {
      throw new Error(`cannot use this folder as the Maestro root: ${err.message}`);
    }
    settings.root = base;
  }

  const file = settingsFile();
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
  return { root: settings.root || '', default: defaultRoot() };
}
