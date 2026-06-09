// src/core/db.mjs
// Singleton SQLite database for all of Maestro's structured state. Uses the
// built-in, SYNCHRONOUS node:sqlite (DatabaseSync) — matching the existing
// synchronous maestroHome()/getMaestroRoot() resolution, so no async refactor is
// needed anywhere. The DB lives at <maestroHome>/maestro.db (WAL), resolved fresh
// on first open via projects.mjs#maestroHome() (MAESTRO_HOME env > settings.json
// root > OS home), exactly like every other module's data path.
//
// node:sqlite is loaded LAZILY (synchronous createRequire, like preflight-node.mjs)
// inside databaseSyncCtor() rather than via a top-level `import`. A top-level import
// is linked when the whole static ESM graph links — BEFORE any entry-point statement
// runs — so node:sqlite's one-time ExperimentalWarning would fire before the entry
// points (src/cli/maestro.mjs, ui/server.mjs) install their `process.on('warning')`
// filter, leaking the warning on flagless direct-bin runs. Deferring the load to the
// first getDb() (which only happens at runtime, after the filter is installed) lets
// the filter suppress it. createRequire keeps the load SYNCHRONOUS — `await import`
// would make getDb() async and break the synchronous data layer.

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { maestroHome } from './projects.mjs';
import { maybeMigrateFromFs } from './migrate-fs-to-db.mjs';

const _require = createRequire(import.meta.url);
let _DatabaseSync; // cached node:sqlite DatabaseSync ctor (lazy-loaded once)

/**
 * Lazily and SYNCHRONOUSLY resolve the node:sqlite DatabaseSync constructor. The
 * load is deferred out of module-link time (see header) so the entry points can
 * install their ExperimentalWarning filter first; node:sqlite is a builtin so
 * createRequire resolves it synchronously even from this ESM module.
 * @returns {typeof import('node:sqlite').DatabaseSync}
 */
function databaseSyncCtor() {
  if (!_DatabaseSync) ({ DatabaseSync: _DatabaseSync } = _require('node:sqlite'));
  return _DatabaseSync;
}

let _db = null; // the singleton handle, or null when closed/never-opened
let _txDepth = 0; // guards against re-entrant tx(): node:sqlite has no nested BEGIN
let _stmtCache = new Map(); // sql text -> cached StatementSync (per open handle)

/** WAL busy-timeout: wait up to 5s for a competing writer (CLI + UI). */
const BUSY_TIMEOUT_MS = 5000;

/** First-launch open retries (spec §8): a competing process can make the journal_mode=
 *  WAL switch or the schema migration return SQLITE_BUSY that the busy-handler will not
 *  itself retry. Bounded retry with a short synchronous backoff covers it. */
const OPEN_RETRY_LIMIT = 100;
const OPEN_BACKOFF_MS = 15;

/** Latest schema version. Bump + append a new migration step when the DDL grows. */
const SCHEMA_VERSION = 4;

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
  const db = _openConfiguredMigrated();  // open + pragmas + migrate, retried on BUSY
  maybeMigrateFromFs(db);    // one-shot fs→db import (other phase; self-guarded)
  _db = db;                  // publish only after the DB is fully ready
  return _db;
}

/**
 * Open the DB file, apply pragmas, and migrate — retrying the whole sequence on a
 * transient SQLITE_BUSY / "database is locked". First launch can race a second process
 * (CLI + UI, spec §8): the journal_mode=WAL header switch and the schema migration each
 * need a brief exclusive lock, and the WAL-mode switch in particular returns BUSY that
 * the busy-handler does NOT retry. A bounded synchronous retry makes concurrent first
 * launch deterministic. node:sqlite is sync, so the backoff blocks this thread inline.
 */
function _openConfiguredMigrated() {
  for (let attempt = 0; ; attempt++) {
    let db = null;
    try {
      db = new (databaseSyncCtor())(dbPath());
      _configure(db);
      migrate(db);
      return db;
    } catch (err) {
      try { if (db) db.close(); } catch { /* ignore close error during recovery */ }
      if (_isBusyError(err) && attempt < OPEN_RETRY_LIMIT) { _sleepMs(OPEN_BACKOFF_MS); continue; }
      throw err;
    }
  }
}

/**
 * True when err is a transient SQLite lock/busy that retrying can clear. Prefers the
 * structured errcode (5 = SQLITE_BUSY, 6 = SQLITE_LOCKED) and falls back to the message
 * so a lock is still caught on any node:sqlite build that doesn't populate errcode. A
 * false positive only costs a bounded retry that still re-throws the original error.
 */
