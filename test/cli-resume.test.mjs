// test/cli-resume.test.mjs
// Guard-level tests for `maestro resume <id>` (no orchestrator spawn): usage,
// unknown id, non-paused id. The happy path is covered by
// test/orchestrator-resume.test.mjs. Harness mirrors test/cli-subcommands.test.mjs:
// spawn the CLI as a child process; seed the shared sqlite file from THIS process
// (same MAESTRO_HOME via useTempHome), then let the child read it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useTempHome } from './helpers/temp-home.mjs';
import { seedPipelineRow } from './helpers/db-seed.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, '..', 'src', 'cli', 'maestro.mjs');

// useTempHome sets process.env.MAESTRO_HOME (inherited by run()'s env spread)
// and resets the db singleton so seedPipelineRow writes into THIS home.
const home = useTempHome(after);

function run(args) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, MAESTRO_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('exit', (code) => res({ code: code ?? 0, stdout, stderr }));
  });
}

test('resume with no id -> exit 1 + usage', async () => {
  const r = await run(['resume']);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /usage: maestro resume/i);
});

test('resume unknown id -> exit 1 + not found', async () => {
  const r = await run(['resume', 'deadbeef']);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /not found/i);
});

test('resume a non-paused pipeline -> exit 1 + not paused', async () => {
  seedPipelineRow({
    id: 'aaaa0001',
    status: 'done',
    startedAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
  });
  const r = await run(['resume', 'aaaa0001']);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /not paused/i);
});
