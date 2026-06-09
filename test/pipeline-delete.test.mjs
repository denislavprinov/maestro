// test/pipeline-delete.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { deletePipeline } from '../src/core/pipeline-delete.mjs';
import { recordArtifact, listArtifacts, writeStoreMeta } from '../src/core/artifacts.mjs';
import { _resetForTests } from '../src/core/db.mjs';
import { listLocalBranches, createWorktree } from '../src/core/worktree.mjs';
import { seedPipelineRow } from './helpers/db-seed.mjs';

const created = [];
after(() => {
  _resetForTests();
  return Promise.all(created.map((d) => rm(d, { recursive: true, force: true })));
});

// A real git repo so branch/worktree teardown is exercised for real.
async function freshRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-del-repo-'));
  created.push(dir);
  const g = (a) => spawnSync('git', a, { cwd: dir });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  await writeFile(join(dir, 'README.md'), '# hi\n');
  g(['add', '-A']); g(['commit', '-qm', 'init']);
  return dir;
}

// A store key dir with one pipeline + its plan/review files, plus a sibling that
// must survive (proves the index-based deleter only ever unlinks the EXACT
// recorded files). The pipeline dir is named exactly like the real one:
// <datePrefix>-<base>-<id>. The plan/review md live on the FS (still markdown);
// the durable record is the DB pipelines row + the artifacts index pointing at
// those store-root-relative paths.
async function freshStore(repoDir, { id, base, datePrefix, status, branch, title }) {
  const home = await mkdtemp(join(tmpdir(), 'maestro-del-store-'));
  created.push(home);
  _resetForTests(); process.env.MAESTRO_HOME = home;           // DB opens under this home
  const key = 'proj-00000001';
  const root = join(home, '.maestro', 'store', key);
  const pdir = join(root, 'pipelines', `${datePrefix}-${base}-${id}`);
  await mkdir(join(pdir, 'extras'), { recursive: true });
  await writeFile(join(pdir, 'prompt.md'), `# ${title ?? 'Add login screen'}\n`, 'utf8');
  await mkdir(join(root, 'plans'), { recursive: true });
  await mkdir(join(root, 'reviews'), { recursive: true });
  await writeFile(join(root, 'plans', `${datePrefix}-${base}.md`), '# plan', 'utf8');
  await writeFile(join(root, 'plans', `${datePrefix}-${base}-v2.md`), '# plan v2', 'utf8');
  await writeFile(join(root, 'reviews', `${datePrefix}-${base}-impl-review.md`), '# r', 'utf8');
  await writeFile(join(root, 'reviews', `${datePrefix}-${base}-plan-review.md`), '# r', 'utf8');
  await writeFile(join(root, 'plans', `${datePrefix}-${base}-extra.md`), '# keep', 'utf8'); // NOT indexed -> survives
  // DB: the project store_meta (so rowToState reconstructs state.projectDir, the
  // teardown repo), the pipeline row, and the indexed artifacts (store-root-relative
  // for plan/review). Mirrors what createPipeline's ensureMeta + INSERT persist.
  writeStoreMeta(key, 'project', { key, name: 'Proj', path: repoDir });
  seedPipelineRow({ id, projectKey: key, title: title ?? 'Add login screen', status,
    baseName: base, datePrefix,
    branch: branch === undefined ? null : branch });
  recordArtifact(id, 'plan', `plans/${datePrefix}-${base}.md`);
  recordArtifact(id, 'plan', `plans/${datePrefix}-${base}-v2.md`);
  recordArtifact(id, 'review', `reviews/${datePrefix}-${base}-impl-review.md`);
  recordArtifact(id, 'review', `reviews/${datePrefix}-${base}-plan-review.md`);
  return { home, key, root, pdir };
}

