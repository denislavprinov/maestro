// test/artifacts-store.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { artifactPaths, ensureArtifactDirs, createPipeline, planPath, reviewPath } from '../src/core/artifacts.mjs';
import { projectKey, storeRoot, workspaceStorePath } from '../src/core/store.mjs';

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

test('createPipeline stamps projectKey + projectName into state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maestro-ah3-'));
  const proj = await mkdtemp(join(tmpdir(), 'maestro-proj3-'));
  const prev = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = home;
  try {
    const { dir } = await createPipeline(proj, { prompt: 'demo task', title: 'Demo' });
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    assert.equal(state.projectKey, projectKey(proj));
    assert.ok(typeof state.projectName === 'string' && state.projectName.length > 0);
    assert.equal(state.projectDir, resolve(proj));
    // Back-compat: a single-project pipeline has NO workspace discriminator/fields.
    assert.equal(state.target, undefined);
    assert.equal(state.workspaceKey, undefined);
    assert.equal(state.branches, undefined);
  } finally { if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev; }
});

// ---- Workspace-keyed artifact routing (opt-in; single-project paths unchanged) ----

const WKEY = 'wks-demo-12345678';

test('artifactPaths routes to store/workspaces/<key> when a workspaceKey is given', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maestro-wsp-'));
  const proj = await mkdtemp(join(tmpdir(), 'maestro-wsp-proj-'));
  const prev = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = home;
  try {
    const ws = artifactPaths(proj, WKEY);
    const expectRoot = workspaceStorePath(WKEY);
    assert.equal(ws.root, expectRoot);
    assert.equal(ws.plans, join(expectRoot, 'plans'));
    assert.equal(ws.reviews, join(expectRoot, 'reviews'));
    assert.equal(ws.pipelines, join(expectRoot, 'pipelines'));
    // Absent the key, byte-identical to the legacy project path.
    const proj2 = artifactPaths(proj);
    assert.equal(proj2.root, join(storeRoot(), projectKey(proj)));
    assert.notEqual(ws.root, proj2.root);
  } finally { if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev; }
});

test('planPath/reviewPath thread the optional workspaceKey into the workspace store', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maestro-wpp-'));
  const proj = await mkdtemp(join(tmpdir(), 'maestro-wpp-proj-'));
  const prev = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = home;
  try {
    const pp = planPath(proj, 'feat', 1, '03-06-26', WKEY);
    assert.equal(pp, join(workspaceStorePath(WKEY), 'plans', '03-06-26-feat.md'));
    const rp = reviewPath(proj, 'feat', '03-06-26', 'impl-review', WKEY);
    assert.equal(rp, join(workspaceStorePath(WKEY), 'reviews', '03-06-26-feat-impl-review.md'));
    // Legacy single-project signatures still resolve under the project key.
    assert.match(planPath(proj, 'feat', 1, '03-06-26'), new RegExp(`${projectKey(proj)}/plans/03-06-26-feat\\.md$`));
  } finally { if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev; }
});

test('ensureArtifactDirs writes the workspace meta.json shape under store/workspaces/<key>', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maestro-wmeta-'));
  const a = await mkdtemp(join(tmpdir(), 'maestro-wmeta-a-'));
  const b = await mkdtemp(join(tmpdir(), 'maestro-wmeta-b-'));
  const prev = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = home;
  try {
    const p = await ensureArtifactDirs(a, WKEY, {
      workspaceId: WKEY,
      workspaceName: 'Demo WS',
      projects: [
        { projectKey: projectKey(a), projectDir: a, projectName: 'a' },
        { projectKey: projectKey(b), projectDir: b, projectName: 'b' },
      ],
    });
    assert.equal(p.root, workspaceStorePath(WKEY));
    await stat(p.pipelines); // throws if missing
    const meta = JSON.parse(await readFile(join(p.root, 'meta.json'), 'utf8'));
    assert.equal(meta.key, WKEY);
    assert.equal(meta.id, WKEY);
    assert.equal(meta.name, 'Demo WS');
    assert.ok(Array.isArray(meta.projectKeys) && meta.projectKeys.length === 2);
    assert.ok(Array.isArray(meta.projectPaths) && meta.projectPaths.length === 2);
    assert.ok(meta.firstSeenAt);
    // The project-shape `path` field must NOT leak into a workspace meta.
    assert.equal(meta.path, undefined);
  } finally { if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev; }
});

