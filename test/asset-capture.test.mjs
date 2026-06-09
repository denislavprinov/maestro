// test/asset-capture.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetUsesFromEvent } from '../src/core/orchestrator.mjs';

const evt = (content) => ({ type: 'assistant', message: { content } });

test('detects Skill, Agent(subagent_type), graphify-skill and graphify-bash; ignores plain Bash', () => {
  const raw = evt([
    { type: 'tool_use', id: 'k1', name: 'Skill', input: { skill: 'browse', args: 'open https://x' } },
    { type: 'tool_use', id: 'a1', name: 'Task', input: { subagent_type: 'Explore', description: 'map ui' } },
    { type: 'tool_use', id: 'g1', name: 'Skill', input: { skill: 'graphify', args: 'query foo' } },
    { type: 'tool_use', id: 'g2', name: 'Bash', input: { command: 'graphify query "where is X"' } },
    { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } },
  ]);
  const got = assetUsesFromEvent(raw);
  assert.deepEqual(got, [
    { id: 'k1', kind: 'skill',    name: 'browse',   detail: 'open https://x' },
    { id: 'a1', kind: 'agent',    name: 'Explore',  detail: 'map ui' },
    { id: 'g1', kind: 'graphify', name: 'graphify', detail: 'skill: query foo' },
    { id: 'g2', kind: 'graphify', name: 'graphify', detail: 'graphify query' },
  ]);
});

test('Agent without subagent_type falls back to general-purpose', () => {
  const got = assetUsesFromEvent(evt([{ type: 'tool_use', id: 'a2', name: 'Agent', input: { prompt: 'x' } }]));
  assert.equal(got[0].name, 'general-purpose');
});

test('non-array / non-tool_use content yields []', () => {
  assert.deepEqual(assetUsesFromEvent({ message: { content: 'hi' } }), []);
  assert.deepEqual(assetUsesFromEvent(evt([{ type: 'text', text: 'hi' }])), []);
  assert.deepEqual(assetUsesFromEvent(evt([{ type: 'tool_use', name: 'Skill', input: {} }])), []); // no id
});
