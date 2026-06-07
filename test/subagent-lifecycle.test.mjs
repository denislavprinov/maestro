// test/subagent-lifecycle.test.mjs — spawn/finish reducer over _onAgentEvent
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrator } from '../src/core/orchestrator.mjs';

const ATTR = { nodeId: 'n1', stepIndex: 2, cycle: 1, stepKey: '2:n1' };
const spawnEvt = (id, name = 'Task', description = 'research auth') => ({
  type: 'assistant',
  raw: { type: 'assistant', message: { content: [
    { type: 'tool_use', id, name, input: { description } },
  ] } },
});

function fresh() { return createOrchestrator({ projectDir: '/tmp/proj' }); }

test('a new Task tool_use pushes a running sub-agent record carrying attr', () => {
  const orch = fresh();
  orch._onAgentEvent('planner', spawnEvt('toolu_A'), ATTR);
  assert.equal(orch.state.subAgents.length, 1);
  const r = orch.state.subAgents[0];
  assert.equal(r.id, 'toolu_A');
  assert.equal(r.label, 'research auth');
  assert.equal(r.nodeId, 'n1');
  assert.equal(r.stepIndex, 2);
  assert.equal(r.cycle, 1);
  assert.equal(r.stepKey, '2:n1');
  assert.equal(r.status, 'running');
  assert.ok(r.startedAt, 'startedAt stamped');
  assert.equal(r.finishedAt, null);
});

test('spawn emits a subagent event with transition:spawn and the record fields', () => {
  const orch = fresh();
  const evts = [];
  orch.on('subagent', (m) => evts.push(m));
  orch._onAgentEvent('planner', spawnEvt('toolu_A'), ATTR);
  assert.equal(evts.length, 1);
  assert.equal(evts[0].transition, 'spawn');
  assert.equal(evts[0].id, 'toolu_A');
  assert.equal(evts[0].label, 'research auth');
  assert.equal(evts[0].nodeId, 'n1');
  assert.equal(evts[0].stepKey, '2:n1');
  assert.equal(evts[0].stepIndex, 2);
  assert.equal(evts[0].cycle, 1);
  assert.equal(evts[0].status, 'running');
  assert.ok(evts[0].ts, 'carries a ts');
});

test('the same Task id is recorded once (idempotent spawn)', () => {
  const orch = fresh();
  orch._onAgentEvent('planner', spawnEvt('toolu_A'), ATTR);
  orch._onAgentEvent('planner', spawnEvt('toolu_A'), ATTR);
  assert.equal(orch.state.subAgents.length, 1, 'a repeated tool_use id does not duplicate');
});

test('a spawn with no attr in scope (clarify pre-step) is ignored, not crashed', () => {
  const orch = fresh();
  orch._onAgentEvent('planner', spawnEvt('toolu_A')); // attr === null
  assert.equal(orch.state.subAgents.length, 0, 'no attr → no record (cannot attribute to a step)');
});
