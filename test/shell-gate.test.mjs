import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShellGate } from '../src/core/shell-gate.mjs';

const tmpDirs = [];
async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-gate-'));
  tmpDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

function ctxFor(dir, commands, extra = {}) {
  return {
    projectDir: dir,
    pipelineDir: dir,
    cycle: 1,
    signal: undefined,
    onEvent: () => {},
    node: { nodeId: 's_gate', key: 'shellGate', commands },
    outputs: {
      review: {
        kind: 'review',
        mdPath: join(dir, 'shellGate-review-cycle1.md'),
        jsonPath: join(dir, 'shellGate-review-cycle1.json'),
        reviewKind: 'shellGate-review',
      },
    },
    ...extra,
  };
}

test('runShellGate: passing command yields empty-issue review', async () => {
  const dir = await makeTmpDir();
  const { review, reviewMdPath } = await runShellGate(ctxFor(dir, ['exit 0']));
  assert.equal(review.issues.length, 0);
  assert.match(review.summary, /validation passed/i);
  const json = JSON.parse(await readFile(join(dir, 'shellGate-review-cycle1.json'), 'utf8'));
  assert.deepEqual(json.issues, []);
  assert.match(await readFile(reviewMdPath, 'utf8'), /validation passed/i);
});

test('runShellGate: failing command yields one critical issue with exit code + tail', async () => {
  const dir = await makeTmpDir();
  const { review } = await runShellGate(ctxFor(dir, ['echo boom-output; exit 3']));
  assert.equal(review.issues.length, 1);
  assert.equal(review.issues[0].severity, 'critical');
  assert.match(review.issues[0].title, /Validation failed/);
  assert.match(review.issues[0].detail, /exit code 3/);
  assert.match(review.issues[0].detail, /boom-output/);
});

test('runShellGate: commands run sequentially, first failure stops the sequence', async () => {
  const dir = await makeTmpDir();
  const marker = join(dir, 'ran-second');
  const { review } = await runShellGate(
    ctxFor(dir, ['exit 1', `touch ${marker}`]),
  );
  assert.equal(review.issues.length, 1);
  await assert.rejects(readFile(marker)); // second command never ran
});

test('runShellGate: missing binary fails with critical issue, does not throw', async () => {
  const dir = await makeTmpDir();
  const { review } = await runShellGate(ctxFor(dir, ['definitely-not-a-real-binary-xyz']));
  assert.equal(review.issues.length, 1);
  assert.equal(review.issues[0].severity, 'critical');
});

test('runShellGate: timeout kills the command and fails', async () => {
  const dir = await makeTmpDir();
  const ctx = ctxFor(dir, ['sleep 30']);
  ctx.node.timeoutMs = 300; // per-node override used by tests only
  const { review } = await runShellGate(ctx);
  assert.equal(review.issues.length, 1);
  assert.match(review.issues[0].detail, /timed out after/);
});

test('runShellGate: streams output lines through onEvent', async () => {
  const dir = await makeTmpDir();
  const lines = [];
  const ctx = ctxFor(dir, ['echo hello-gate'], { onEvent: (e) => lines.push(e) });
  await runShellGate(ctx);
  assert.ok(lines.some((e) => String(e.text || '').includes('hello-gate')));
});
