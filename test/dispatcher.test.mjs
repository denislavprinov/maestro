// test/dispatcher.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator, createOrchestrator as makeOrch } from '../src/core/orchestrator.mjs';

const tmpDirs = [];
async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-dispatch-'));
  tmpDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

test('_nodeCtx tags every emit with nodeId/stepIndex/cycle', () => {
  const orch = createOrchestrator({ projectDir: '/tmp/proj' });
  orch.pipeline = { id: 'x', dir: '/tmp/proj', promptText: 'demo' };
  const node = { nodeId: 's2_1', key: 'implementer', runnerType: 'producer' };
  const tagged = [];
  orch.on('log', (l) => tagged.push(l));
  const ctx = orch._nodeCtx(node, { stepIndex: 2, cycle: 3 });
  ctx.onEvent({ type: 'assistant', text: 'hi', raw: {} });
  assert.equal(tagged.length, 1);
  assert.equal(tagged[0].nodeId, 's2_1');
  assert.equal(tagged[0].stepIndex, 2);
  assert.equal(tagged[0].cycle, 3);
});

test('cost is attributed to the node step key, not the live phase', () => {
  const orch = createOrchestrator({ projectDir: '/tmp/proj' });
  orch.pipeline = { id: 'x', dir: '/tmp/proj', promptText: 'demo' };
  // Open TWO node steps (simulating an in-flight parallel group).
  const nodeA = { nodeId: 'p_a', key: 'implementer', runnerType: 'producer' };
  const nodeB = { nodeId: 'p_b', key: 'reviewer', runnerType: 'verifier' };
  orch._nodeStep(nodeA, 0, 1, 'start');
  orch._nodeStep(nodeB, 0, 1, 'start');
  const ctxA = orch._nodeCtx(nodeA, { stepIndex: 0, cycle: 1 });
  const ctxB = orch._nodeCtx(nodeB, { stepIndex: 0, cycle: 1 });
  // Interleaved result events — must land on their OWN node, not whoever is "live".
  ctxB.onEvent({ type: 'result', costUsd: 0.05, raw: { type: 'result' } });
  ctxA.onEvent({ type: 'result', costUsd: 0.02, raw: { type: 'result' } });
  const st = orch.getState();
  const keyA = orch._stepKeyFor(nodeA, 0, 1);
  const keyB = orch._stepKeyFor(nodeB, 0, 1);
  assert.equal(st.steps.find((s) => s.key === keyA).costUsd, 0.02);
  assert.equal(st.steps.find((s) => s.key === keyB).costUsd, 0.05);
  assert.equal(st.totalCostUsd, 0.07);
});

// ── dispatcher: parallel walk + generic feedback loop ──────────────────────────

// Build a minimally-initialized orchestrator ready to dispatch: pipeline dir +
// prompts stubbed, git/preflight skipped. We call _dispatch directly.
async function primed(projectDir) {
  const orch = makeOrch({ projectDir, prompt: 'demo', auto: true, claude: { mock: true } });
  orch.pipeline = { id: 'p1', dir: projectDir, promptText: 'demo' };
  orch.state.id = 'p1';
  orch.state.pipelineDir = projectDir;
  orch.baseName = 'feature';
  orch.agentPrompts = {};
  orch.toolInstruction = '';
  orch.checkpointRef = null;
  orch._setStatus('running');
  return orch;
}

test('parallel step: both nodes run, both emit (tagged), both complete', async () => {
  const dir = await makeTmpDir();
  const orch = await primed(dir);
  const ran = [];
  const emits = [];
  orch.on('log', (l) => { if (l.nodeId) emits.push(l.nodeId); });
  // Stub the registry the dispatcher consults.
  orch._runners = {
    producer: async (ctx) => {
      ran.push(ctx.node.nodeId);
      ctx.onEvent({ type: 'assistant', text: `did ${ctx.node.nodeId}`, raw: {} });
      return { status: 'ok', summary: ctx.node.nodeId };
    },
    verifier: async () => ({ status: 'ok', issues: [], review: { issues: [], summary: '' } }),
  };
  const plan = {
    id: 'wf_x', name: 'X',
    steps: [[
      { nodeId: 'a', key: 'implementer', runnerType: 'producer' },
      { nodeId: 'b', key: 'implementer', runnerType: 'producer' },
    ]],
    feedbacks: [],
  };
  await orch._dispatch(plan);
  assert.deepEqual(ran.sort(), ['a', 'b'], 'both parallel nodes ran');
  assert.deepEqual([...new Set(emits)].sort(), ['a', 'b'], 'both emitted node-tagged events');
  const st = orch.getState();
  assert.ok(st.steps.find((s) => s.nodeId === 'a' && s.status === 'done'));
  assert.ok(st.steps.find((s) => s.nodeId === 'b' && s.status === 'done'));
});
