// test/gate-e2e.test.mjs
// End-to-end proof that the shell validation gate closes the real loop: implement
// -> gate fail -> implementer re-enters FIX mode consuming the gate's own review
// -> gate pass -> reviewer. Bootstrap mirrors test/orchestrator-resume.test.mjs /
// test/pause-resume-e2e.test.mjs (temp git project, full default workflow, mock
// claude via `claude:{mock:true}` — no Claude process spawns).
//
// The gate's commands are REAL shell (runShellGate spawns `sh -c`), so failure is
// made state-dependent on disk: `validateCommands: ['test -f gate-ok']` fails until
// the file exists. An `opts.runners` producer override wraps the real producer for
// the implementer branch ONLY, creating `gate-ok` exactly when the orchestrator's
// real channel binding put it in FIX mode (ctx.mode === 'fix') — i.e. on the second,
// review-consuming pass. Every other node (clarify/planner/refiner/shellGate/
// reviewer) runs through the UNMODIFIED default runners, so the mock-claude review
// loop (reviewer blocks on cycle 1, per claude-runner.mjs mockReviewer) plays out
// for real too.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { useTempHome } from './helpers/temp-home.mjs';
import { createOrchestrator } from '../src/core/orchestrator.mjs';
import { runners as defaultRunners } from '../src/core/runners.mjs';

useTempHome(after);

function gitDir() {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-gate-e2e-'));
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: dir });
  return dir;
}

test('implement -> gate fail -> implementer FIX mode (consumes gate review) -> gate pass -> reviewer', async () => {
  const dir = gitDir();

  // Every implementer invocation the REAL orchestrator makes, with the REAL ctx
  // fields it computed (mode/reviewPath come from channels.mjs legacyFields —
  // nothing here fabricates them).
  const implCalls = [];

  const runners = {
    producer: async (ctx) => {
      if (ctx.node?.key === 'implementer') {
        implCalls.push({ cycle: ctx.cycle, mode: ctx.mode, reviewPath: ctx.reviewPath });
        // Disk-state-dependent gate: only satisfy `test -f gate-ok` once the
        // orchestrator has actually rewound the implementer into fix mode off the
        // gate's own review (never on the first, plain "implement" pass).
        if (ctx.mode === 'fix') {
          writeFileSync(join(ctx.projectDir, 'gate-ok'), '');
        }
      }
      return defaultRunners.producer(ctx);
    },
    verifier: defaultRunners.verifier,
  };

  const orch = createOrchestrator({
    projectDir: dir,
    prompt: 'demo gate task',
    auto: true,
    claude: { mock: true },
    runners,
    validateCommands: ['test -f gate-ok'],
  });

  const r = await orch.run();

  // 4) pipeline status 'done'.
  assert.equal(r.status, 'done');
  assert.equal(orch.state.status, 'done');

  const pipelineDir = orch.pipeline.dir;
  const gateSteps = orch.state.steps
    .filter((s) => s.phase === 'shellGate')
    .sort((a, b) => a.cycle - b.cycle);

  // 1) state.steps contains a shellGate step at cycle 1 (fail) and cycle 2 (pass).
  const gateCycle1 = gateSteps.find((s) => s.cycle === 1);
  const gateCycle2 = gateSteps.find((s) => s.cycle === 2);
  assert.ok(gateCycle1, 'shellGate ran at cycle 1');
  assert.ok(gateCycle2, 'shellGate ran at cycle 2');
  assert.equal(gateCycle1.status, 'done');
  assert.equal(gateCycle2.status, 'done');

  const cycle1Review = JSON.parse(readFileSync(join(pipelineDir, 'shellGate-review-cycle1.json'), 'utf8'));
  assert.ok(cycle1Review.issues.length > 0, 'gate cycle 1 recorded a failing (blocking) review');
  assert.match(cycle1Review.issues[0].detail, /gate-ok/, 'the failure names the missing-file command');

  const cycle2Review = JSON.parse(readFileSync(join(pipelineDir, 'shellGate-review-cycle2.json'), 'utf8'));
  assert.equal(cycle2Review.issues.length, 0, 'gate cycle 2 recorded a passing (empty) review');

  // 2) the implementer step at cycle 2 ran in fix mode, consuming
  // shellGate-review-cycle1.md — assert via the real ctx fields the orchestrator's
  // channel binding produced, AND independently via the review file on disk.
  const fixCall = implCalls.find((c) => c.cycle === 2);
  assert.ok(fixCall, 'implementer ran at cycle 2 (the gate-triggered rewind)');
  assert.equal(fixCall.mode, 'fix', 'implementer cycle 2 ran in FIX mode');
  assert.ok(
    fixCall.reviewPath && fixCall.reviewPath.endsWith('shellGate-review-cycle1.md'),
    `implementer cycle 2 consumed shellGate-review-cycle1.md (got ${fixCall.reviewPath})`,
  );
  assert.ok(existsSync(fixCall.reviewPath), 'the consumed shellGate-review-cycle1.md exists on disk');
  // (Not asserting gate-ok's on-disk presence here: the per-pipeline worktree is
  // torn down on a 'done' run, so its existence is instead proven indirectly by
  // gate cycle 2's empty review above — `test -f gate-ok` only passes once it exists.)

  // 3) the reviewer ran AFTER the gate passed: its (first) step record's startedAt
  // is >= the passing gate cycle's startedAt.
  const reviewerSteps = orch.state.steps
    .filter((s) => s.phase === 'reviewer')
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  assert.ok(reviewerSteps.length > 0, 'reviewer ran');
  assert.ok(
    reviewerSteps[0].startedAt >= gateCycle2.startedAt,
    `reviewer started (${reviewerSteps[0].startedAt}) at/after the passing gate cycle (${gateCycle2.startedAt})`,
  );
});
