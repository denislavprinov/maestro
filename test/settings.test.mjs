// test/settings.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maestroHome } from '../src/core/projects.mjs';
import { getMaestroRoot, setMaestroRoot, settingsFile, defaultRoot } from '../src/core/settings.mjs';

// Sandbox BOTH the home (so settingsFile + defaultRoot resolve into a temp dir)
// and clear MAESTRO_HOME so the settings file is actually consulted. The whole
// suite runs under MAESTRO_HOME=.maestro-test (Task 3); these tests must remove
// that inherited value to exercise the settings tier, then restore it.
async function withSandbox(fn) {
  const home = await mkdtemp(join(tmpdir(), 'maestro-set-'));
  const prev = {
    HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, MAESTRO_HOME: process.env.MAESTRO_HOME,
  };
  process.env.HOME = home; process.env.USERPROFILE = home; delete process.env.MAESTRO_HOME;
  try { return await fn(home); }
  finally {
    for (const k of ['HOME', 'USERPROFILE', 'MAESTRO_HOME']) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
    await rm(home, { recursive: true, force: true });
  }
}

test('default: no settings, no env -> homedir base', async () => {
  await withSandbox(async (home) => {
    assert.equal(getMaestroRoot(), '');
    assert.equal(defaultRoot(), home);
    assert.equal(maestroHome(), join(home, '.maestro'));
  });
});

test('settings.json root wins over the home default', async () => {
  await withSandbox(async () => {
    const target = await mkdtemp(join(tmpdir(), 'maestro-target-'));
    await setMaestroRoot(target);
    assert.equal(getMaestroRoot(), target);
    assert.equal(maestroHome(), join(target, '.maestro'));
    await rm(target, { recursive: true, force: true });
  });
});

test('MAESTRO_HOME env wins over settings.json', async () => {
  await withSandbox(async () => {
    const target = await mkdtemp(join(tmpdir(), 'maestro-target2-'));
    await setMaestroRoot(target);
    const envBase = await mkdtemp(join(tmpdir(), 'maestro-env-'));
    process.env.MAESTRO_HOME = envBase;
    assert.equal(maestroHome(), join(envBase, '.maestro'), 'env beats settings');
    delete process.env.MAESTRO_HOME;
    await rm(target, { recursive: true, force: true });
    await rm(envBase, { recursive: true, force: true });
  });
});

test('reset (empty root) falls back to the home default', async () => {
  await withSandbox(async (home) => {
    const target = await mkdtemp(join(tmpdir(), 'maestro-target3-'));
    await setMaestroRoot(target);
    await setMaestroRoot('');           // reset
    assert.equal(getMaestroRoot(), '');
    assert.equal(maestroHome(), join(home, '.maestro'));
    await rm(target, { recursive: true, force: true });
  });
});

test('corrupt settings.json -> home default (never throws)', async () => {
  await withSandbox(async (home) => {
    await mkdir(join(home, '.maestro'), { recursive: true });
    await writeFile(settingsFile(), '{ not json', 'utf8');
    assert.equal(getMaestroRoot(), '');
    assert.equal(maestroHome(), join(home, '.maestro'));
  });
});

test('setMaestroRoot rejects a path that is a file, not a dir', async () => {
  await withSandbox(async (home) => {
    await mkdir(join(home, '.maestro'), { recursive: true });
    const f = join(home, 'afile');
    await writeFile(f, 'x', 'utf8');
    await assert.rejects(() => setMaestroRoot(f), /not a directory/);
  });
});
