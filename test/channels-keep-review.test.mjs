// test/channels-keep-review.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { publish } from '../src/core/channels.mjs';

test('code publish clears review by default (forward first-pass implement)', () => {
  const bus = { review: { kind: 'review', mdPath: '/r.md' } };
  publish(['code'], { summary: 'x' }, {}, bus);              // no opts → today's behavior
  assert.equal(bus.review, null);
});

test('code publish keeps review when the producer was in fix mode', () => {
  const bus = { review: { kind: 'review', mdPath: '/r.md' } };
  publish(['code'], { summary: 'x' }, {}, bus, { keepReview: true });
  assert.deepEqual(bus.review, { kind: 'review', mdPath: '/r.md' }); // survives for the next generator
});
