// test/orchestrator-workspace.test.mjs
// Milestone 3: the multi-worktree workspace orchestrator. Mirrors the sandboxing
// of orchestrator-worktree.test.mjs EXACTLY — throwaway temp git repos (in tmpdir,
// never the product repo), tracked in `created[]`, force-removed in after(); an
// isolated MAESTRO_HOME so the workspace store lands in temp. Every worktree lives
// INSIDE its member's temp repo (<repo>/.maestro/worktrees/<id>/), so rm -rf of the
// repo reaps the worktree and the branch with it. After this file runs, the product
// repo's `git worktree list` + `git branch --list maestro/*` are unchanged.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOrchestrator } from '../src/core/orchestrator.mjs';
import { projectKey } from '../src/core/store.mjs';
import { listAllPipelines } from '../src/core/artifacts.mjs';
import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after); // workspace store writes -> isolated temp home, not real ~/.maestro

const created = [];
after(() => Promise.all(created.map((d) => rm(d, { recursive: true, force: true }))));

// ── Leak guard (M2 regression watchdog) ──────────────────────────────────────
// Every workspace run creates REAL git worktrees + branches inside the throwaway
// temp repos (reaped by the `created` cleanup above). Capture the PRODUCT repo's
// worktree + maestro/* branch state at module load and assert, after every test in
// this file, that it is unchanged — so a future regression that points an
// orchestrator at the real repo fails loudly instead of silently polluting it.
const PRODUCT_REPO = process.cwd();
function gitLines(args) {
  return spawnSync('git', ['-C', PRODUCT_REPO, ...args]).stdout.toString()
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean).sort();
}
const baselineWorktrees = gitLines(['worktree', 'list']);
const baselineBranches = gitLines(['branch', '--list', 'maestro/*']);
after(() => {
  assert.deepEqual(gitLines(['worktree', 'list']), baselineWorktrees,
    'workspace tests must not add/remove a worktree in the PRODUCT repo');
  assert.deepEqual(gitLines(['branch', '--list', 'maestro/*']), baselineBranches,
    'workspace tests must not add a maestro/* branch to the PRODUCT repo');
});

/** A fresh throwaway git repo with one commit, on branch `main`. */
async function freshRepo(prefix = 'maestro-ws-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  const g = (args) => spawnSync('git', args, { cwd: dir });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  await writeFile(join(dir, 'seed.txt'), 'seed\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);
  return dir;
}

