// test/dispatcher-gate.test.mjs
// Shared-budget semantics: fb_gate and fb_review with loopGroup 'impl' draw from
// ONE cycle counter. Plan: implementer -> gate -> reviewer. The stub gate blocks
// twice, then passes; the stub reviewer blocks once. maxCycles 3 means the loop
// may rewind twice in total (cycle 1 -> 2 -> 3); the third blocking verdict hits
// the _ask gate (auto mode answers 'continue').
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator as makeOrchBase } from '../src/core/orchestrator.mjs';
import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after); // file-wide store isolation for tests that don't sandbox themselves

const tmpDirs = [];
async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-dispatch-gate-'));
  tmpDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

// Build a minimally-initialized orchestrator ready to dispatch: pipeline dir +
// prompts stubbed, git/preflight skipped. We call _dispatch directly (mirrors
// dispatcher.test.mjs's `primed()` helper).
async function makeOrch({ runners, auto = true }) {
  const dir = await makeTmpDir();
  const orch = makeOrchBase({ projectDir: dir, prompt: 'demo', auto, claude: { mock: true } });
  orch.pipeline = { id: 'p1', dir, promptText: 'demo' };
  orch.state.id = 'p1';
  orch.state.pipelineDir = dir;
  orch.baseName = 'feature';
  orch.agentPrompts = {};
  orch.toolInstruction = '';
  orch.checkpointRef = null;
  orch._setStatus('running');
  orch._runners = runners;
  return orch;
}

test('loopGroup: gate and review failures share one cycle budget', async () => {
  const calls = { impl: 0, gate: 0, review: 0 };
  const blockedResult = (key) => ({
    status: 'blocked',
    issues: [{ severity: 'critical', title: `${key} blocked` }],
    review: { issues: [{ severity: 'critical', title: `${key} blocked` }], summary: '' },
    summary: '',
    reviewMdPath: '/tmp/x.md',
  });
  const runners = {
    producer: async () => { calls.impl += 1; return { status: 'ok', summary: '' }; },
    verifier: async (ctx) => {
      if (ctx.node.key === 'shellGate') {
        calls.gate += 1;
        return calls.gate <= 2 ? blockedResult('gate') : { status: 'ok', issues: [], review: { issues: [], summary: '' }, summary: '' };
      }
      calls.review += 1;
      return calls.review === 1 ? blockedResult('review') : { status: 'ok', issues: [], review: { issues: [], summary: '' }, summary: '' };
    },
  };
  const plan = {
    id: 'wf_test', name: 'test',
    steps: [
      [{ nodeId: 's_impl', key: 'implementer', runnerType: 'producer', consumes: [], optionalConsumes: [], produces: [], connectsTo: '*' }],
      [{ nodeId: 's_gate', key: 'shellGate', runnerType: 'verifier', commands: ['true'], consumes: [], optionalConsumes: [], produces: [], connectsTo: '*' }],
      [{ nodeId: 's_rev', key: 'reviewer', runnerType: 'verifier', consumes: [], optionalConsumes: [], produces: [], connectsTo: '*' }],
    ],
    feedbacks: [
      { id: 'fb_gate', from: 's_gate', to: 's_impl', maxCycles: 3, gate: 'hasBlocking', loopGroup: 'impl' },
      { id: 'fb_review', from: 's_rev', to: 's_impl', maxCycles: 3, gate: 'hasBlocking', loopGroup: 'impl' },
    ],
  };
  const orch = await makeOrch({ runners, auto: true });
  await orch._dispatch(plan);
  // cycle budget 3 shared: gate fail (cycle->2), gate fail (cycle->3), gate pass,
  // review fail -> budget exhausted -> auto 'continue' (NO extra implementer run).
  assert.equal(calls.gate, 3);
  assert.equal(calls.review, 1);
  assert.equal(calls.impl, 3); // initial + 2 rewinds, none after the exhausted review
});
