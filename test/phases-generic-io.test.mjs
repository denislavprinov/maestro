// test/phases-generic-io.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { genericIoBlock } from '../src/core/phases.mjs';

test('genericIoBlock names a secondary jsonPath for a non-review output', () => {
  const out = genericIoBlock({}, { readiness: { kind: 'artifact', path: '/pipe/readiness.md', jsonPath: '/pipe/readiness.json' } });
  assert.match(out, /Write readiness to: \/pipe\/readiness\.md/);
  assert.match(out, /readiness JSON .*\/pipe\/readiness\.json/);
});

test('genericIoBlock names the committed graphDir for a graph output', () => {
  const out = genericIoBlock({}, { graph: { kind: 'graph', path: '/pipe/graph-summary.json', graphDir: '/p/graphify-out' } });
  assert.match(out, /Write graph to: \/pipe\/graph-summary\.json/);
  assert.match(out, /graphify-out.*\/p\/graphify-out/);
});

test('genericIoBlock renders a plain non-review output unchanged (no secondary lines)', () => {
  const out = genericIoBlock({}, { plan: { kind: 'artifact', path: '/pipe/plan.md' } });
  assert.match(out, /Write plan to: \/pipe\/plan\.md/);
  assert.doesNotMatch(out, /JSON \(machine-readable\)/);
  assert.doesNotMatch(out, /graphify-out/);
});
