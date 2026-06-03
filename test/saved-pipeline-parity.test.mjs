// test/saved-pipeline-parity.test.mjs
// Task 11 — guard test: runs the 5 saved-pipeline topologies under MOCK and asserts
// they converge with the SAME implementer modes and plan-path parity as before the
// channel-bus refactor (Phases 0–4). No production code is changed here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator as makeOrch } from '../src/core/orchestrator.mjs';
import { writeWorkflow } from '../src/core/workflows.mjs';

const SHAPES = {
  'default':       { steps: [['planner'],['refiner'],['implementer'],['reviewer']],
                     feedbacks: [['s1_0','s1_0'],['s3_0','s2_0']] },
  'quick-fix':     { steps: [['planner'],['implementer'],['reviewer']], feedbacks: [['s2_0','s1_0']] },
  'implement-only':{ steps: [['implementer'],['reviewer']],             feedbacks: [['s1_0','s0_0']] },
  'plan-only':     { steps: [['planner'],['refiner']],                  feedbacks: [['s1_0','s1_0']] },
  'web-ui':        { steps: [['planner'],['refiner'],['implementer'],['reviewer'],['manualTestsChecklist'],['manualWebUiTesting']],
                     feedbacks: [['s1_0','s1_0'],['s3_0','s2_0'],['s5_0','s2_0']] },
};

async function runShapeUnderMock(shape) {
  const home = await mkdtemp(join(tmpdir(), 'maestro-parity-home-'));
  const prevHome = process.env.MAESTRO_HOME;
  process.env.MAESTRO_HOME = home;                         // sandbox the global store
  try {
    const steps = shape.steps.map((g, i) => g.map((key, j) => ({ id: `s${i}_${j}`, key })));
    const feedbacks = (shape.feedbacks || []).map(([from, to], k) => ({ id: `fb_${k}`, from, to }));
    const tpl = await writeWorkflow({ name: 'parity', steps, feedbacks });   // async; returns {id,...}
    const projectDir = await mkdtemp(join(tmpdir(), 'maestro-parity-proj-'));
    const orch = makeOrch({ projectDir, prompt: 'demo', auto: true, claude: { mock: true }, workflowId: tpl.id });
    const modes = [];
    // Instance-local copy so wrapping the producer does NOT mutate the shared
    // `defaultRunners` singleton (each shape would otherwise chain wrappers and
    // leak a patched producer to later tests in this file).
    orch._runners = { ...orch._runners };
    const realProducer = orch._runners.producer;
    orch._runners.producer = async (ctx) => {
      if (ctx?.node?.key === 'implementer') modes.push(ctx.mode);
      return realProducer(ctx);
    };
    // ▲ v3 (V3-B): artifacts come via the 'artifact' EVENT ({kind,path}); getState()
    // has no .artifacts. Subscribe BEFORE run().
    const artifacts = [];
    orch.on('artifact', (e) => artifacts.push(e));
    const res = await orch.run();
    assert.equal(res.status, 'done', 'pipeline converges');
    return { modes, artifacts };
  } finally {
    if (prevHome === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prevHome;
  }
}

test('every saved shape converges with the right implementer modes', async () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    const { modes } = await runShapeUnderMock(shape);
    if (name === 'plan-only') {
      assert.deepEqual(modes, [], `${name}: no implementer`);
    } else if (name === 'web-ui') {
      // web-ui has TWO verifier loops that both rewind to the implementer step:
      //   reviewer (s3_0->s2_0) + manualWebUiTesting (s5_0->s2_0).
      // Each fires once under mock (cycle1 blocking → cycle2 converged), so the
      // implementer runs: implement (initial) + fix (reviewer loop) + fix (webui loop) = 3 times.
      assert.deepEqual(modes, ['implement', 'fix', 'fix'], `${name} modes`);
    } else {
      assert.deepEqual(modes, ['implement', 'fix'], `${name} modes`);
    }
  }
});

test('▲ C1: planner writes the canonical v1 plan; refiner writes -v2 (no path drift)', async () => {
  const { artifacts } = await runShapeUnderMock(SHAPES['default']);
  const planPaths = artifacts.filter((a) => a.kind === 'plan').map((a) => a.path);
  assert.ok(planPaths.some((p) => /\/\d\d-\d\d-\d\d-[^/]+\.md$/.test(p) && !/-v\d+\.md$/.test(p)), 'canonical v1 plan file exists');
  assert.ok(planPaths.some((p) => /-v2\.md$/.test(p)), 'refiner v2 plan file exists');
});