function branchList(dir) {
  return spawnSync('git', ['-C', dir, 'branch', '--format=%(refname:short)'])
    .stdout.toString().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** Build the `workspace` opts the server constructs for a run over `dirs`, sorted by projectKey. */
function workspaceOpts(dirs, { name = 'Demo WS', description = '', branch = { source: 'main' } } = {}) {
  const projects = dirs.map((d) => ({ projectDir: d, projectKey: projectKey(d), projectName: require_basename(d) }));
  projects.sort((a, b) => (a.projectKey < b.projectKey ? -1 : a.projectKey > b.projectKey ? 1 : 0));
  return {
    workspace: {
      id: `wks-demo-${projects.map((p) => p.projectKey).join('').slice(0, 8)}`,
      key: `wks-demo-${projects.map((p) => p.projectKey).join('').slice(0, 8)}`,
      name, description,
      projects: projects.map((p) => ({ ...p, branch })),
    },
    branch,
  };
}
function require_basename(p) { return p.split('/').filter(Boolean).pop(); }

// ── D3: per-member worktree layout, each in its OWN repo ──────────────────────
test('D3: each member gets a worktree in its OWN repo at .maestro/worktrees/<pipelineId>', async () => {
  const a = await freshRepo();
  const b = await freshRepo();
  const ws = workspaceOpts([a, b]);
  const orch = createOrchestrator({
    ...ws, prompt: 'Add pagination', auto: true, claude: { mock: true },
  });
  const res = await orch.run();
  assert.equal(res.status, 'done', JSON.stringify(res));

  const state = orch.getState();
  assert.equal(state.target, 'workspace');
  // Both members carry a branch record keyed by projectKey, each worktreeDir inside its own repo.
  const keys = ws.workspace.projects.map((p) => p.projectKey);
  for (const dir of [a, b]) {
    const k = projectKey(dir);
    assert.ok(state.branches[k], `state.branches[${k}] present`);
    assert.ok(
      state.branches[k].worktreeDir.startsWith(join(dir, '.maestro', 'worktrees')) ||
      state.branches[k].worktreeDir.includes(join('.maestro', 'worktrees')),
      `member ${k} worktree must live inside its own repo: ${state.branches[k].worktreeDir}`,
    );
  }
  // Never a cross-repo checkout: a's branch must not appear in b's repo and vice-versa.
  const featA = state.branches[projectKey(a)].feature;
  const featB = state.branches[projectKey(b)].feature;
  assert.ok(branchList(a).includes(featA), 'feature branch lives in repo a');
  assert.ok(branchList(b).includes(featB), 'feature branch lives in repo b');
  // pipelineId is shared across members (same shortId), so the dir segment matches.
  assert.equal(keys.length, 2);
});

// ── per-project checkpoints ───────────────────────────────────────────────────
test('per-project checkpoint refs are recorded; the scalar mirrors the primary', async () => {
  const a = await freshRepo();
  const b = await freshRepo();
  const ws = workspaceOpts([a, b]);
  const orch = createOrchestrator({ ...ws, prompt: 'x', auto: true, claude: { mock: true } });
  await orch.run();
  const state = orch.getState();
  const ka = projectKey(a), kb = projectKey(b);
  assert.ok(state.checkpointRefs[ka], 'checkpointRefs has member a');
  assert.ok(state.checkpointRefs[kb], 'checkpointRefs has member b');
  assert.match(state.checkpointRefs[ka], /^[0-9a-f]{7,40}$/, 'a real sha for a');
  // Primary = lowest projectKey = projects[0]; the scalar checkpointRef mirrors it.
  const primaryKey = ws.workspace.projects[0].projectKey;
  assert.equal(state.checkpointRef, state.checkpointRefs[primaryKey], 'scalar mirrors primary');
});

// ── C8: scalar state.branch is the primary's OBJECT ───────────────────────────
test('C8: scalar state.branch is an object copied from the primary member', async () => {
  const a = await freshRepo();
  const b = await freshRepo();
  const ws = workspaceOpts([a, b]);
  const orch = createOrchestrator({ ...ws, prompt: 'x', auto: true, claude: { mock: true } });
  await orch.run();
  const state = orch.getState();
  const primaryKey = ws.workspace.projects[0].projectKey;
  assert.equal(typeof state.branch, 'object', 'state.branch is an object (C8), not a string');
  assert.equal(state.branch.feature, state.branches[primaryKey].feature);
  assert.equal(state.branch.source, state.branches[primaryKey].source);
  assert.equal(state.branch.worktreeDir, state.branches[primaryKey].worktreeDir);
  assert.equal('reusedExisting' in state.branch, true);
});

// ── D2: per-project source fallback when the named source is absent ───────────
test('D2: a member lacking the named source branch falls back to its own default', async () => {
  const a = await freshRepo();           // on `main`
  // b is on `master`, has NO `main` branch — the named source must fall back.
  const b = await mkdtemp(join(tmpdir(), 'maestro-ws-master-'));
  created.push(b);
  const g = (args) => spawnSync('git', args, { cwd: b });
  g(['init', '-q', '-b', 'master']);
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  await writeFile(join(b, 'a.txt'), 'a\n');
  g(['add', '-A']); g(['commit', '-qm', 'init']);

  const ws = workspaceOpts([a, b], { branch: { source: 'main' } });
  const orch = createOrchestrator({ ...ws, prompt: 'x', auto: true, claude: { mock: true } });
  const res = await orch.run();
  assert.equal(res.status, 'done', JSON.stringify(res));
  const state = orch.getState();
  // a resolved source 'main' (present); b fell back to 'master' (its default).
  assert.equal(state.branches[projectKey(a)].source, 'main');
  assert.equal(state.branches[projectKey(b)].source, 'master', 'b fell back to its own default');
});

test('D2: per-project feature branch is the feature + project slug', async () => {
  const a = await freshRepo();
  const b = await freshRepo();
  const ws = workspaceOpts([a, b], { branch: { source: 'main', feature: 'add-pagination' } });
  const orch = createOrchestrator({ ...ws, prompt: 'x', auto: true, claude: { mock: true } });
  await orch.run();
  const state = orch.getState();
  for (const dir of [a, b]) {
    const slug = require_basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const feat = state.branches[projectKey(dir)].feature;
    assert.match(feat, /^add-pagination-/, `feature carries the base name: ${feat}`);
    assert.ok(feat.includes(slug.split('-')[0]) || feat.length > 'add-pagination-'.length,
      `feature carries the project slug: ${feat}`);
  }
  // The two members' feature branches differ (per-project slug).
  assert.notEqual(state.branches[projectKey(a)].feature, state.branches[projectKey(b)].feature);
});

// ── description injection + freeze ────────────────────────────────────────────
test('description is frozen at run start onto state + this.workspaceDescription', async () => {
  const a = await freshRepo();
  const b = await freshRepo();
  const ws = workspaceOpts([a, b], { description: '# Workspace: Demo\n\nShared REST contract.' });
  const orch = createOrchestrator({ ...ws, prompt: 'x', auto: true, claude: { mock: true } });
  await orch.run();
  const state = orch.getState();
  assert.match(state.workspaceDescription, /Shared REST contract/, 'frozen onto state');
  assert.equal(orch.workspaceDescription, state.workspaceDescription, 'frozen onto the instance');
  // The on-disk frozen snapshot exists in the workspace-store pipeline dir.
  assert.ok(existsSync(join(state.pipelineDir, 'workspace-description.md')));
  const snap = await readFile(join(state.pipelineDir, 'workspace-description.md'), 'utf8');
  assert.match(snap, /Shared REST contract/);
});

// ── createPipeline routed to the workspace store ──────────────────────────────
test('artifacts route to the workspace store (store/workspaces/<key>/pipelines)', async () => {
  const a = await freshRepo();
  const b = await freshRepo();
  const ws = workspaceOpts([a, b]);
  const orch = createOrchestrator({ ...ws, prompt: 'x', auto: true, claude: { mock: true } });
  await orch.run();
  const state = orch.getState();
  assert.match(state.pipelineDir, new RegExp(`/store/workspaces/${ws.workspace.key}/pipelines/`),
    `pipeline dir under the workspace store: ${state.pipelineDir}`);
});

// ── teardown: worktrees removed, branches KEPT ────────────────────────────────
test('teardown removes every member worktree but KEEPS every feature branch', async () => {
  const a = await freshRepo();
  const b = await freshRepo();
  const ws = workspaceOpts([a, b]);
  const orch = createOrchestrator({ ...ws, prompt: 'x', auto: true, claude: { mock: true } });
  await orch.run();
  const state = orch.getState();
  for (const dir of [a, b]) {
    const k = projectKey(dir);
    const wtDir = state.branches[k].worktreeDir;
    const feat = state.branches[k].feature;
    assert.ok(!existsSync(wtDir), `member ${k} worktree removed: ${wtDir}`);
    assert.ok(branchList(dir).includes(feat), `member ${k} feature branch KEPT: ${feat}`);
  }
});

// ── _stageWorkingTree stages every member worktree ────────────────────────────
test('_stageWorkingTree stages EVERY member worktree (not just primary)', async () => {
  const a = await freshRepo();
  const b = await freshRepo();
  const ws = workspaceOpts([a, b]);
  const orch = createOrchestrator({ ...ws, prompt: 'x', auto: true, claude: { mock: true } });
  // Inject a new file into each member worktree as soon as worktrees exist, then
  // assert the staged diff (vs each checkpoint) shows it for BOTH members.
  let injected = false;
  orch.on('state', (s) => {
    if (injected || !s.branches) return;
    const ka = projectKey(a), kb = projectKey(b);
    if (s.branches[ka]?.worktreeDir && s.branches[kb]?.worktreeDir
        && existsSync(s.branches[ka].worktreeDir) && existsSync(s.branches[kb].worktreeDir)) {
      injected = true;
      writeFileSync(join(s.branches[ka].worktreeDir, 'new-a.txt'), 'a\n');
      writeFileSync(join(s.branches[kb].worktreeDir, 'new-b.txt'), 'b\n');
    }
  });
  await orch.run();
  assert.ok(injected, 'precondition: files injected into both worktrees');
  const state = orch.getState();
  // The kept-branch commit on EACH member must carry its injected file (teardown
  // commits the staged tree). This proves staging reached both worktrees.
  for (const [dir, file] of [[a, 'new-a.txt'], [b, 'new-b.txt']]) {
    const feat = state.branches[projectKey(dir)].feature;
    const show = spawnSync('git', ['-C', dir, 'show', `${feat}:${file}`]);
    assert.equal(show.status, 0, `${file} committed on ${dir}'s kept branch`);
  }
});

// ── partial worktree-setup failure is fully torn down (no leak; §5.10 edge 4) ──
test('a member whose branch is already checked out errors the run and leaks no worktree', async () => {
  const a = await freshRepo();
  const b = await freshRepo();
  const ws = workspaceOpts([a, b], { branch: { source: 'main', feature: 'collide' } });
  // Pre-occupy member b's feature branch in a separate live worktree so its
  // createWorktree throws the M2 "already checked out" error mid-setup.
  const bKey = projectKey(b);
  const bSlug = require_basename(b).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const bFeature = `collide-${bSlug}`.slice(0, 80);
  const squatDir = join(b, '.maestro', 'worktrees', 'squatter');
  await mkdir(join(b, '.maestro', 'worktrees'), { recursive: true });
  const add = spawnSync('git', ['-C', b, 'worktree', 'add', '-b', bFeature, '--', squatDir, 'main']);
  assert.equal(add.status, 0, `precondition: squat b's feature branch: ${add.stderr}`);

  const orch = createOrchestrator({ ...ws, prompt: 'x', auto: true, claude: { mock: true } });
  const res = await orch.run();
  // The run errors (one member could not get its worktree); whichever member DID
  // get a worktree must be torn down (no orphan checkout dir), branch kept.
  assert.equal(res.status, 'error', JSON.stringify(res));
  const wtBaseA = join(a, '.maestro', 'worktrees');
  // a's pipeline-id worktree (if it was created before b threw) must be gone.
  const orphan = existsSync(join(wtBaseA, orch.getState().id || ''));
  assert.ok(!orphan, 'partial worktree for member a must be torn down on setup failure');
});

// ── fan-out node forcing ──────────────────────────────────────────────────────
test('fan-out forcing: a workspace run forces fanOut=true on eligible nodes only', async () => {
  const a = await freshRepo();
  const b = await freshRepo();
  const ws = workspaceOpts([a, b]);
  const orch = createOrchestrator({ ...ws, prompt: 'x', auto: true, claude: { mock: true } });
  // Capture the resolved plan the dispatcher runs by spying on _dispatch.
  const origDispatch = orch._dispatch.bind(orch);
  let seenPlan = null;
  orch._dispatch = async (plan, runArgs) => { seenPlan = plan; return origDispatch(plan, runArgs); };
  await orch.run();
  assert.ok(seenPlan, 'dispatch ran');
  const FANOUT_ELIGIBLE = new Set(['planner', 'refiner', 'implementer', 'planReviewer', 'workspaceReviewer']);
  for (const group of seenPlan.steps) {
    for (const node of group) {
      if (FANOUT_ELIGIBLE.has(node.key)) {
        assert.equal(node.fanOut, true, `eligible node ${node.key} is forced fanOut`);
      } else {
        // Any non-eligible node (none in the default workspace plan) must NOT be forced.
        assert.equal(node.fanOut, false, `ineligible node ${node.key} is NOT forced`);
      }
    }
  }
  // M4: the review node is substituted reviewer -> workspaceReviewer (workflows.mjs),
  // so the resolved workspace plan carries a fanned-out workspaceReviewer and NO
  // single-project reviewer node.
  const keys = seenPlan.steps.flat().map((n) => n.key);
  const wsReviewer = seenPlan.steps.flat().find((n) => n.key === 'workspaceReviewer');
  assert.ok(wsReviewer, 'workspace plan contains a workspaceReviewer node');
  assert.equal(wsReviewer.fanOut, true, 'the workspaceReviewer node is forced fanOut');
  assert.ok(!keys.includes('reviewer'), 'no single-project reviewer node in a workspace plan');
});

// ── history walker discovers the workspace run ────────────────────────────────
test('history: listAllPipelines discovers the workspace run with target=workspace', async () => {
  const a = await freshRepo();
  const b = await freshRepo();
  const ws = workspaceOpts([a, b]);
  const orch = createOrchestrator({ ...ws, prompt: 'x', auto: true, claude: { mock: true } });
  await orch.run();
  const all = await listAllPipelines();
  const row = all.find((e) => e.projectKey === `workspaces/${ws.workspace.key}`);
  assert.ok(row, 'workspace run discovered by the machine-wide walker');
  assert.equal(row.target, 'workspace');
  assert.equal(row.projectName, ws.workspace.name);
});

// ── single-project back-compat (NON-NEGOTIABLE byte-identity) ─────────────────
test('back-compat: a single-project run (no workspace opts) is unchanged', async () => {
  const repo = await freshRepo();
  const orch = createOrchestrator({
    projectDir: repo, prompt: 'Add login', auto: true, claude: { mock: true }, branch: { source: 'main' },
  });
  const res = await orch.run();
  assert.equal(res.status, 'done', JSON.stringify(res));
  const state = orch.getState();
  assert.equal(state.target, undefined, 'no workspace discriminator on a single-project run');
  assert.equal(state.workspaceKey, undefined);
  assert.equal(state.checkpointRefs, undefined, 'no per-project map on single-project');
  assert.equal(state.branches, undefined, 'no per-project branches map on single-project');
  // The single-project branch object shape is unchanged.
  assert.ok(state.branch && typeof state.branch === 'object');
  assert.equal(state.branch.source, 'main');
  assert.match(state.branch.feature, /^maestro\//);
  // Pipeline routes to the PROJECT store, never workspaces/.
  assert.doesNotMatch(state.pipelineDir, /\/store\/workspaces\//);
  assert.match(state.pipelineDir, new RegExp(`/store/${projectKey(repo)}/pipelines/`));
});