function _isBusyError(err) {
  if (err && (err.errcode === 5 || err.errcode === 6)) return true;
  const msg = err && err.message ? err.message : String(err);
  return /locked|busy/i.test(msg);
}

/** Synchronous sleep (node:sqlite is sync; we must block this thread, not yield it). */
function _sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Apply the connection pragmas exactly once on open. journal_mode=WAL is durable
 * (sticks to the file); foreign_keys/busy_timeout/synchronous are per-connection
 * and must be re-applied every open. Done via exec() in one batch.
 */
function _configure(db) {
  // busy_timeout is set FIRST so the busy-handler is armed before the first contended
  // operation. NOTE: this only REDUCES (does not eliminate) the journal_mode=WAL switch
  // race — SQLite does not run the busy-handler for the WAL-mode switch, so a colliding
  // first-launch process can still get "database is locked" here. The actual backstop is
  // the open-retry loop in _openConfiguredMigrated(); do NOT remove it on the assumption
  // that pragma ordering alone suffices.
  db.exec(`
    PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = NORMAL;
  `);
}

/**
 * The FULL, FINAL v1 schema (SQLITE-MIGRATION-SPEC §3). Applied in one transaction
 * by migrate(). All "JSON" columns are TEXT holding a JSON string (SQLite has no
 * JSON type); the owning service modules (de)serialize at their API boundary.
 * COLLATE NOCASE is applied where the spec requires case-insensitive uniqueness
 * (projects.name, workspaces.name), matching the existing duplicate checks.
 */
