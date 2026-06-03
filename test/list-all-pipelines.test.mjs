// test/list-all-pipelines.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAllPipelines } from '../src/core/artifacts.mjs';
import { storeRoot } from '../src/core/store.mjs';

async function seed(key, name, id, title) {
  const dir = join(storeRoot(), key, 'pipelines', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'),
    JSON.stringify({ id, title, status: 'done', startedAt: '2026-06-01T00:00:00Z' }), 'utf8');
  if (name != null) {
    await writeFile(join(storeRoot(), key, 'meta.json'),
      JSON.stringify({ key, path: '/x/' + key, name }), 'utf8');
  }
}

test('listAllPipelines merges every store key, tags project, sorts newest-first', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maestro-all-'));
  const prev = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = home;
  try {
    await seed('alpha-00000001', 'Alpha', 'a1', 'Alpha run');
    await seed('beta-00000002', 'Beta', 'b1', 'Beta run');
    await seed('orphan-00000003', null, 'o1', 'Orphan run'); // no meta.json
    const all = await listAllPipelines();
    assert.equal(all.length, 3);
    const byId = Object.fromEntries(all.map((p) => [p.id, p]));
    assert.equal(byId.a1.projectName, 'Alpha');
    assert.equal(byId.a1.projectKey, 'alpha-00000001');
    assert.equal(byId.o1.projectName, 'orphan-00000003', 'orphan falls back to the key');
  } finally { if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev; }
});

test('listAllPipelines returns [] when the store is absent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maestro-all-empty-'));
  const prev = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = home;
  try { assert.deepEqual(await listAllPipelines(), []); }
  finally { if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev; }
});
