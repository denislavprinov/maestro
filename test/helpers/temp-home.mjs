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

/**
 * Isolate MAESTRO_HOME for the current test file.
 * @param {(fn: () => void) => void} after  the node:test `after` hook
 * @param {string} [prefix]                 mkdtemp prefix (for debuggability)
 * @returns {string} the isolated home dir
 */
export function useTempHome(after, prefix = 'maestro-home-') {
  const prev = process.env.MAESTRO_HOME;
  const home = mkdtempSync(join(tmpdir(), prefix));
  process.env.MAESTRO_HOME = home;
  after(() => {
    if (prev === undefined) delete process.env.MAESTRO_HOME;
    else process.env.MAESTRO_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}
