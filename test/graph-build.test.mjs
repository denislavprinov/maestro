// test/graph-build.test.mjs
// Unit + integration tests for the in-worktree graphify build: the agent
// instruction, the spawn-with-timeout helper, the orchestrator's
// _buildWorktreeGraph guards, and the end-to-end leak-safety guarantees.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { worktreeGraphInstruction } from '../src/core/preflight.mjs';
import { createOrchestrator } from '../src/core/orchestrator.mjs';

const tmpDirs = [];
async function makeTmpDir(prefix = 'maestro-graph-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
// Write an executable fake `graphify` into binDir and return that PATH value.
async function fakeGraphify(binDir, body) {
  await writeFile(join(binDir, 'graphify'), body, 'utf8');
  await chmod(join(binDir, 'graphify'), 0o755);
  return binDir;
}
after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

test('worktreeGraphInstruction: cwd-relative, AST-only, lists the query commands', () => {
  const text = worktreeGraphInstruction();
  assert.match(text, /graphify-out/, 'points at graphify-out/');
  assert.match(text, /AST-only|structural/i, 'calls out AST-only nature');
  assert.match(text, /graphify query/, 'lists query');
  assert.match(text, /graphify explain/, 'lists explain');
  assert.match(text, /graphify path/, 'lists path');
  assert.doesNotMatch(text, /<projectDir>/, 'no dead placeholder');
  assert.doesNotMatch(text, /Skill\(/, 'CLI workflow, not the Skill tool');
});
