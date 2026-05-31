// test/agent-log.test.mjs
// _onAgentEvent should surface concrete tool calls instead of the bare
// stream-json envelope types (the old noisy `[planner] user` / `system` lines).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrator } from '../src/core/orchestrator.mjs';

function capture(role, evt, projectDir = '/tmp/proj') {
  const orch = createOrchestrator({ projectDir });
  const logs = [];
  orch.on('log', (l) => logs.push(l));
  orch._onAgentEvent(role, evt);
  return logs;
}

test('assistant tool_use is logged as a readable tool call, not bare "assistant"', () => {
  const logs = capture('planner', {
    type: 'assistant',
    raw: {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/proj/src/app.js' } }] },
    },
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].source, 'planner');
  assert.equal(logs[0].text, '→ Read src/app.js');
});

test('bare user (tool_result) envelope events are dropped', () => {
  const logs = capture('planner', {
    type: 'user',
    raw: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } },
  });
  assert.equal(logs.length, 0, 'tool_result echoes carry no information and must not be logged');
});

test('system init envelope events are dropped', () => {
  const logs = capture('planner', { type: 'system', raw: { type: 'system', subtype: 'init' } });
  assert.equal(logs.length, 0);
});

test('assistant text still logs at info unchanged', () => {
  const logs = capture('planner', { type: 'assistant', text: 'Considering the design.', raw: {} });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'info');
  assert.equal(logs[0].text, 'Considering the design.');
});

test('Bash tool_use shows the command', () => {
  const logs = capture('implementer', {
    type: 'assistant',
    raw: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].text, '→ Bash npm test');
});

test('Grep tool_use shows pattern and relative path', () => {
  const logs = capture('planner', {
    type: 'assistant',
    raw: {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'role', path: '/tmp/proj/src' } }] },
    },
  });
  assert.equal(logs[0].text, '→ Grep "role" src');
});

test('multiple tool_use blocks in one event each get their own line', () => {
  const logs = capture('planner', {
    type: 'assistant',
    raw: {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/proj/a.js' } },
          { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/proj/b.js' } },
        ],
      },
    },
  });
  assert.deepEqual(logs.map((l) => l.text), ['→ Read a.js', '→ Write b.js']);
});

test('unknown tool with no recognizable target logs just its name', () => {
  const logs = capture('planner', {
    type: 'assistant',
    raw: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [] } }] } },
  });
  assert.equal(logs[0].text, '→ TodoWrite');
});

test('mock tool_use events (text + raw.file) still log their message at info', () => {
  // The offline mock emits { type:'tool_use', text:'wrote <path>', raw:{file} }.
  const logs = capture('implementer', {
    type: 'tool_use',
    text: 'wrote /tmp/proj/out.json',
    raw: { mock: true, file: '/tmp/proj/out.json' },
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'info');
  assert.equal(logs[0].text, 'wrote /tmp/proj/out.json');
});
