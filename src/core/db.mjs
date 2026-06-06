// src/core/db.mjs
// Singleton SQLite database for all of Maestro's structured state. Uses the
// built-in, SYNCHRONOUS node:sqlite (DatabaseSync) — matching the existing
// synchronous maestroHome()/getMaestroRoot() resolution, so no async refactor is
// needed anywhere. The DB lives at <maestroHome>/maestro.db (WAL), resolved fresh
// on first open via projects.mjs#maestroHome() (MAESTRO_HOME env > settings.json
// root > OS home), exactly like every other module's data path.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { maestroHome } from './projects.mjs';

let _db = null; // the singleton handle, or null when closed/never-opened

/** WAL busy-timeout: wait up to 5s for a competing writer (CLI + UI). */
const BUSY_TIMEOUT_MS = 5000;

/** Absolute path to the database file: <maestroHome>/maestro.db. */
export function dbPath() {
  return join(maestroHome(), 'maestro.db');
}

/**
 * Open (lazily) and return the singleton DatabaseSync. First open creates
 * <maestroHome> if needed and opens the file. (Pragmas + migrate + fs→db hook are
 * layered on in later tasks of this phase.)
 * @returns {DatabaseSync}
 */
export function getDb() {
  if (_db) return _db;
  const home = maestroHome();
  mkdirSync(home, { recursive: true }); // chicken/egg: ensure the dir before open
  const db = new DatabaseSync(dbPath());
  _configure(db);
  _db = db;
  return _db;
}

/**
 * Apply the connection pragmas exactly once on open. journal_mode=WAL is durable
 * (sticks to the file); foreign_keys/busy_timeout/synchronous are per-connection
 * and must be re-applied every open. Done via exec() in one batch.
 */
function _configure(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
    PRAGMA synchronous = NORMAL;
  `);
}

/** Close the singleton handle (no-op when already closed). */
export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ── placeholders, fully implemented in Tasks 1.4–1.5 ───────────────────────────
export function prepare(sql) { void sql; throw new Error('prepare(): implemented in Task 1.5'); }
export function tx(fn) { void fn; throw new Error('tx(): implemented in Task 1.4'); }
export function _resetForTests() { closeDb(); }
