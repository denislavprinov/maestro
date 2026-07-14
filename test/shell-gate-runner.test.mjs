import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runners } from '../src/core/runners.mjs';
import { loadAgentRegistry } from '../src/core/agent-registry.mjs';

const tmpDirs = [];
async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-gate-runner-'));
  tmpDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

function gateCtx(dir, commands) {
  return {
    projectDir: dir,
    pipelineDir: dir,
    cycle: 1,
    signal: undefined,
    onEvent: () => {},
    node: { nodeId: 's_gate', key: 'shellGate', runnerType: 'verifier', commands },
    outputs: {
      review: {
        kind: 'review',
        mdPath: join(dir, 'shellGate-review-cycle1.md'),
        jsonPath: join(dir, 'shellGate-review-cycle1.json'),
        reviewKind: 'shellGate-review',
      },
    },
  };
}

test('registry: shellGate meta loads as a verifier', () => {
  const reg = loadAgentRegistry();
  const meta = reg.shellGate;
  assert.ok(meta, 'shellGate present in registry');
  assert.equal(meta.runnerType, 'verifier');
  assert.equal(meta.loopSource, true);
  assert.deepEqual(meta.produces, ['review']);
  assert.deepEqual(meta.consumes, ['code']);
});

test('runners.verifier: shellGate pass -> status ok', async () => {
  const dir = await makeTmpDir();
  const res = await runners.verifier(gateCtx(dir, ['exit 0']));
  assert.equal(res.status, 'ok');
  assert.equal(res.review.issues.length, 0);
});

test('runners.verifier: shellGate fail -> blocked verdict with reviewMdPath', async () => {
  const dir = await makeTmpDir();
  const res = await runners.verifier(gateCtx(dir, ['exit 1']));
  assert.equal(res.status, 'blocked');
  assert.equal(res.issues.length, 1);
  assert.equal(res.issues[0].severity, 'critical');
  assert.equal(res.reviewMdPath, join(dir, 'shellGate-review-cycle1.md'));
  await readFile(res.reviewMdPath, 'utf8'); // md written
});
