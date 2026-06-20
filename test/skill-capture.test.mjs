// test/skill-capture.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrator } from '../src/core/orchestrator.mjs';

const ATTR = { nodeId: 'n1', stepIndex: 2, cycle: 1, stepKey: '2:n1' };

// One assistant turn (MAIN stream: no parent_tool_use_id) with the given tool_use blocks.
const mainTurn = (blocks) => ({ type: 'assistant', raw: { type: 'assistant', message: { content: blocks } } });
// One assistant turn on a SUB-agent stream (parent_tool_use_id = the spawn id).
const subTurn = (parentId, blocks) => ({
  type: 'assistant',
  raw: { type: 'assistant', parent_tool_use_id: parentId, message: { content: blocks } },
});
const spawn = (id, name = 'Agent', description = 'area A') => mainTurn([{ type: 'tool_use', id, name, input: { description } }]);

function orchWithStep() {
  const orch = createOrchestrator({ projectDir: '/tmp/proj' });
  orch.state.steps.push({ key: ATTR.stepKey, nodeId: ATTR.nodeId, cycle: ATTR.cycle, status: 'running' });
  return orch;
}

test('main-agent Skill tool_use attaches a "skill:<name>" to its step + emits stepskills', () => {
  const orch = orchWithStep();
  const deltas = [];
  orch.on('stepskills', (d) => deltas.push(d));
  orch._onAgentEvent('planner', mainTurn([{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'graphify' } }]), ATTR);
  assert.deepEqual(orch.state.steps[0].skills, ['skill:graphify']);
  assert.equal(deltas.length, 1);
  assert.deepEqual(deltas[0].skills, ['skill:graphify']);
  assert.equal(deltas[0].nodeId, 'n1');
  assert.equal(deltas[0].cycle, 1);
});

test('MCP tool_use becomes "mcp:<server>" (plugin_ stripped, dup words collapsed)', () => {
  const orch = orchWithStep();
  orch._onAgentEvent('planner', mainTurn([
    { type: 'tool_use', id: 't2', name: 'mcp__plugin_playwright_playwright__browser_navigate', input: { url: 'x' } },
    { type: 'tool_use', id: 't3', name: 'mcp__firebase__firebase_deploy', input: {} },
  ]), ATTR);
  assert.deepEqual(orch.state.steps[0].skills, ['mcp:playwright', 'mcp:firebase']);
});

test('the real doubled plugin_<x>_<x> prefix collapses (env-accurate names)', () => {
  const orch = orchWithStep();
  orch._onAgentEvent('planner', mainTurn([
    { type: 'tool_use', id: 'f', name: 'mcp__plugin_firebase_firebase__firebase_deploy', input: {} },
  ]), ATTR);
  assert.deepEqual(orch.state.steps[0].skills, ['mcp:firebase']);
});

test('core/spawn tools are NOT skills (Read/Bash/Grep/Glob/Task/Agent/WebFetch excluded)', () => {
  const orch = orchWithStep();
  orch._onAgentEvent('planner', mainTurn([
    { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x' } },
    { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_use', id: 'c', name: 'Task', input: { description: 'd' } },
  ]), ATTR);
  assert.equal(orch.state.steps[0].skills, undefined); // nothing recorded, no emit
});

test('sub-agent skills attach to the spawned record by parent_tool_use_id; deltas carry skills', () => {
  const orch = orchWithStep();
  const subDeltas = [];
  orch.on('subagent', (d) => subDeltas.push(d));
  orch._onAgentEvent('planner', spawn('sub_1'), ATTR);                                  // spawn
  orch._onAgentEvent('planner', subTurn('sub_1', [
    { type: 'tool_use', id: 's', name: 'Skill', input: { skill: 'brainstorming' } },
    { type: 'tool_use', id: 'm', name: 'mcp__plugin_playwright_playwright__browser_click', input: {} },
  ]), ATTR);
  const rec = orch.state.subAgents.find((s) => s.id === 'sub_1');
  assert.deepEqual(rec.skills, ['skill:brainstorming', 'mcp:playwright']);
  const last = subDeltas.at(-1);
  assert.equal(last.transition, 'update');
  assert.deepEqual(last.skills, ['skill:brainstorming', 'mcp:playwright']);
});

test('repeated skills dedup and the set only grows (no duplicate, no re-emit when unchanged)', () => {
  const orch = orchWithStep();
  let emits = 0;
  orch.on('stepskills', () => { emits += 1; });
  const turn = mainTurn([{ type: 'tool_use', id: 'x', name: 'Skill', input: { skill: 'graphify' } }]);
  orch._onAgentEvent('planner', turn, ATTR);
  orch._onAgentEvent('planner', turn, ATTR); // same skill again
  assert.deepEqual(orch.state.steps[0].skills, ['skill:graphify']);
  assert.equal(emits, 1, 'no re-emit when the set did not change');
});
