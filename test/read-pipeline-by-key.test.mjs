// test/read-pipeline-by-key.test.mjs
// Phase 3.7 — readPipelineByKey/readWorkspacePipeline reconstruct {state,
// auditMarkdown} from the DB (rowToState + buildAuditMarkdown), matching by short
// id OR run-dir basename. Fixtures seed pipelines rows (seedPipelineRow) + a couple
// of pipeline_events instead of state.json / pipeline.md files.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPipelineByKey, readWorkspacePipeline, listWorkspacePipelines } from '../src/core/artifacts.mjs';
import { getDb, _resetForTests } from '../src/core/db.mjs';
import { seedPipelineRow } from './helpers/db-seed.mjs';

const homes = [];
beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-rbk-'));
  homes.push(dir);
  _resetForTests();
  process.env.MAESTRO_HOME = dir;
});
after(async () => {
  _resetForTests();
  delete process.env.MAESTRO_HOME;
  await Promise.all(homes.map((d) => rm(d, { recursive: true, force: true })));
});

function addEvent(id, ts, text) {
  getDb().prepare('INSERT INTO pipeline_events (pipeline_id, ts, text) VALUES (?,?,?)').run(id, ts, text);
}

test('readPipelineByKey reconstructs state + auditMarkdown from the DB', async () => {
  seedPipelineRow({ id: 'abcd1234', projectKey: 'alpha-00000001', title: 'Demo', status: 'done',
    startedAt: '2026-06-02T00:00:00Z', prompt: 'demo prompt' });
  addEvent('abcd1234', '2026-06-02T00:00:01Z', 'Pipeline created (id abcd1234).');

  const byShort = await readPipelineByKey('alpha-00000001', 'abcd1234');
  assert.equal(byShort.state.title, 'Demo');
  assert.match(byShort.auditMarkdown, /# Pipeline: Demo/);
  assert.match(byShort.auditMarkdown, /## Timeline/);
  assert.match(byShort.auditMarkdown, /- `2026-06-02T00:00:01Z` Pipeline created \(id abcd1234\)\./);

  const byDir = await readPipelineByKey('alpha-00000001', '02-06-26-demo-abcd1234');
  assert.equal(byDir.state.id, 'abcd1234');

  assert.equal(await readPipelineByKey('alpha-00000001', 'nope'), null);
  assert.equal(await readPipelineByKey('missing-key', 'abcd1234'), null);
});

test('readPipelineByKey accepts the composite "workspaces/<key>" path segment', async () => {
  const wkey = 'wks-demo-9f3a1c20';
  seedPipelineRow({ id: 'deadbeef', workspaceKey: wkey, target: 'workspace', title: 'WS',
    status: 'done', startedAt: '2026-06-02T00:00:00Z',
    workspaceMeta: { workspaceId: wkey, workspaceName: 'WS', projectKeys: [], projects: [],
                     checkpointRefs: {}, branches: {}, workspaceDescription: '' } });
  addEvent('deadbeef', '2026-06-02T00:00:01Z', 'Pipeline created.');

  const byKey = await readPipelineByKey(`workspaces/${wkey}`, 'deadbeef');
  assert.equal(byKey.state.title, 'WS');
  assert.equal(byKey.state.target, 'workspace');
  assert.match(byKey.auditMarkdown, /# Pipeline: WS/);

  const byWs = await readWorkspacePipeline(wkey, 'deadbeef');
  assert.equal(byWs.state.id, 'deadbeef');
  assert.equal(await readWorkspacePipeline(wkey, 'nope'), null);
  assert.equal(await readWorkspacePipeline('wks-missing-00000000', 'deadbeef'), null);

  const list = await listWorkspacePipelines(wkey, '/abs/primary');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'deadbeef');
});
