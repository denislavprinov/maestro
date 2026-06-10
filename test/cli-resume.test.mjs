// test/cli-resume.test.mjs
// Guard-level tests for `maestro resume <id>` (no orchestrator spawn): usage,
// unknown id, non-paused id — plus the cwd-fallback projectDir resolution (which
// reaches orch.resume() but stops deterministically at the missing-worktree
// check). The happy path is covered by test/orchestrator-resume.test.mjs.
// Harness mirrors test/cli-subcommands.test.mjs: spawn the CLI as a child
// process; seed the shared sqlite file from THIS process (same MAESTRO_HOME via
// useTempHome), then let the child read it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useTempHome } from './helpers/temp-home.mjs';
import { seedPipeline, seedPipelineRow } from './helpers/db-seed.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, '..', 'src', 'cli', 'maestro.mjs');

// useTempHome sets process.env.MAESTRO_HOME (inherited by run()'s env spread)
// and resets the db singleton so seedPipelineRow writes into THIS home.
const home = useTempHome(after);

function run(args, { cwd } = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, MAESTRO_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
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

// The CLI's default run flow needs no registration, so the `maestro resume <id>`
// hint it prints must resolve the project from the CHILD's cwd when the registry
// has no match. The no-resume-point guard fires BEFORE resolution, so the seed
// must carry a resumePoint; the deliberately missing worktreeDir then makes
// orch.resume() fail at its worktree re-attach check — a deterministic error that
// can only be reached AFTER projectDir resolution succeeded.
test('resume an unregistered cwd project -> resolves past "not onboarded"', async () => {
  // realpath: macOS mkdtemp returns a /var -> /private/var symlinked path while
  // the child's process.cwd() is physical; keep the test focused on the cwd
  // fallback itself rather than projectKey's symlink canonicalization.
  const projDir = await realpath(await mkdtemp(join(tmpdir(), 'maestro-cliresume-proj-')));
  const goneWt = await mkdtemp(join(tmpdir(), 'maestro-cliresume-wt-'));
  await rm(goneWt, { recursive: true, force: true }); // worktree no longer exists
  try {
    const { id } = await seedPipeline(projDir, {
      title: 'paused cwd run', status: 'paused',
      branch: { source: 'main', feature: 'f', worktreeDir: goneWt, reusedExisting: false },
      resumePoint: { version: 1, kind: 'boundary', stepIndex: 0, stepCycle: [], loopState: {},
        bus: null, stepModels: null, workflowId: 'wf_default', plan: null, nodes: [], gate: null,
        pipelineDir: projDir, pausedAt: '2026-06-09T00:00:00Z' },
    });
    const r = await run(['resume', id, '--mock', '--yes'], { cwd: projDir });
    assert.equal(r.code, 1, r.stderr);
    assert.doesNotMatch(r.stderr, /not onboarded/i, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /worktree missing/i, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  } finally {
    await rm(projDir, { recursive: true, force: true });
  }
});