const SCHEMA_V1 = `
-- projects: the named project registry (was projects.json: [{name,path}]).
-- key is the stable projectKey (store.mjs). name is case-insensitively unique.
CREATE TABLE projects (
  key        TEXT PRIMARY KEY,
  name       TEXT NOT NULL COLLATE NOCASE,
  path       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_projects_name ON projects (name COLLATE NOCASE);

-- workspaces: named sets of 2+ projects (was workspaces.json header fields).
-- id is the frozen workspaceKey (wks-<slug>-<sha1[:8]>). name is CI-unique.
CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_workspaces_name ON workspaces (name COLLATE NOCASE);

-- workspace_projects: the ordered projectPaths[] of a workspace (was the array).
-- ordinal preserves the PERSISTED member order; (workspace_id, ordinal) is the PK.
-- project_key holds the ABSOLUTE member PATH (ordinal-ordered), NOT a key (A1);
-- the real projectKey is recomputed on read via store.projectKey(path) (one-way
-- hash). projectKeys/exists are derived on read (not stored), per
-- workspaces.mjs#annotate.
CREATE TABLE workspace_projects (
  workspace_id TEXT NOT NULL,
  project_key  TEXT NOT NULL,
  ordinal      INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, ordinal),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
);

-- workflows: user workflow templates (was workflows/<id>.json). DEFAULT_WORKFLOW
-- stays built-in (not a row). steps/feedbacks are JSON (topology arrays).
CREATE TABLE workflows (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  steps      TEXT NOT NULL DEFAULT '[]',  -- JSON: [[ {id,key} ]]
  feedbacks  TEXT NOT NULL DEFAULT '[]',  -- JSON: [ {id,from,to} ]
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- project_config: per-project model/effort selection (was <projectDir>/.maestro/
-- config.json). steps/custom_models are JSON (the legacy {steps,customModels}
-- view). active_workflow_id remembers the last New-Pipeline choice. extra is JSON
-- preserving unknown top-level keys (e.g. webUiTesting).
CREATE TABLE project_config (
  project_key        TEXT PRIMARY KEY,
  steps              TEXT NOT NULL DEFAULT '{}',  -- JSON: { role: {model?,effort?,fanOut?} }
  custom_models      TEXT NOT NULL DEFAULT '[]',  -- JSON: [ {id,label} ]
  active_workflow_id TEXT,
  extra              TEXT NOT NULL DEFAULT '{}'   -- JSON: unknown top-level keys
);

-- config_workflow_nodes: normalized per-node overrides (was config.json
-- workflows[wf].nodes[nodeId] = {model?,effort?,fanOut?}). One row per node.
CREATE TABLE config_workflow_nodes (
  project_key TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  model       TEXT,
  effort      TEXT,
  fan_out     INTEGER,  -- nullable boolean (0/1); NULL = inherit
  PRIMARY KEY (project_key, workflow_id, node_id)
);

-- config_workflow_feedbacks: normalized feedback cycle counts (was config.json
-- workflows[wf].feedbacks[fbId] = {maxCycles}). max_cycles is an integer >= 1.
CREATE TABLE config_workflow_feedbacks (
  project_key TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  fb_id       TEXT NOT NULL,
  max_cycles  INTEGER NOT NULL,
  PRIMARY KEY (project_key, workflow_id, fb_id)
);

-- pipelines: one run = one row (was state.json, scalar fields). workspace_key is
-- the composite "workspaces/<key>" tag for workspace runs (NULL for single-project).
-- target is 'project' | 'workspace'. date_prefix/base_name link plan/review md
-- files (pipeline-delete.mjs#deriveNames). branch/workspace_meta/stepper/tools are
-- JSON (objects/manifests). prompt is the resolved prompt body.
CREATE TABLE pipelines (
  id              TEXT PRIMARY KEY,
  project_key     TEXT NOT NULL,
  workspace_key   TEXT,
  target          TEXT NOT NULL DEFAULT 'project',
  title           TEXT,
  base_name       TEXT,
  date_prefix     TEXT,
  status          TEXT NOT NULL DEFAULT 'created',
  phase           TEXT NOT NULL DEFAULT 'created',
  cycle           INTEGER NOT NULL DEFAULT 0,
  started_at      TEXT,
  updated_at      TEXT,
  total_cost_usd  REAL NOT NULL DEFAULT 0,
  total_active_ms INTEGER NOT NULL DEFAULT 0,
  prompt          TEXT,
  branch          TEXT,  -- JSON: { source, feature, worktreeDir, reusedExisting, ... }
  workspace_meta  TEXT,  -- JSON: { workspaceId, workspaceName, projectKeys, projects[], checkpointRefs, branches, workspaceDescription }
  stepper         TEXT,  -- JSON: buildStepperManifest() snapshot
  tools           TEXT   -- JSON: detectTools()/resolved tool descriptor
);
CREATE INDEX idx_pipelines_project_started   ON pipelines (project_key, started_at);
CREATE INDEX idx_pipelines_workspace_started ON pipelines (workspace_key, started_at);
CREATE INDEX idx_pipelines_status            ON pipelines (status);

-- pipeline_steps: one row per state.steps[] entry (orchestrator _nodeStep/
-- _recordStep). key is the stable step key "<stepIndex>:<nodeId>[#cycle]".
-- running_since is the resume timestamp (null when paused); active_ms accumulates.
CREATE TABLE pipeline_steps (
  pipeline_id   TEXT NOT NULL,
  key           TEXT NOT NULL,
  node_id       TEXT,
  phase         TEXT,
  step_index    INTEGER,
  cycle         INTEGER,
  status        TEXT,
  started_at    TEXT,
  updated_at    TEXT,
  active_ms     INTEGER NOT NULL DEFAULT 0,
  running_since TEXT,
  cost_usd      REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (pipeline_id, key),
  FOREIGN KEY (pipeline_id) REFERENCES pipelines (id) ON DELETE CASCADE
);

-- pipeline_events: append-only audit trail (was pipeline.md timeline lines, one
-- "- \`<ISO ts>\` <text>" per appendAudit call). id AUTOINCREMENT preserves order.
CREATE TABLE pipeline_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_id TEXT NOT NULL,
  ts          TEXT NOT NULL,
  text        TEXT NOT NULL,
  FOREIGN KEY (pipeline_id) REFERENCES pipelines (id) ON DELETE CASCADE
);
CREATE INDEX idx_pipeline_events_pipeline ON pipeline_events (pipeline_id, id);

-- clarify: one row per pipeline (was clarify.json + clarify-answers.json).
-- questions/answers are JSON ({questions:[...]} / {answers:[...]} payloads).
CREATE TABLE clarify (
  pipeline_id TEXT PRIMARY KEY,
  questions   TEXT,  -- JSON: { questions: [ {id,question,options[3],allowFreeText} ] }
  answers     TEXT,  -- JSON: { answers: [ {id,question,choice} ] }
  FOREIGN KEY (pipeline_id) REFERENCES pipelines (id) ON DELETE CASCADE
);

-- reviews: per-cycle review verdicts (was *-review-cycleN.json). kind is one of
-- refine|impl|plan|ws|webui (5-value open set, A2); verdict is JSON {issues:[...],summary}.
CREATE TABLE reviews (
  pipeline_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  cycle       INTEGER NOT NULL,
  verdict     TEXT,  -- JSON: { issues:[{severity,title,detail,location}], summary }
  PRIMARY KEY (pipeline_id, kind, cycle),
  FOREIGN KEY (pipeline_id) REFERENCES pipelines (id) ON DELETE CASCADE
);

-- store_meta: per-project / per-workspace meta.json (artifacts.mjs ensureMeta/
-- ensureWorkspaceMeta). key is the store key; kind is 'project' | 'workspace';
-- data is the full meta JSON ({key,path,name,firstSeenAt} or the workspace shape).
CREATE TABLE store_meta (
  key  TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  data TEXT NOT NULL  -- JSON: the meta.json object
);

-- artifacts: NEW index of the FS markdown + extras paths kept on disk after the
-- migration. kind is e.g. plan|review|manual-checklist|webui-review|extra; rel_path
-- is relative to the pipeline/store dir. Replaces baseName-derivation in
-- pipeline-delete.mjs with an exact lookup.
CREATE TABLE artifacts (
  pipeline_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  rel_path    TEXT NOT NULL,
  PRIMARY KEY (pipeline_id, kind, rel_path),
  FOREIGN KEY (pipeline_id) REFERENCES pipelines (id) ON DELETE CASCADE
);
`;

