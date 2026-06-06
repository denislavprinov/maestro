// src/core/migrate-fs-to-db.mjs  (STUB — full body owned by the fs→db phase / Phase 4)
//
// Phase 1 only WIRES the call: db.mjs#getDb() invokes maybeMigrateFromFs(db) once
// per fresh open, after migrate() has stamped the schema. The real importer
// (count-guarded one-shot legacy-JSON → DB copy, A8: runs only when
// count(projects)==0 AND count(pipelines)==0 AND legacy JSON exists; NO marker
// table) is authored in Phase 4, which REPLACES this stub body. The binding
// contract is the signature `maybeMigrateFromFs(db) -> void`; it must not change.

// A14: ESM namespace exports are non-configurable, so the Phase-1 hook-call test
// cannot mock.method() this function. Instead we expose an OBSERVABLE effect — a
// module-level call counter — so the test can assert the hook fired exactly once,
// after migrate(), without mocking the namespace. (Phase 4's real body keeps the
// counter increment harmless; it can drop it once it has its own assertions.)
let _callCount = 0;

/**
 * Migrate legacy JSON state into the DB on first run. Self-guarded + idempotent:
 * no-ops unless the DB is empty AND legacy JSON is present. Synchronous.
 *
 * Phase-1 STUB: records that it was called (observable counter) and returns. The
 * fs→db phase (Phase 4) replaces the body with the real count-guarded importer.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
export function maybeMigrateFromFs(db) {
  void db; // implemented in the fs→db phase (Phase 4)
  _callCount += 1;
}

/** TEST-ONLY: how many times maybeMigrateFromFs() has been called. */
export function _migrateFromFsCallCount() {
  return _callCount;
}

/** TEST-ONLY: reset the call counter so each test observes a fresh open. */
export function _resetMigrateFromFsCallCount() {
  _callCount = 0;
}
