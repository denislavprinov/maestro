// test/read-pipeline-by-key.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPipelineByKey, readWorkspacePipeline, listWorkspacePipelines } from '../src/core/artifacts.mjs';
import { storeRoot, workspacesStoreRoot } from '../src/core/store.mjs';

test('readPipelineByKey reads a pipeline from its store key', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maestro-rbk-'));
  const prev = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = home;
  try {
    const dir = join(storeRoot(), 'alpha-00000001', 'pipelines', '02-06-26-demo-abcd1234');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'state.json'), JSON.stringify({ id: 'abcd1234', title: 'Demo' }), 'utf8');
    await writeFile(join(dir, 'pipeline.md'), '# Demo\n', 'utf8');

    const byShort = await readPipelineByKey('alpha-00000001', 'abcd1234');
    assert.equal(byShort.state.title, 'Demo');
    assert.match(byShort.auditMarkdown, /# Demo/);

    const byDir = await readPipelineByKey('alpha-00000001', '02-06-26-demo-abcd1234');
    assert.equal(byDir.state.id, 'abcd1234');

    assert.equal(await readPipelineByKey('alpha-00000001', 'nope'), null);
    assert.equal(await readPipelineByKey('missing-key', 'abcd1234'), null);
  } finally { if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev; }
});

test('readPipelineByKey accepts the composite "workspaces/<key>" path segment', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maestro-rbk-ws-'));
  const prev = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = home;
  try {
    const wkey = 'wks-demo-9f3a1c20';
    const dir = join(workspacesStoreRoot(), wkey, 'pipelines', '02-06-26-ws-run-deadbeef');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'state.json'), JSON.stringify({ id: 'deadbeef', title: 'WS', target: 'workspace' }), 'utf8');
    await writeFile(join(dir, 'pipeline.md'), '# WS\n', 'utf8');

    // The composite key round-trips through projectStorePath(join under storeRoot).
    const byKey = await readPipelineByKey(`workspaces/${wkey}`, 'deadbeef');
    assert.equal(byKey.state.title, 'WS');
    assert.match(byKey.auditMarkdown, /# WS/);

    // The dedicated ws-rooted reader resolves the same pipeline by short id.
    const byWs = await readWorkspacePipeline(wkey, 'deadbeef');
    assert.equal(byWs.state.id, 'deadbeef');
    assert.equal(await readWorkspacePipeline(wkey, 'nope'), null);
    assert.equal(await readWorkspacePipeline('wks-missing-00000000', 'deadbeef'), null);

    // And the ws-rooted lister finds it.
    const list = await listWorkspacePipelines(wkey, '/abs/primary');
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'deadbeef');
  } finally { if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev; }
});
