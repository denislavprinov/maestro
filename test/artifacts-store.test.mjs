// test/artifacts-store.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactPaths, ensureArtifactDirs } from '../src/core/artifacts.mjs';
import { projectKey, storeRoot } from '../src/core/store.mjs';

test('artifactPaths resolves into the store, not the project dir', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maestro-ah-'));
  const proj = await mkdtemp(join(tmpdir(), 'maestro-proj-'));
  const prev = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = home;
  try {
    const p = artifactPaths(proj);
    const expectRoot = join(storeRoot(), projectKey(proj));
    assert.equal(p.root, expectRoot);
    assert.equal(p.plans, join(expectRoot, 'plans'));
    assert.ok(!p.root.startsWith(proj), 'must NOT live under the project dir');
  } finally { if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev; }
});

test('ensureArtifactDirs creates dirs + writes+returns meta.json once', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maestro-ah2-'));
  const proj = await mkdtemp(join(tmpdir(), 'maestro-proj2-'));
  const prev = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = home;
  try {
    const p = await ensureArtifactDirs(proj);
    await stat(p.pipelines); // throws if missing
    assert.equal(p.meta.key, projectKey(proj), 'ensureArtifactDirs returns the meta object');
    const onDisk = JSON.parse(await readFile(join(p.root, 'meta.json'), 'utf8'));
    assert.equal(onDisk.key, projectKey(proj));
    assert.ok(onDisk.firstSeenAt);
    const first = onDisk.firstSeenAt;
    const p2 = await ensureArtifactDirs(proj); // re-run
    assert.equal(p2.meta.firstSeenAt, first, 'firstSeenAt is preserved on re-run');
  } finally { if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev; }
});
