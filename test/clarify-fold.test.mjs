// test/clarify-fold.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator, plannerNodeIdOf } from '../src/core/orchestrator.mjs';

const tmpDirs = [];
async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-clarify-fold-'));
  tmpDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

test('clarify time + cost fold onto the Plan node; totals unchanged (mock run)', async () => {
  const orch = createOrchestrator({
    projectDir: await makeTmpDir(),
    workflowId: 'wf_default',
    prompt: 'demo task',
    auto: true,             // non-interactive: clarify auto-answers, gates auto-continue
    claude: { mock: true }, // NOTE: option is `claude`, not `claudeOpts`
  });

  const res = await orch.run();
  assert.equal(res.status, 'done', 'mock pipeline should finish');

  const st = orch.getState();
  const clarify = st.steps.find((s) => s.key === 'clarify#1');
  assert.ok(clarify, 'a clarify#1 step exists');
  assert.equal(clarify.nodeId, 's0_0', 'clarify is tagged with the planner node id');

  // Exactly one clarify row — no physical merge, no duplication.
  assert.equal(st.steps.filter((s) => s.key === 'clarify#1').length, 1);

  // The planner node's own step exists (key "0:s0_0") and shares the nodeId.
  const planStep = st.steps.find((s) => s.key === '0:s0_0');
  assert.ok(planStep, 'the planner node step exists');
  assert.equal(planStep.nodeId, 's0_0');

  // Totals are exactly Σ steps (clarify counted once: no double-count, no drop).
  // This is the real no-double-count proof and holds even if mock times are ~0.
  const sum = (f) => st.steps.reduce((a, s) => a + (Number(s[f]) || 0), 0);
  assert.equal(st.totalActiveMs, sum('activeMs'), 'totalActiveMs === Σ steps.activeMs');
  assert.equal(
    Number((st.totalCostUsd || 0).toFixed(6)),
    Number(sum('costUsd').toFixed(6)),
    'totalCostUsd === Σ steps.costUsd',
  );

  // The Plan-cell figure bucket (nodeId s0_0) is the SUM of clarify + plan rows.
  // Structural assertion (independent of magnitude): proves both rows fold together.
  const bucketMs = st.steps
    .filter((s) => s.nodeId === 's0_0')
    .reduce((a, s) => a + (Number(s.activeMs) || 0), 0);
  assert.equal(bucketMs, (Number(clarify.activeMs) || 0) + (Number(planStep.activeMs) || 0));
});

test('plannerNodeIdOf resolves the plan-phase node id from any plan (no hardcode)', () => {
  assert.equal(plannerNodeIdOf({ steps: [[{ nodeId: 's0_0', key: 'planner', uiPhase: 'plan' }]] }), 's0_0');
  // works for a workflow whose planner node id is NOT s0_0
  assert.equal(plannerNodeIdOf({ steps: [[{ nodeId: 'p_main', key: 'planner', uiPhase: 'plan' }]] }), 'p_main');
  // resolves by uiPhase even when key differs
  assert.equal(plannerNodeIdOf({ steps: [[{ nodeId: 'x9', key: 'whatever', uiPhase: 'plan' }]] }), 'x9');
  // no plan-phase node -> null (clarify stays unattributed)
  assert.equal(plannerNodeIdOf({ steps: [[{ nodeId: 'i0', key: 'implementer', uiPhase: 'implement' }]] }), null);
  assert.equal(plannerNodeIdOf(null), null);
});