/**
 * Incremental v1 -> v2 migration (sub-agent indicators feature). Adds the sub_agents
 * table: one row per Task/Agent child agent a pipeline node spawned, persisted so the
 * History UI reconstructs the live "sub-agents" view. Applied by migrate()'s stepwise
 * ladder only when the open DB is below v2 — it NEVER re-runs SCHEMA_V1.
 *
 * FK is to pipelines(id) ONLY (NOT pipeline_steps): writeState() does a DELETE-all +
 * re-INSERT of pipeline_steps on every persist, so a FK to pipeline_steps would
 * cascade-wipe these rows on the next state write. step_key is therefore a plain
 * column (the "<stepIndex>:<nodeId>[#cycle]" key) used for grouping, not a foreign key.
 * Writes are idempotent UPSERTs (upsertSubAgent), never the delete-all path.
 */
const SCHEMA_V2 = `
-- sub_agents: one row per Task/Agent child agent a node spawned (canonical key is the
-- spawning tool_use id). PK (pipeline_id, id); FK to pipelines ONLY (ON DELETE CASCADE).
-- status ∈ running|finished|error|stopped. duration_ms/tokens/cost_usd are nullable
-- telemetry (populated only by the feature-detected hook-events path). step_key is a
-- plain grouping column (NO FK — survives writeState's pipeline_steps delete-all).
CREATE TABLE sub_agents (
  pipeline_id  TEXT NOT NULL,
  id           TEXT NOT NULL,
  step_key     TEXT,
  node_id      TEXT,
  step_index   INTEGER,
  cycle        INTEGER,
  label        TEXT,
  status       TEXT NOT NULL DEFAULT 'running',
  started_at   TEXT,
  finished_at  TEXT,
  duration_ms  INTEGER,
  tokens       INTEGER,
  cost_usd     REAL,
  PRIMARY KEY (pipeline_id, id),
  FOREIGN KEY (pipeline_id) REFERENCES pipelines (id) ON DELETE CASCADE
);
CREATE INDEX idx_sub_agents_pipeline ON sub_agents (pipeline_id);
CREATE INDEX idx_sub_agents_step     ON sub_agents (pipeline_id, step_key);
`;

/**
 * Incremental v2 -> v3 migration. Adds sub_agents.ui_phase: the node's UI phase
 * (plan|refine|implement|review), stamped at spawn. Lets the live/history views
 * resolve a sub-agent to its graph node + dropdown label by uiPhase as a FALLBACK
 * when the run's real (s0_0-keyed) stepper manifest has not arrived yet. Nullable;
 * legacy rows derive their phase from node_id via the manifest at render time.
 */
const SCHEMA_V3 = `ALTER TABLE sub_agents ADD COLUMN ui_phase TEXT;`;

/**
 * Incremental v3 -> v4 migration (Decomposer feature). Adds two tables recording a
 * run's decomposition: pipeline_phases (ordered phases) and pipeline_tasks (the
 * self-contained task files, each linked to its dynamically-created implementer
 * node via node_id). Both FK to pipelines ONLY (ON DELETE CASCADE) and are written
 * via idempotent UPSERTs — NEVER the writeState delete-all path — so task/phase
 * status survives the pipeline_steps refresh, exactly like sub_agents.
 */
