// test/onboarding-contracts-hook.test.mjs
// Runner-hook tests: after runGenericProducer/runGenericVerifier complete, the
// declared readiness/graph output channels get schema-validated on disk
// (repair + warn, or hard-fail on unusable content). See
// docs/superpowers/specs/2026-07-14-onboarding-contracts-design.md.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGenericProducer, runGenericVerifier } from '../src/core/phases.mjs';

const tmpDirs = [];
async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-contracts-'));
  tmpDirs.push(dir);
  return dir;
}
after(async () => { await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true }))); });

function ctxFor(dir, node, extra = {}) {
  return {
    projectDir: dir, pipelineDir: dir, taskPrompt: 'demo task', toolInstruction: '',
    agentPrompts: {}, checkpointRef: null, signal: undefined, onEvent: () => {},
    claudeOpts: { mock: true }, node, nodeId: node.nodeId, stepIndex: 1, cycle: 1, ...extra,
  };
}

function captureWarnings() {
  const lines = [];
  const orig = console.warn;
  console.warn = (msg) => lines.push(String(msg));
  return { lines, restore: () => { console.warn = orig; } };
}

test('producer(graph): mock-written repairable graph summary is normalized on disk with a [contracts] warning', async () => {
  const dir = await makeTmpDir();
  const graphPath = join(dir, 'graph-summary.json');
  const node = { nodeId: 'g0', key: 'analyzer', runnerType: 'producer', loopSource: false, agentPrompt: 'You are the analyzer.' };
  const cap = captureWarnings();
  try {
    const res = await runGenericProducer(ctxFor(dir, node, {
      outputs: { graph: { kind: 'graph', path: graphPath, graphDir: join(dir, 'graphify-out'), channel: 'graph' } },
    }));
    assert.ok(res.summary);
  } finally {
    cap.restore();
  }
  const written = JSON.parse(await readFile(graphPath, 'utf8'));
  assert.deepEqual(written.skillCandidates, []);
  assert.deepEqual(written.pureUnits, []);
  assert.equal(written.degraded, false);
  assert.deepEqual(written.stack, {});
  assert.ok(cap.lines.some((l) => l.startsWith('[contracts] graph:')), 'a [contracts] warning was logged');
});

test('verifier(readiness): pre-written repairable readiness.json is normalized on disk with a [contracts] warning', async () => {
  const dir = await makeTmpDir();
  const readinessJsonPath = join(dir, 'readiness.json');
  await writeFile(readinessJsonPath, JSON.stringify({ score: '93', baselineScore: 60, delta: 999, dimensions: {}, gaps: [] }), 'utf8');
  const node = { nodeId: 'r0', key: 'evaluator', runnerType: 'verifier', loopSource: false, agentPrompt: 'You are the evaluator.' };
  const cap = captureWarnings();
  try {
    await runGenericVerifier(ctxFor(dir, node, {
      outputs: {
        review: { kind: 'review', mdPath: join(dir, 'evaluator-review-cycle1.md'), jsonPath: join(dir, 'evaluator-review-cycle1.json') },
        readiness: { kind: 'artifact', path: join(dir, 'readiness.md'), jsonPath: readinessJsonPath, channel: 'readiness' },
      },
    }));
  } finally {
    cap.restore();
  }
  const written = JSON.parse(await readFile(readinessJsonPath, 'utf8'));
  assert.equal(written.score, 93);
  assert.equal(written.delta, 33);
  assert.ok(cap.lines.some((l) => l.startsWith('[contracts] readiness:')), 'a [contracts] warning was logged');
});

test('verifier(readiness): unparseable readiness.json fails the node', async () => {
  const dir = await makeTmpDir();
  const readinessJsonPath = join(dir, 'readiness.json');
  await writeFile(readinessJsonPath, '{ not valid json', 'utf8');
  const node = { nodeId: 'r1', key: 'evaluator', runnerType: 'verifier', loopSource: false, agentPrompt: 'You are the evaluator.' };
  await assert.rejects(
    () => runGenericVerifier(ctxFor(dir, node, {
      outputs: {
        review: { kind: 'review', mdPath: join(dir, 'evaluator-review-cycle1.md'), jsonPath: join(dir, 'evaluator-review-cycle1.json') },
        readiness: { kind: 'artifact', path: join(dir, 'readiness.md'), jsonPath: readinessJsonPath, channel: 'readiness' },
      },
    })),
    /\[contracts\] readiness:/,
  );
});

