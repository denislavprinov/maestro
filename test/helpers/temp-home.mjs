// test/helpers/temp-home.mjs
// Shared test isolation for the durable store. maestroHome() resolves to
// <MAESTRO_HOME or os.homedir()>/.maestro (src/core/projects.mjs), and the
// store key for a temp repo is <basename>-<sha1(path)[:8]> (src/core/store.mjs).
// Tests that run a pipeline therefore write meta/plans/reviews under the REAL
// ~/.maestro/store unless MAESTRO_HOME is overridden — orphaning a dir per run.
//
// useTempHome() points MAESTRO_HOME at a throwaway dir and registers cleanup on
// the caller's `after` hook, so the store lands in temp and is reaped with the
// rest of the test's scratch. Synchronous (mkdtempSync) so the env var is set
// at module-eval time, before any test body runs.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetForTests } from '../../src/core/db.mjs';

/**
 * Isolate MAESTRO_HOME for the current test file.
 *
 * The db.mjs singleton opened against an earlier home stays cached when this
 * file flips MAESTRO_HOME (multiple suites can share one process, e.g. plain
 * `node file.mjs` or --test with isolation disabled). So we reset the
 * singleton on both edges: after setting the env var (so the next getDb()
 * reopens against THIS home, before the first service call) and again in
 * teardown (so whatever runs next starts clean). This folds the
 * Phase-6 §0 "DB-touching test must reset the singleton" rule into the helper,
 * giving every useTempHome() caller DB isolation for free.
 *
 * Importing db.mjs here is safe: it is synchronous, Node-builtin-only, and does
 * NOT open the DB on import (only on first getDb()).
 *
 * @param {(fn: () => void) => void} after  the node:test `after` hook
 * @param {string} [prefix]                 mkdtemp prefix (for debuggability)
 * @returns {string} the isolated home dir
 */
export function useTempHome(after, prefix = 'maestro-home-') {
  const prev = process.env.MAESTRO_HOME;
  const home = mkdtempSync(join(tmpdir(), prefix));
  process.env.MAESTRO_HOME = home;
  _resetForTests(); // db reopens at this home on the next getDb()
  after(() => {
    // NEVER re-expose the real ~/.maestro. node:test runs after-hooks FIFO, so
    // this cleanup can fire BEFORE a suite's own after() that stops background
    // orch.run() work — and a late status write re-resolves maestroHome() at
    // write time. If there was no outer sandbox (direct `node --test file.mjs`
    // run without the npm-test MAESTRO_HOME wrapper), park the env on a
    // quarantine path under tmpdir instead of deleting it: late writes land in
    // throwaway /tmp junk, not the user's real store.
    process.env.MAESTRO_HOME =
      prev === undefined ? join(tmpdir(), 'maestro-test-quarantine') : prev;
    _resetForTests(); // next getDb() reopens against the restored home
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}