// A workspace store dir (store/workspaces/<wkey>/) with one pipeline whose
// workspaceMeta.branches is the per-project map. `members` is [{ projectDir, branch }].
// The ws row stores branches/projects in the workspace_meta JSON column; the
// reconstructed state.branches/state.projects drive the per-member teardown.
async function freshWorkspaceStore({ wkey, id, base, datePrefix, status, title, members }) {
  const home = await mkdtemp(join(tmpdir(), 'maestro-del-ws-'));
  created.push(home);
  _resetForTests(); process.env.MAESTRO_HOME = home;           // DB opens under this home
  const root = join(home, '.maestro', 'store', 'workspaces', wkey);
  const pdir = join(root, 'pipelines', `${datePrefix}-${base}-${id}`);
  await mkdir(pdir, { recursive: true });
  const branches = {};
  const projects = [];
  for (let i = 0; i < members.length; i++) {
    const pk = `member-0000000${i + 1}`;
    projects.push({ projectKey: pk, projectDir: members[i].projectDir, projectName: `m${i}` });
    branches[pk] = members[i].branch; // { source, feature, worktreeDir, reusedExisting }
  }
  await writeFile(join(pdir, 'prompt.md'), `# ${title ?? 'Add login screen'}\n`, 'utf8');
  await mkdir(join(root, 'plans'), { recursive: true });
  await mkdir(join(root, 'reviews'), { recursive: true });
  await writeFile(join(root, 'plans', `${datePrefix}-${base}.md`), '# plan', 'utf8');
  await writeFile(join(root, 'reviews', `${datePrefix}-${base}-impl-review.md`), '# r', 'utf8');
  await writeFile(join(root, 'plans', `${datePrefix}-${base}-extra.md`), '# keep', 'utf8'); // NOT indexed -> survives
  // DB: ws pipeline row (workspace_meta carries branches/projects) + indexed md.
  seedPipelineRow({
    id, projectKey: 'ws-primary-00000001', workspaceKey: wkey, target: 'workspace',
    title: title ?? 'Add login screen', status, baseName: base, datePrefix,
    workspaceMeta: { workspaceId: wkey, workspaceName: 'demo', projectKeys: projects.map((p) => p.projectKey), projects, branches },
  });
  recordArtifact(id, 'plan', `plans/${datePrefix}-${base}.md`);
  recordArtifact(id, 'review', `reviews/${datePrefix}-${base}-impl-review.md`);
  return { home, root, pdir };
}

test('deletePipeline removes dir, indexed plan/review files, local branch; keeps non-indexed siblings + remote', async () => {
  const repo = await freshRepo();
  // Real worktree + feature branch off main.
  const { worktreeDir, branch } = await createWorktree({
    projectDir: repo, pipelineId: 'abc123', sourceBranch: 'main',
    featureBranch: 'maestro/add-login-screen-abc123',
  });
  const prev = process.env.MAESTRO_HOME;
  const { root, pdir } = await freshStore(repo, {
    id: 'abc123', base: 'add-login-screen', datePrefix: '04-06-26', status: 'done',
    title: 'Add login screen', branch: { source: 'main', feature: branch, worktreeDir },
  });
  try {
    const report = await deletePipeline({ key: 'proj-00000001', id: 'abc123' });
    assert.ok(report && report.ok);
    assert.equal(existsSync(pdir), false, 'pipeline dir removed');
    const plans = await readdir(join(root, 'plans'));
    assert.deepEqual(plans.sort(), ['04-06-26-add-login-screen-extra.md'], 'only the non-indexed sibling survives');
    const reviews = await readdir(join(root, 'reviews'));
    assert.equal(reviews.length, 0, 'both indexed review md removed');
    assert.equal(existsSync(worktreeDir), false, 'worktree gone');
    assert.ok(!(await listLocalBranches(repo)).includes(branch), 'local branch deleted');
  } finally {
    if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev;
  }
});

test('deletePipeline needs no title/slug heuristic: indexed files are removed even when title equals the dir basename', async () => {
  // The OLD hard case for the name-pattern deleter: no usable title (it equals the
  // auto dir basename), so deriveNames had to fall back to the dir slug / prompt.
  // The index-based deleter unlinks the EXACT recorded rel_paths regardless of title.
  const repo = await freshRepo();
  const prev = process.env.MAESTRO_HOME;
  const { root, pdir } = await freshStore(repo, {
    id: 'zz', base: 'rename-widget', datePrefix: '04-06-26', status: 'done',
    title: '04-06-26-rename-widget-zz', branch: null,
  });
  try {
    const report = await deletePipeline({ key: 'proj-00000001', id: 'zz' });
    assert.ok(report && report.ok);
    assert.equal(existsSync(pdir), false, 'pipeline dir removed');
    const plans = await readdir(join(root, 'plans'));
    assert.deepEqual(plans.sort(), ['04-06-26-rename-widget-extra.md'], 'indexed v1+v2 removed, non-indexed sibling kept');
    const reviews = await readdir(join(root, 'reviews'));
    assert.equal(reviews.length, 0, 'indexed review md removed');
  } finally {
    if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev;
  }
});

test('deletePipeline refuses an active pipeline (running/pausing; status from the DB row)', async () => {
  const repo = await freshRepo();
  const prev = process.env.MAESTRO_HOME;
  try {
    for (const status of ['running', 'pausing']) {
      await freshStore(repo, {
        id: 'run1', base: 'add-login-screen', datePrefix: '04-06-26', status, branch: null,
      });
      await assert.rejects(() => deletePipeline({ key: 'proj-00000001', id: 'run1' }),
        (e) => e && e.code === 'RUNNING', `status=${status} must refuse deletion`);
    }
  } finally {
    if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev;
  }
});

test('deletePipeline returns null for an unknown id', async () => {
  const repo = await freshRepo();
  const prev = process.env.MAESTRO_HOME;
  await freshStore(repo, {
    id: 'x', base: 'add-login-screen', datePrefix: '04-06-26', status: 'done', branch: null,
  });
  try {
    assert.equal(await deletePipeline({ key: 'proj-00000001', id: 'nope' }), null);
  } finally {
    if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev;
  }
});

