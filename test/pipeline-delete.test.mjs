// test/pipeline-delete.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { deletePipeline } from '../src/core/pipeline-delete.mjs';
import { listLocalBranches, createWorktree } from '../src/core/worktree.mjs';

const created = [];
after(() => Promise.all(created.map((d) => rm(d, { recursive: true, force: true }))));

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
// must survive (proves name-matching never over-deletes). The pipeline dir is
// named exactly like the real one: <datePrefix>-<base>-<id>.
async function freshStore(repoDir, { id, base, datePrefix, status, branch, title }) {
  const home = await mkdtemp(join(tmpdir(), 'maestro-del-store-'));
  created.push(home);
  const key = 'proj-00000001';
  const root = join(home, '.maestro', 'store', key);
  const pdir = join(root, 'pipelines', `${datePrefix}-${base}-${id}`);
  await mkdir(join(pdir, 'extras'), { recursive: true });
  const state = { id, title: title ?? 'Add login screen', status, projectDir: repoDir, projectKey: key };
  if (branch !== undefined) state.branch = branch;
  await writeFile(join(pdir, 'state.json'), JSON.stringify(state), 'utf8');
  await writeFile(join(pdir, 'prompt.md'), `# ${title ?? 'Add login screen'}\n`, 'utf8');
  await writeFile(join(pdir, 'impl-review-cycle1.json'), '{}', 'utf8');
  await mkdir(join(root, 'plans'), { recursive: true });
  await mkdir(join(root, 'reviews'), { recursive: true });
  await writeFile(join(root, 'plans', `${datePrefix}-${base}.md`), '# plan', 'utf8');
  await writeFile(join(root, 'plans', `${datePrefix}-${base}-v2.md`), '# plan v2', 'utf8');
  await writeFile(join(root, 'reviews', `${datePrefix}-${base}-impl-review.md`), '# r', 'utf8');
  await writeFile(join(root, 'reviews', `${datePrefix}-${base}-plan-review.md`), '# r', 'utf8');
  // Sibling that shares the date but a longer base — must NOT be deleted.
  await writeFile(join(root, 'plans', `${datePrefix}-${base}-extra.md`), '# keep', 'utf8');
  return { home, key, root, pdir };
}

// store.mjs reads MAESTRO_HOME and appends '.maestro', so MAESTRO_HOME = <home>.
const homeOf = (root) => join(root, '..', '..', '..');

// A workspace store dir (store/workspaces/<wkey>/) with one pipeline whose
// state.branches is the per-project map. `members` is [{ projectDir, branch }].
async function freshWorkspaceStore({ wkey, id, base, datePrefix, status, title, members }) {
  const home = await mkdtemp(join(tmpdir(), 'maestro-del-ws-'));
  created.push(home);
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
  const state = {
    id, title: title ?? 'Add login screen', status, target: 'workspace',
    workspaceKey: wkey, workspaceId: wkey, projects, branches,
  };
  await writeFile(join(pdir, 'state.json'), JSON.stringify(state), 'utf8');
  await writeFile(join(pdir, 'prompt.md'), `# ${title ?? 'Add login screen'}\n`, 'utf8');
  await mkdir(join(root, 'plans'), { recursive: true });
  await mkdir(join(root, 'reviews'), { recursive: true });
  await writeFile(join(root, 'plans', `${datePrefix}-${base}.md`), '# plan', 'utf8');
  await writeFile(join(root, 'reviews', `${datePrefix}-${base}-impl-review.md`), '# r', 'utf8');
  await writeFile(join(root, 'plans', `${datePrefix}-${base}-extra.md`), '# keep', 'utf8');
  // MAESTRO_HOME = <home>; root nests 4 deep (.maestro/store/workspaces/<wkey>).
  return { home, root, pdir };
}

test('deletePipeline removes dir, plan/review files, local branch; keeps siblings + remote', async () => {
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
  process.env.MAESTRO_HOME = homeOf(root);
  try {
    const report = await deletePipeline({ key: 'proj-00000001', id: 'abc123' });
    assert.ok(report && report.ok);
    assert.equal(existsSync(pdir), false, 'pipeline dir removed');
    const plans = await readdir(join(root, 'plans'));
    assert.deepEqual(plans.sort(), ['04-06-26-add-login-screen-extra.md'], 'only the sibling survives');
    const reviews = await readdir(join(root, 'reviews'));
    assert.equal(reviews.length, 0, 'both review md removed');
    assert.equal(existsSync(worktreeDir), false, 'worktree gone');
    assert.ok(!(await listLocalBranches(repo)).includes(branch), 'local branch deleted');
  } finally {
    if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev;
  }
});

