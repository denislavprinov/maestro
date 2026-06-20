// test/phases-workspace.test.mjs
// Workspace prompt-injection helpers (M3): workspaceContextBlock (cap + ellipsis),
// workspaceFanOutDirective (per-strategy pure text + anti-recursion), the optional
// 4th arg to buildSystemPrompt, and the taskHeader `## Workspace projects` block.
// All pure (no IO, no spawn). Byte-identity for single-project is pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  workspaceContextBlock, workspaceFanOutDirective, buildSystemPrompt, taskHeader,
} from '../src/core/phases.mjs';

const WS = {
  description: '# Workspace: Demo\n\nTwo services share a REST contract.',
  projects: [
    { projectKey: 'iam-1a2b3c4d', projectName: 'iam', worktreeDir: '/wt/iam', checkpointRef: 'sha-iam' },
    { projectKey: 'ui-5e6f7a8b', projectName: 'ui', worktreeDir: '/wt/ui', checkpointRef: 'sha-ui' },
  ],
};

// ── workspaceContextBlock ────────────────────────────────────────────────────
test('workspaceContextBlock: returns "" when no workspace (single-project byte-identity)', () => {
  assert.equal(workspaceContextBlock(undefined), '');
  assert.equal(workspaceContextBlock(null), '');
  assert.equal(workspaceContextBlock({}), '', 'no description -> empty');
  assert.equal(workspaceContextBlock({ description: '' }), '', 'empty description -> empty');
});

test('workspaceContextBlock: emits the heading, the description, and the member names', () => {
  const b = workspaceContextBlock(WS);
  assert.match(b, /## Workspace Context/);
  assert.match(b, /share a REST contract/);
  assert.match(b, /Member projects: iam, ui\./);
});

test('workspaceContextBlock: injects the FULL description, no cap, no ellipsis', () => {
  const long = '# Workspace: Big\n\n' + 'x'.repeat(5000);
  const b = workspaceContextBlock({ description: long, projects: [] });
  assert.ok(b.includes('x'.repeat(5000)), 'full description present verbatim');
  assert.ok(!b.includes('…'), 'no truncation ellipsis');
});

test('workspaceContextBlock: reads the real channel shape (workspaceDescription key)', () => {
  // Mirrors orchestrator.mjs#_workspaceChannel: the bus channel uses `workspaceDescription`,
  // NOT `description`. This is the production shape that buildSystemPrompt receives.
  const ws = {
    kind: 'metadata',
    workspaceDescription: '# Workspace: Real\n\nServices share a REST contract.',
    projects: [{ projectName: 'iam' }, { projectName: 'ui' }],
  };
  const b = workspaceContextBlock(ws);
  assert.match(b, /## Workspace Context/);
  assert.match(b, /share a REST contract/);
  assert.match(b, /Member projects: iam, ui\./);
});

// ── buildSystemPrompt 4th arg ────────────────────────────────────────────────
test('buildSystemPrompt: 4th arg injects the workspace block AFTER tool, BEFORE body', () => {
  const sys = buildSystemPrompt('TOOL_INSTRUCTION', 'AGENT_BODY', 'planner-plan', WS);
  const iTool = sys.indexOf('TOOL_INSTRUCTION');
  const iWs = sys.indexOf('## Workspace Context');
  const iBody = sys.indexOf('AGENT_BODY');
  assert.ok(iTool >= 0 && iWs >= 0 && iBody >= 0, 'all three present');
  assert.ok(iTool < iWs && iWs < iBody, `order: tool(${iTool}) < ws(${iWs}) < body(${iBody})`);
});

test('buildSystemPrompt: no 4th arg -> single-project prompt is byte-identical', () => {
  const without = buildSystemPrompt('TOOL', 'BODY', 'planner-plan');
  const withUndef = buildSystemPrompt('TOOL', 'BODY', 'planner-plan', undefined);
  assert.equal(without, withUndef);
  assert.doesNotMatch(without, /## Workspace Context/);
  assert.equal(without, 'TOOL\n\nBODY');
});

// ── workspaceFanOutDirective ─────────────────────────────────────────────────
test('workspaceFanOutDirective: explore strategy mentions one read-only sub-agent per project + anti-recursion', () => {
  const d = workspaceFanOutDirective('explore', WS);
  assert.match(d, /per (member )?project/i);
  assert.match(d, /read-only/i);
  assert.match(d, /projectKey/, 'merge sorted by projectKey');
  assert.match(d, /MUST NOT.*re-?fan-?out|never.*re-?fan-?out|not.*spawn.*sub-agent/i,
    'anti-recursion rule present');
});

test('workspaceFanOutDirective: task strategy mentions one sub-agent per plan task editing named projects', () => {
  const d = workspaceFanOutDirective('task', WS);
  assert.match(d, /task/i);
  assert.match(d, /Projects:/, 'reads the Projects: tag');
  assert.match(d, /MUST NOT.*re-?fan-?out|never.*re-?fan-?out|not.*spawn.*sub-agent/i);
});

test('workspaceFanOutDirective: review strategy mentions one reviewer per touched project + union of issues', () => {
  const d = workspaceFanOutDirective('review', WS);
  assert.match(d, /touched|changed/i);
  assert.match(d, /union/i, 'union of issues, never collapse');
  assert.match(d, /MUST NOT.*re-?fan-?out|never.*re-?fan-?out|not.*spawn.*sub-agent/i);
});

test('workspaceFanOutDirective: unknown strategy / no workspace -> "" (safe)', () => {
  assert.equal(workspaceFanOutDirective('explore', null), '');
  assert.equal(workspaceFanOutDirective('nope', WS), '');
});

// ── taskHeader workspace arm ─────────────────────────────────────────────────
const baseCtx = { projectDir: '/p', pipelineDir: '/pipe', taskPrompt: 'BUILD' };

test('taskHeader: with ctx.workspace lists each member worktree dir + checkpoint ref', () => {
  const h = taskHeader({ ...baseCtx, node: { key: 'planner' }, inputs: { userPrompt: {} }, workspace: WS }, 'Plan');
  assert.match(h, /## Workspace projects/);
  assert.match(h, /iam/);
  assert.match(h, /\/wt\/iam/, 'iam worktree dir');
  assert.match(h, /sha-iam/, 'iam checkpoint ref');
  assert.match(h, /\/wt\/ui/, 'ui worktree dir');
  assert.match(h, /sha-ui/, 'ui checkpoint ref');
});

test('taskHeader: no ctx.workspace -> no Workspace projects block (single-project byte-identity)', () => {
  const h = taskHeader({ ...baseCtx, node: { key: 'planner' }, inputs: { userPrompt: {} } }, 'Plan');
  assert.doesNotMatch(h, /## Workspace projects/);
});
