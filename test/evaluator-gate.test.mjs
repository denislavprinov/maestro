import test from 'node:test';
import assert from 'node:assert/strict';
import { hasBlocking } from '../src/core/protocol.mjs';

const lowScore = { summary: 'AI-readiness 64/100', issues: [
  { severity: 'critical', title: 'AI-readiness score 64 < 80', detail: 'docs+vendoring gaps', location: 'readiness.json' },
]};
const passing = { summary: 'AI-readiness 88/100', issues: [
  { severity: 'suggestion', title: 'consider a release skill', detail: '', location: 'CLAUDE.md' },
]};

test('a sub-80 score / hard failure blocks (fires the loop)', () => assert.equal(hasBlocking(lowScore), true));
test('a passing readiness card does not block', () => assert.equal(hasBlocking(passing), false));
