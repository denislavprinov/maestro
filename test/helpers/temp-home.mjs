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
 * Because `node --test` runs every file in ONE process, the db.mjs singleton
 * opened against an earlier file's home stays cached when this file flips
 * MAESTRO_HOME. So we reset the singleton on both edges: after setting the env
 * var (so the next getDb() reopens against THIS home, before the first service
 * call) and again in teardown (so the next file starts clean). This folds the
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
    if (prev === undefined) delete process.env.MAESTRO_HOME;
    else process.env.MAESTRO_HOME = prev;
    _resetForTests(); // next file reopens clean
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}