test('deletePipeline recovers the base from the dir slug / prompt when title is auto', async () => {
  // No persisted baseName, and the stored title is the AUTO title (equals the
  // pipeline dir basename), exactly the case _deriveBaseName ignores. Recovery
  // must come from the dir slug (and/or prompt.md first line), not the title.
  const repo = await freshRepo();
  const prev = process.env.MAESTRO_HOME;
  const { root, pdir } = await freshStore(repo, {
    id: 'zz', base: 'rename-widget', datePrefix: '04-06-26', status: 'done',
    title: '04-06-26-rename-widget-zz', branch: null,
  });
  process.env.MAESTRO_HOME = homeOf(root);
  try {
    const report = await deletePipeline({ key: 'proj-00000001', id: 'zz' });
    assert.ok(report && report.ok);
    assert.equal(existsSync(pdir), false, 'pipeline dir removed');
    const plans = await readdir(join(root, 'plans'));
    assert.deepEqual(plans.sort(), ['04-06-26-rename-widget-extra.md'], 'dir-slug recovery removed v1+v2, kept sibling');
  } finally {
    if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev;
  }
});

test('deletePipeline refuses a running pipeline', async () => {
  const repo = await freshRepo();
  const prev = process.env.MAESTRO_HOME;
  const { root } = await freshStore(repo, {
    id: 'run1', base: 'add-login-screen', datePrefix: '04-06-26', status: 'running', branch: null,
  });
  process.env.MAESTRO_HOME = homeOf(root);
  try {
    await assert.rejects(() => deletePipeline({ key: 'proj-00000001', id: 'run1' }),
      (e) => e && e.code === 'RUNNING');
  } finally {
    if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev;
  }
});

test('deletePipeline returns null for an unknown id', async () => {
  const repo = await freshRepo();
  const prev = process.env.MAESTRO_HOME;
  const { root } = await freshStore(repo, {
    id: 'x', base: 'add-login-screen', datePrefix: '04-06-26', status: 'done', branch: null,
  });
  process.env.MAESTRO_HOME = homeOf(root);
  try {
    assert.equal(await deletePipeline({ key: 'proj-00000001', id: 'nope' }), null);
  } finally {
    if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev;
  }
});

test('deletePipeline({workspaceKey}) removes the ws-store dir + iterates state.branches per project', async () => {
  // Two real repos, each with its own worktree + feature branch, recorded in the
  // per-project state.branches map. Delete must clean BOTH and remove the ws dir.
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
  const { home, root, pdir } = await freshWorkspaceStore({
    wkey, id: 'ws01', base: 'add-login-screen', datePrefix: '04-06-26', status: 'done',
    title: 'Add login screen',
    members: [
      { projectDir: repoA, branch: { source: 'main', feature: wtA.branch, worktreeDir: wtA.worktreeDir, reusedExisting: false } },
      { projectDir: repoB, branch: { source: 'main', feature: wtB.branch, worktreeDir: wtB.worktreeDir, reusedExisting: false } },
    ],
  });
  process.env.MAESTRO_HOME = home;
  try {
    const report = await deletePipeline({ workspaceKey: wkey, id: 'ws01' });
    assert.ok(report && report.ok);
    assert.equal(existsSync(pdir), false, 'workspace pipeline dir removed');
    // Shared plan/review markdown in the WORKSPACE store removed (sibling kept).
    const plans = await readdir(join(root, 'plans'));
    assert.deepEqual(plans.sort(), ['04-06-26-add-login-screen-extra.md'], 'only the sibling survives');
    const reviews = await readdir(join(root, 'reviews'));
    assert.equal(reviews.length, 0, 'review md removed');
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
  const { home } = await freshWorkspaceStore({
    wkey, id: 'wsrun', base: 'add-login-screen', datePrefix: '04-06-26', status: 'running',
    members: [
      { projectDir: repoA, branch: null },
      { projectDir: repoB, branch: null },
    ],
  });
  process.env.MAESTRO_HOME = home;
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
  const { home } = await freshWorkspaceStore({
    wkey, id: 'present', base: 'add-login-screen', datePrefix: '04-06-26', status: 'done',
    members: [
      { projectDir: repoA, branch: null },
      { projectDir: repoB, branch: null },
    ],
  });
  process.env.MAESTRO_HOME = home;
  try {
    assert.equal(await deletePipeline({ workspaceKey: wkey, id: 'nope' }), null);
  } finally {
    if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev;
  }
});
