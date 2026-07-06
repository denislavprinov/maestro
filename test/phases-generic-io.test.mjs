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

test('genericIoBlock inlines clarify answers under the clarify input line', () => {
  const clarify = {
    kind: 'clarify', path: '/pipe/clarify.json',
    questions: [{ id: 'testTier', question: 'How much testing?' }],
    answers: [
      { id: 'testTier', question: 'How much testing?', choice: 'scaffold' },
      { id: 'multiToolTargets', question: 'Which other AI tools?', choice: 'CLAUDE.md, .cursor/rules' },
    ],
  };
  const out = genericIoBlock({ clarify }, {});
  assert.match(out, /- clarify: \/pipe\/clarify\.json/);
  assert.match(out, /How much testing\?.*scaffold/);
  assert.match(out, /Which other AI tools\?.*CLAUDE\.md, \.cursor\/rules/);
});

test('genericIoBlock renders a bare clarify path when there are no answers', () => {
  const out = genericIoBlock({ clarify: { kind: 'clarify', path: '/pipe/clarify.json', questions: [], answers: [] } }, {});
  assert.match(out, /- clarify: \/pipe\/clarify\.json/);
  assert.doesNotMatch(out, /\*\*Q:\*\*/);
});

test('genericIoBlock renders a plain non-review output unchanged (no secondary lines)', () => {
  const out = genericIoBlock({}, { plan: { kind: 'artifact', path: '/pipe/plan.md' } });
  assert.match(out, /Write plan to: \/pipe\/plan\.md/);
  assert.doesNotMatch(out, /JSON \(machine-readable\)/);
  assert.doesNotMatch(out, /graphify-out/);
});
