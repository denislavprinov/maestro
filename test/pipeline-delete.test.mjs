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
