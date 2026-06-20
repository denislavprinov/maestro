// test/skill-mock.test.mjs — the fan-out mock emits a MAIN-stream Skill block and a
// child (parent_tool_use_id) envelope carrying a Skill + an mcp__* block, so smoke /
// UI runs surface pills. Mirrors test/subagent-mock.test.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaude } from '../src/core/claude-runner.mjs';

const dirs = [];
after(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });
async function tmp() { const d = await mkdtemp(join(tmpdir(), 'maestro-skill-mock-')); dirs.push(d); return d; }

function toolUseNames(content) {
  return Array.isArray(content) ? content.filter((c) => c?.type === 'tool_use').map((c) => c.name) : [];
}

test('the implementer mock emits a main-stream Skill block and a child Skill + mcp__* block', async () => {
  const dir = await tmp();
  const events = [];
  await runClaude({ cwd: dir, mock: true, onEvent: (e) => events.push(e),
    prompt: 'MOCK_ROLE: implementer' });

  // (1) A MAIN-stream Skill block (no parent_tool_use_id).
  const mainSkill = events.some((e) =>
    e?.raw?.parent_tool_use_id == null && toolUseNames(e?.raw?.message?.content).includes('Skill'));
  assert.ok(mainSkill, 'a main-agent Skill tool_use is emitted');

  // (2) A child envelope (parent_tool_use_id set) carrying a Skill + an mcp__* block.
  const childSkillMcp = events.some((e) => {
    if (e?.raw?.parent_tool_use_id == null) return false;
    const names = toolUseNames(e?.raw?.message?.content);
    return names.includes('Skill') && names.some((n) => typeof n === 'string' && n.startsWith('mcp__'));
  });
  assert.ok(childSkillMcp, 'a sub-agent Skill + mcp__* tool_use is emitted on a child stream');
});
