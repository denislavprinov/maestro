// test/read-pipeline-by-key.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPipelineByKey } from '../src/core/artifacts.mjs';
import { storeRoot } from '../src/core/store.mjs';

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
