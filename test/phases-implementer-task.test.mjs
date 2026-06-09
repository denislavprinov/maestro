import { test } from 'node:test';
import assert from 'node:assert/strict';
import { implementerBody } from '../src/core/phases.mjs';

test('implementer body: TASK path is authoritative when present', () => {
  const body = implementerBody({ mode: 'implement', planPath: '/plans/x.md', taskPath: '/run/tasks/p1-t1.md' });
  assert.match(body, /\/run\/tasks\/p1-t1\.md/);
  assert.match(body, /authoritative|self-contained/i);
  assert.match(body, /\/plans\/x\.md/); // plan still referenced
});

test('implementer body: no TASK path -> plan is authoritative (today behavior)', () => {
  const body = implementerBody({ mode: 'implement', planPath: '/plans/x.md' });
  assert.doesNotMatch(body, /TASK \(authoritative/);
  assert.match(body, /\/plans\/x\.md/);
});

test('implementer body: fix mode references the review', () => {
  const body = implementerBody({ mode: 'fix', planPath: '/plans/x.md', reviewPath: '/rev/r.md' });
  assert.match(body, /\/rev\/r\.md/);
});
