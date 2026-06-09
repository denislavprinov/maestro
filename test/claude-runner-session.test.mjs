// test/claude-runner-session.test.mjs
// buildClaudeArgs is a new pure export; the mock runner emits a deterministic
// session event and logs a resume marker. NOTE: mock markers are `KEY: value`
// lines (parseMarkers at claude-runner.mjs:341) — NOT `KEY=value`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClaudeArgs, runClaude } from '../src/core/claude-runner.mjs';

// Unknown MOCK_ROLE -> runMock's default branch: no filesystem side effects.
const MOCK_PROMPT = 'do the thing\nMOCK_ROLE: sessiontest\nMOCK_CYCLE: 2';

test('buildClaudeArgs without resume has no --resume flag', () => {
  const args = buildClaudeArgs({ prompt: 'p', permissionMode: 'acceptEdits' });
  assert.ok(!args.includes('--resume'));
  assert.deepEqual(args.slice(0, 2), ['-p', 'p']);
});

test('buildClaudeArgs with resumeSessionId inserts --resume <sid>', () => {
  const args = buildClaudeArgs({ prompt: 'p', permissionMode: 'acceptEdits', resumeSessionId: 'sess-1' });
  const i = args.indexOf('--resume');
  assert.ok(i > -1, 'flag present');
  assert.equal(args[i + 1], 'sess-1');
});

test('mock emits a session event with a deterministic id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-runner-'));
  const events = [];
  await runClaude({ cwd: dir, prompt: MOCK_PROMPT, mock: true, onEvent: (e) => events.push(e) });
  const s = events.find((e) => e.type === 'session');
  assert.ok(s, 'session event emitted');
  assert.equal(s.sessionId, 'mock-session-sessiontest-c2');
});

test('mock resumeSessionId logs a resumed marker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-runner-'));
  const events = [];
  await runClaude({
    cwd: dir, prompt: MOCK_PROMPT, mock: true,
    resumeSessionId: 'mock-session-sessiontest-c2',
    onEvent: (e) => events.push(e),
  });
  assert.ok(events.some((e) => typeof e.text === 'string' && e.text.includes('[mock] resumed session mock-session-sessiontest-c2')));
});