const SCHEMA_V4 = `
CREATE TABLE pipeline_phases (
  pipeline_id TEXT NOT NULL,
  ordinal     INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|error
  started_at  TEXT,
  finished_at TEXT,
  PRIMARY KEY (pipeline_id, ordinal),
  FOREIGN KEY (pipeline_id) REFERENCES pipelines (id) ON DELETE CASCADE
);

CREATE TABLE pipeline_tasks (
  pipeline_id   TEXT NOT NULL,
  id            TEXT NOT NULL,
  phase_ordinal INTEGER NOT NULL,
  task_index    INTEGER NOT NULL,
  title         TEXT,
  file_rel_path TEXT,
  node_id       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|error
  started_at    TEXT,
  finished_at   TEXT,
  PRIMARY KEY (pipeline_id, id),
  FOREIGN KEY (pipeline_id) REFERENCES pipelines (id) ON DELETE CASCADE
);
CREATE INDEX idx_pipeline_tasks_pipeline ON pipeline_tasks (pipeline_id);
`;

/**
 * Idempotent, versioned, CONCURRENCY-SAFE schema migration. Fast-path no-op when
 * PRAGMA user_version already == SCHEMA_VERSION. Otherwise it takes the write lock
 * (BEGIN IMMEDIATE) BEFORE re-reading user_version, so two first-launch migrators cannot
 * both pass the gate and double-apply SCHEMA_V1; the loser waits on busy_timeout, re-
 * checks under the lock, and no-ops. The pending DDL + the user_version stamp commit in
 * one transaction. (The WAL-mode switch itself is made race-safe by getDb's open retry,
 * since the busy-handler does not retry that pragma.) node:sqlite is sync, so this runs
 * inline on the calling thread.
 *
 * NOTE: PRAGMA user_version cannot be parameterized, so the version is inlined as a
 * literal integer (SCHEMA_VERSION is module-controlled, never user input).
 * @param {DatabaseSync} db
 */
export function migrate(db) {
  // Fast path: an already-migrated DB needs no lock (the common re-open case).
  if (db.prepare('PRAGMA user_version').get().user_version >= SCHEMA_VERSION) return;

  // First launch may have a competing migrator. BEGIN IMMEDIATE takes the write lock
  // up front (a deferred BEGIN would not lock until the first write, letting two
  // migrators both pass the gate and double-apply SCHEMA_V1 → "table projects already
  // exists"). Under the lock we re-read user_version and no-op if the winner stamped it.
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('PRAGMA user_version').get().user_version; // re-check under lock
    if (current >= SCHEMA_VERSION) { db.exec('COMMIT'); return; }
    if (current < 1) db.exec(SCHEMA_V1);
    if (current < 2) db.exec(SCHEMA_V2);
    if (current < 3) db.exec(SCHEMA_V3);
    if (current < 4) db.exec(SCHEMA_V4);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Close the singleton handle (no-op when already closed). */
export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
  _stmtCache = new Map();
  _txDepth = 0;
}

/**
 * Run `fn` inside a single SQLite transaction on the singleton handle. Commits
 * when `fn` returns, rolls back if it throws (re-throwing the original error).
 * Returns whatever `fn` returns. node:sqlite is synchronous, so `fn` must be
 * synchronous too — do all DB work inside it and return a value.
 *
 * Not re-entrant: SQLite has no nested BEGIN, so a tx() inside a tx() throws
 * rather than silently joining (or corrupting) the outer transaction. Compose by
 * passing data between calls, not by nesting.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function tx(fn) {
  if (_txDepth > 0) throw new Error('tx(): a transaction is already active (nested tx is not supported)');
  const db = getDb();
  db.exec('BEGIN');
  _txDepth = 1;
  try {
    const result = fn();
    db.exec('COMMIT');
    _txDepth = 0;
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } finally { _txDepth = 0; }
    throw err;
  }
}

/**
 * Prepare (and cache) a StatementSync by exact SQL text. Re-preparing the same
 * SQL returns the cached statement — node:sqlite statements are reusable across
 * runs (bind fresh params each .run()/.get()/.all()). The cache is keyed to the
 * current handle and cleared by closeDb()/_resetForTests().
 * @param {string} sql
 * @returns {import('node:sqlite').StatementSync}
 */
export function prepare(sql) {
  const hit = _stmtCache.get(sql);
  if (hit) return hit;
  const stmt = getDb().prepare(sql);
  _stmtCache.set(sql, stmt);
  return stmt;
}

/**
 * TEST-ONLY: drop the cached handle, prepared-statement cache, and transaction
 * guard so the next getDb() reopens against the current MAESTRO_HOME. Lets each
 * test run on a pristine DB at its own home.
 */
export function _resetForTests() {
  closeDb();
}
