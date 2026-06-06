// test/artifacts-pr-state.test.mjs
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _testing as gitInfo } from '../src/core/git-info.mjs';

let home, prevHome, repo;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'maestro-prs-'));
  prevHome = process.env.MAESTRO_HOME; process.env.MAESTRO_HOME = home;
  repo = await mkdtemp(join(tmpdir(), 'maestro-prs-repo-'));
});
after(async () => {
  gitInfo.reset();
  if (prevHome === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});
beforeEach(() => gitInfo.reset());

// Fake runner: gh present, branch survives, and a PR (state/url) exists for the head.
function stubGh({ state = 'OPEN', url = 'https://gh/x/pull/5', number = 5 } = {}) {
  gitInfo.setRunner((cmd, args) => {
    if (cmd === 'gh' && args[0] === '--version') return Promise.resolve({ ok: true, stdout: 'gh 2.x', stderr: '', code: 0 });
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list')
      return Promise.resolve({ ok: true, stdout: JSON.stringify([{ number, state, url }]), stderr: '', code: 0 });
    if (cmd === 'git' && args[0] === 'rev-parse') return Promise.resolve({ ok: true, stdout: 'ref\n', stderr: '', code: 0 });
    return Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0 });
  });
}

async function seed(id) {
  const { artifactPaths } = await import('../src/core/artifacts.mjs');
  const dir = join(artifactPaths(repo).pipelines, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    id, title: 'Feat', status: 'done', projectDir: repo,
    branch: { source: 'main', feature: 'maestro/feat-1', branchKept: true },
  }), 'utf8');
}

test('withPr:true attaches the live PR state to each row', async () => {
  const { listPipelines } = await import('../src/core/artifacts.mjs');
  stubGh({ state: 'MERGED', url: 'https://gh/x/pull/5', number: 5 });
  await seed('pp-merged');
  const row = (await listPipelines(repo, { withPr: true })).find((r) => r.id === 'pp-merged');
  assert.deepEqual(row.pr, { state: 'MERGED', url: 'https://gh/x/pull/5', number: 5 });
});

test('withPr defaults off: no pr field, no gh call', async () => {
  const { listPipelines } = await import('../src/core/artifacts.mjs');
  let ghCalled = false;
  gitInfo.setRunner((cmd, args) => {
    if (cmd === 'gh') ghCalled = true;
    return Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0 });
  });
  await seed('pp-default');
  const row = (await listPipelines(repo)).find((r) => r.id === 'pp-default');
  assert.equal(row.pr, undefined);
  assert.equal(ghCalled, false);
});

test('withPr:true but gh unavailable -> pr is null, never throws', async () => {
  const { listPipelines } = await import('../src/core/artifacts.mjs');
  gitInfo.setRunner((cmd, args) =>
    Promise.resolve(cmd === 'gh' && args[0] === '--version'
      ? { ok: false, stdout: '', stderr: 'not found', code: 127 }
      : { ok: true, stdout: '', stderr: '', code: 0 }));
  await seed('pp-nogh');
  const row = (await listPipelines(repo, { withPr: true })).find((r) => r.id === 'pp-nogh');
  assert.equal(row.pr, null);
});

test('withPr:true with only a closed PR -> pr is null (button re-appears)', async () => {
  const { listPipelines } = await import('../src/core/artifacts.mjs');
  stubGh({ state: 'CLOSED', url: 'https://gh/x/pull/6', number: 6 });
  await seed('pp-closed');
  const row = (await listPipelines(repo, { withPr: true })).find((r) => r.id === 'pp-closed');
  assert.equal(row.pr, null);
});

test('enrichPipelinesPr emits {projectKey,id,pr} batches; pr has no mergeable; final done=true', async () => {
  const { enrichPipelinesPr, artifactPaths } = await import('../src/core/artifacts.mjs');
  stubGh({ state: 'OPEN', url: 'https://gh/x/pull/7', number: 7 });
  await seed('pp-enrich-a');
  await seed('pp-enrich-b');
  // listAllPipelines derives each row's projectDir from the store key's meta.json
  // (createPipeline always writes one); seed it so the rows are PR-enrich targets.
  await writeFile(join(artifactPaths(repo).root, 'meta.json'),
    JSON.stringify({ key: 'k', path: repo, name: 'Repo' }), 'utf8');
  const collected = [];
  let finalDone = null;
  await enrichPipelinesPr((items, done) => { collected.push(...items); finalDone = done; }, { batchSize: 1 });
  const a = collected.find((x) => x.id === 'pp-enrich-a');
  assert.ok(a, 'seeded branch row was enriched');
  assert.deepEqual(Object.keys(a).sort(), ['id', 'pr', 'projectKey'], 'only {projectKey,id,pr}');
  assert.equal(a.pr.state, 'OPEN');
  assert.ok(!('mergeable' in a.pr), 'no live mergeability field in v1 (clarification B)');
  assert.equal(finalDone, true, 'the final batch flags done=true');
});

test('enrichPipelinesPr with gh unavailable emits exactly one empty final batch', async () => {
  const { enrichPipelinesPr } = await import('../src/core/artifacts.mjs');
  gitInfo.setRunner((cmd, args) =>
    Promise.resolve(cmd === 'gh' && args[0] === '--version'
      ? { ok: false, stdout: '', stderr: 'not found', code: 127 }
      : { ok: true, stdout: '', stderr: '', code: 0 }));
  await seed('pp-enrich-nogh');
  const batches = [];
  await enrichPipelinesPr((items, done) => batches.push({ items, done }));
  assert.equal(batches.length, 1, 'exactly one batch when gh is unavailable');
  assert.deepEqual(batches[0], { items: [], done: true });
});