test('deletePipeline({workspaceKey}) removes the ws-store dir + iterates state.branches per project', async () => {
  // Two real repos, each with its own worktree + feature branch, recorded in the
  // per-project workspace_meta.branches map. Delete must clean BOTH and remove the
  // ws dir + the indexed ws-store markdown.
  const repoA = await freshRepo();
  const repoB = await freshRepo();
  const wtA = await createWorktree({
    projectDir: repoA, pipelineId: 'ws01', sourceBranch: 'main',
    featureBranch: 'maestro/add-login-screen-ws01',
  });
  const wtB = await createWorktree({
    projectDir: repoB, pipelineId: 'ws01', sourceBranch: 'main',
    featureBranch: 'maestro/add-login-screen-ws01',
  });
  const prev = process.env.MAESTRO_HOME;
  const wkey = 'wks-demo-9f3a1c20';
  const { root, pdir } = await freshWorkspaceStore({
    wkey, id: 'ws01', base: 'add-login-screen', datePrefix: '04-06-26', status: 'done',
    title: 'Add login screen',
    members: [
      { projectDir: repoA, branch: { source: 'main', feature: wtA.branch, worktreeDir: wtA.worktreeDir, reusedExisting: false } },
      { projectDir: repoB, branch: { source: 'main', feature: wtB.branch, worktreeDir: wtB.worktreeDir, reusedExisting: false } },
    ],
  });
  try {
    const report = await deletePipeline({ workspaceKey: wkey, id: 'ws01' });
    assert.ok(report && report.ok);
    assert.equal(existsSync(pdir), false, 'workspace pipeline dir removed');
    // Indexed plan/review markdown in the WORKSPACE store removed (sibling kept).
    const plans = await readdir(join(root, 'plans'));
    assert.deepEqual(plans.sort(), ['04-06-26-add-login-screen-extra.md'], 'only the non-indexed sibling survives');
    const reviews = await readdir(join(root, 'reviews'));
    assert.equal(reviews.length, 0, 'indexed review md removed');
    // BOTH per-project worktrees + branches cleaned.
    assert.equal(existsSync(wtA.worktreeDir), false, 'member A worktree gone');
    assert.equal(existsSync(wtB.worktreeDir), false, 'member B worktree gone');
    assert.ok(!(await listLocalBranches(repoA)).includes(wtA.branch), 'member A branch deleted');
    assert.ok(!(await listLocalBranches(repoB)).includes(wtB.branch), 'member B branch deleted');
  } finally {
    if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev;
  }
});

test('deletePipeline({workspaceKey}) refuses a running workspace pipeline', async () => {
  const repoA = await freshRepo();
  const repoB = await freshRepo();
  const prev = process.env.MAESTRO_HOME;
  const wkey = 'wks-demo-9f3a1c20';
  await freshWorkspaceStore({
    wkey, id: 'wsrun', base: 'add-login-screen', datePrefix: '04-06-26', status: 'running',
    members: [
      { projectDir: repoA, branch: null },
      { projectDir: repoB, branch: null },
    ],
  });
  try {
    await assert.rejects(() => deletePipeline({ workspaceKey: wkey, id: 'wsrun' }),
      (e) => e && e.code === 'RUNNING');
  } finally {
    if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev;
  }
});

test('deletePipeline({workspaceKey}) returns null for an unknown workspace id', async () => {
  const repoA = await freshRepo();
  const repoB = await freshRepo();
  const prev = process.env.MAESTRO_HOME;
  const wkey = 'wks-demo-9f3a1c20';
  await freshWorkspaceStore({
    wkey, id: 'present', base: 'add-login-screen', datePrefix: '04-06-26', status: 'done',
    members: [
      { projectDir: repoA, branch: null },
      { projectDir: repoB, branch: null },
    ],
  });
  try {
    assert.equal(await deletePipeline({ workspaceKey: wkey, id: 'nope' }), null);
  } finally {
    if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev;
  }
});

test('deletePipeline cascades: child rows (artifacts) are gone after delete', async () => {
  const repo = await freshRepo();
  const prev = process.env.MAESTRO_HOME;
  await freshStore(repo, {
    id: 'cas1', base: 'add-login-screen', datePrefix: '04-06-26', status: 'done', branch: null,
  });
  try {
    assert.equal((await listArtifacts('cas1')).length, 4, 'artifacts indexed before delete');
    const report = await deletePipeline({ key: 'proj-00000001', id: 'cas1' });
    assert.ok(report && report.ok);
    assert.equal((await listArtifacts('cas1')).length, 0, 'FK cascade cleared the artifacts rows');
  } finally {
    if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev;
  }
});