test('createPipeline (workspace opts) stamps the state superset + workspace-description.md', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maestro-wpipe-'));
  const a = await mkdtemp(join(tmpdir(), 'maestro-wpipe-a-'));
  const b = await mkdtemp(join(tmpdir(), 'maestro-wpipe-b-'));
  const prev = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = home;
  try {
    const projects = [
      { projectKey: projectKey(a), projectDir: a, projectName: 'a' },
      { projectKey: projectKey(b), projectDir: b, projectName: 'b' },
    ].sort((x, y) => (x.projectKey < y.projectKey ? -1 : 1));
    const { dir } = await createPipeline(projects[0].projectDir, {
      prompt: 'add pagination',
      title: 'add pagination',
      workspaceKey: WKEY,
      workspaceId: WKEY,
      workspaceName: 'Demo WS',
      workspaceDescription: '# Workspace: Demo\nlots of detail',
      projects,
    });
    // Lives in the workspace store, not under any project key.
    assert.ok(dir.startsWith(join(workspaceStorePath(WKEY), 'pipelines')), 'pipeline dir under workspace store');

    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    assert.equal(state.target, 'workspace');
    assert.equal(state.workspaceId, WKEY);
    assert.equal(state.workspaceKey, WKEY);
    assert.equal(state.workspaceName, 'Demo WS');
    assert.equal(state.workspaceDescription, '# Workspace: Demo\nlots of detail');
    assert.deepEqual(state.projectKeys, projects.map((p) => p.projectKey));
    assert.equal(state.projects.length, 2);
    assert.deepEqual(state.checkpointRefs, {});
    assert.deepEqual(state.branches, {});

    // Frozen description snapshot file present and matching.
    const wd = await readFile(join(dir, 'workspace-description.md'), 'utf8');
    assert.equal(wd, '# Workspace: Demo\nlots of detail');
  } finally { if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev; }
});

test('createPipeline freezes the description at a 2000-char cap (cap-on-freeze)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maestro-wcap-'));
  const a = await mkdtemp(join(tmpdir(), 'maestro-wcap-a-'));
  const b = await mkdtemp(join(tmpdir(), 'maestro-wcap-b-'));
  const prev = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = home;
  try {
    const big = 'x'.repeat(5000);
    const projects = [
      { projectKey: projectKey(a), projectDir: a, projectName: 'a' },
      { projectKey: projectKey(b), projectDir: b, projectName: 'b' },
    ].sort((x, y) => (x.projectKey < y.projectKey ? -1 : 1));
    const { dir } = await createPipeline(projects[0].projectDir, {
      prompt: 'task', workspaceKey: WKEY, workspaceId: WKEY, workspaceName: 'Cap',
      workspaceDescription: big, projects,
    });
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    assert.equal(state.workspaceDescription.length, 2000, 'frozen copy capped at 2000');
    assert.ok(state.workspaceDescription.endsWith('…'), 'truncation marked with an ellipsis');
    const wd = await readFile(join(dir, 'workspace-description.md'), 'utf8');
    assert.equal(wd.length, 2000);
  } finally { if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev; }
});

test('createPipeline freeze is surrogate-safe at the 2000-char boundary (no lone surrogate)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maestro-wsurr-'));
  const a = await mkdtemp(join(tmpdir(), 'maestro-wsurr-a-'));
  const b = await mkdtemp(join(tmpdir(), 'maestro-wsurr-b-'));
  const prev = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = home;
  try {
    // 1998 ASCII chars puts an astral emoji (2 UTF-16 code units) straddling the
    // 1999-code-unit budget boundary: a naive slice(0,1999) would split the pair.
    const big = 'a'.repeat(1998) + '😀'.repeat(50);
    const projects = [
      { projectKey: projectKey(a), projectDir: a, projectName: 'a' },
      { projectKey: projectKey(b), projectDir: b, projectName: 'b' },
    ].sort((x, y) => (x.projectKey < y.projectKey ? -1 : 1));
    const { dir } = await createPipeline(projects[0].projectDir, {
      prompt: 'task', workspaceKey: 'wks-demo-12345678', workspaceId: 'wks-demo-12345678',
      workspaceName: 'Surr', workspaceDescription: big, projects,
    });
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    const out = state.workspaceDescription;
    assert.ok(out.length <= 2000, `length ${out.length} must be <= 2000`);
    assert.ok(out.endsWith('…'), 'ends with the ellipsis');
    // No lone surrogate: the char immediately before '…' must NOT be a high
    // surrogate (that would mean a pair was split), and the whole string must be
    // well-formed UTF-16 (no lone surrogate anywhere).
    assert.ok(!/[\uD800-\uDBFF]$/.test(out.slice(0, -1)), 'no dangling high surrogate before the ellipsis');
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out),
      'frozen description is well-formed UTF-16 (no lone surrogate)');
  } finally { if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev; }
});