test('verifier(readiness): missing readiness.json succeeds with a warning, no throw', async () => {
  const dir = await makeTmpDir();
  const node = { nodeId: 'r2', key: 'evaluator', runnerType: 'verifier', loopSource: false, agentPrompt: 'You are the evaluator.' };
  const cap = captureWarnings();
  let res;
  try {
    res = await runGenericVerifier(ctxFor(dir, node, {
      outputs: {
        review: { kind: 'review', mdPath: join(dir, 'evaluator-review-cycle1.md'), jsonPath: join(dir, 'evaluator-review-cycle1.json') },
        readiness: { kind: 'artifact', path: join(dir, 'readiness.md'), jsonPath: join(dir, 'readiness.json'), channel: 'readiness' },
      },
    }));
  } finally {
    cap.restore();
  }
  assert.ok(res.review);
  assert.ok(cap.lines.some((l) => l.startsWith('[contracts] readiness:')), 'absence logged as a warning');
});

test('producer(tools): repairable tools.json is normalized on disk with a [contracts] warning', async () => {
  const dir = await makeTmpDir();
  const toolsPath = join(dir, 'tools.json');
  const node = { nodeId: 't0', key: 'infra', runnerType: 'producer', loopSource: false, agentPrompt: 'You are infra-gen.' };
  const cap = captureWarnings();
  try {
    await runGenericProducer(ctxFor(dir, node, {
      outputs: { tools: { kind: 'artifact', path: toolsPath, channel: 'tools' } },
    }));
  } finally { cap.restore(); }
  const written = JSON.parse(await readFile(toolsPath, 'utf8'));
  assert.deepEqual(written.installed, []);
  assert.deepEqual(written.skipped, []);
  assert.deepEqual(written.suggested, []);
  assert.ok(cap.lines.some((l) => l.startsWith('[contracts] tools:')));
});

test('tools channel: hook unions detectStacks matches from ctx.projectDir', async () => {
  // temp project with a Dockerfile; temp tools.json missing the docker suggestion
  const proj = await makeTmpDir();
  await writeFile(join(proj, 'Dockerfile'), 'FROM node:22', 'utf8');
  const toolsPath = join(proj, 'tools.json');
  await writeFile(toolsPath, JSON.stringify({ installed: [], skipped: [], suggested: [] }), 'utf8');
  const node = { nodeId: 't2', key: 'infra', runnerType: 'producer', loopSource: false, agentPrompt: 'You are infra-gen.' };
  const cap = captureWarnings();
  try {
    // decoy primary output ("out") so the mock write lands there, not on our
    // pre-written tools.json fixture (mirrors the unparseable-tasks test's trick)
    await runGenericProducer(ctxFor(proj, node, {
      outputs: {
        out: { kind: 'artifact', path: join(proj, 'out.md') },
        tools: { kind: 'artifact', path: toolsPath, channel: 'tools' },
      },
    }));
  } finally { cap.restore(); }

  const after = JSON.parse(await readFile(toolsPath, 'utf8'));
  const docker = after.suggested.find((s) => s.name === 'docker');
  assert.ok(docker, 'docker suggested from Dockerfile');
  assert.equal(docker.source, 'stack-match');
});

test('verifier(tasks): missing tasks-report.json warns but does not throw', async () => {
  const dir = await makeTmpDir();
  const node = { nodeId: 'x0', key: 'onboardingExecutor', runnerType: 'verifier', loopSource: true, agentPrompt: 'You are the executor.' };
  const cap = captureWarnings();
  try {
    const res = await runGenericVerifier(ctxFor(dir, node, {
      outputs: {
        review: { kind: 'review', mdPath: join(dir, 'x-review-cycle1.md'), jsonPath: join(dir, 'x-review-cycle1.json') },
        tasks: { kind: 'artifact', path: join(dir, 'tasks-report.json'), channel: 'tasks' },
      },
    }));
    assert.ok(res.review !== undefined);
  } finally { cap.restore(); }
  assert.ok(cap.lines.some((l) => l.includes('[contracts] tasks: output file missing')));
});

test('producer(tasks): unparseable tasks-report.json throws through the hook', async () => {
  const dir = await makeTmpDir();
  const tasksPath = join(dir, 'tasks-report.json');
  const node = { nodeId: 'x1', key: 'anything', runnerType: 'producer', loopSource: false, agentPrompt: 'x' };
  // primary output is a decoy md so the mock does not overwrite the fixture
  await writeFile(tasksPath, '{not json', 'utf8');
  await assert.rejects(
    runGenericProducer(ctxFor(dir, node, {
      outputs: {
        out: { kind: 'artifact', path: join(dir, 'out.md') },
        tasks: { kind: 'artifact', path: tasksPath, channel: 'tasks' },
      },
    })),
    /\[contracts\] tasks: unparseable JSON/,
  );
});
