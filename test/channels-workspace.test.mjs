// test/channels-workspace.test.mjs
// The `workspace` channel arm (M3): a read-only metadata channel carrying the
// frozen description + member set, plus workspaceKey threading into the plan/review
// path allocators so a workspace run's unified artifacts route to the workspace
// store. Pure: the only IO is path STRINGS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocate, bindInputs, publish, legacyFields, CHANNEL_IDS,
} from '../src/core/channels.mjs';

const ALLOC = { projectDir: '/p', pipelineDir: '/pipe', baseName: 'feat', datePrefix: '03-06-26', cycle: 1 };
const WS_KEY = 'wks-demo-1a2b3c4d';

test('CHANNEL_IDS includes workspace (closed M3 set)', () => {
  assert.deepEqual([...CHANNEL_IDS].sort(),
    ['checklist', 'code', 'plan', 'review', 'userPrompt', 'workspace']);
});

test('allocate(workspace): metadata handle pointing at workspace-description.md', () => {
  const h = allocate('workspace', { ...ALLOC, key: 'planner' });
  assert.equal(h.kind, 'metadata');
  assert.match(h.path, /\/pipe\/workspace-description\.md$/);
});

test('allocate threads workspaceKey into the plan path (routes to the workspace store)', () => {
  const single = allocate('plan', { ...ALLOC, key: 'planner', cycle: 1 });
  const ws = allocate('plan', { ...ALLOC, key: 'planner', cycle: 1, workspaceKey: WS_KEY });
  assert.match(single.path, /\/store\/[^/]+\/plans\/03-06-26-feat\.md$/, 'single-project routes by projectKey');
  assert.match(ws.path, new RegExp(`/store/workspaces/${WS_KEY}/plans/03-06-26-feat\\.md$`),
    'workspace plan routes to the workspace store');
  assert.notEqual(single.path, ws.path);
});

test('allocate threads workspaceKey into the review path (md + json under the workspace store)', () => {
  const ws = allocate('review', { ...ALLOC, key: 'reviewer', workspaceKey: WS_KEY });
  assert.match(ws.mdPath, new RegExp(`/store/workspaces/${WS_KEY}/reviews/03-06-26-feat-impl-review\\.md$`));
  // jsonPath lives in the pipeline dir (per-cycle), unaffected by the store root.
  assert.match(ws.jsonPath, /\/pipe\/impl-review-cycle1\.json$/);
});

test('single-project allocate is byte-identical when no workspaceKey is present', () => {
  // Pin byte-identity: the M3 threading must not move any single-project path.
  const planner = allocate('plan', { ...ALLOC, key: 'planner', cycle: 1 });
  assert.match(planner.path, /\/plans\/03-06-26-feat\.md$/);
  const rev = allocate('review', { ...ALLOC, key: 'reviewer' });
  assert.match(rev.jsonPath, /\/impl-review-cycle1\.json$/);
  assert.match(rev.mdPath, /-feat-impl-review\.md$/);
});

test('bindInputs surfaces the workspace metadata channel', () => {
  const wsHandle = {
    kind: 'metadata',
    workspaceDescription: '# Workspace: Demo',
    projects: [{ projectKey: 'a-1', projectName: 'a' }],
  };
  const bus = { plan: { kind: 'artifact', path: '/x.md' }, workspace: wsHandle };
  const got = bindInputs(['plan', 'workspace'], [], bus);
  assert.equal(got.workspace, wsHandle, 'workspace channel is bound from the bus');
});

test('legacyFields exposes {workspace} on the ctx for a node that consumes it', () => {
  const wsHandle = {
    kind: 'metadata',
    workspaceDescription: '# Workspace: Demo',
    projects: [{ projectKey: 'a-1', projectName: 'a', worktreeDir: '/wt/a', checkpointRef: 'sha-a' }],
  };
  // A planner consuming userPrompt + workspace must see the workspace handle flattened
  // onto the legacy ctx so phases.mjs runners can read ctx.workspace.
  const fields = legacyFields(
    { key: 'planner' },
    { userPrompt: { answers: [] }, workspace: wsHandle },
    { plan: { path: '/v1.md' }, workspace: { kind: 'metadata', path: '/pipe/workspace-description.md' } },
    1, 'feat',
  );
  assert.equal(fields.workspace, wsHandle, 'planner ctx carries the workspace metadata');
});

test('legacyFields workspace exposure is absent for a single-project node', () => {
  const fields = legacyFields(
    { key: 'planner' },
    { userPrompt: { answers: [] } },
    { plan: { path: '/v1.md' } },
    1, 'feat',
  );
  assert.equal(fields.workspace, undefined, 'no workspace input -> no workspace field');
});

test('publish: a metadata workspace channel is never re-published (CONV-6 preserved)', () => {
  // The workspace channel is read-only metadata seeded once; publish must not fold a
  // node result onto it (it is never in produces for in-pipeline nodes at M3, but the
  // arm must be a no-op even if asked).
  const wsHandle = { kind: 'metadata', workspaceDescription: 'x' };
  const bus = { workspace: wsHandle };
  publish(['workspace'], { anything: true }, { workspace: { kind: 'metadata', path: '/p/desc.md' } }, bus);
  assert.equal(bus.workspace, wsHandle, 'workspace metadata is unchanged by publish');
});
