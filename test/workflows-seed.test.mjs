// test/workflows-seed.test.mjs  (sets MAESTRO_HOME to a tmp dir, like db.test.mjs)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.MAESTRO_HOME = mkdtempSync(join(tmpdir(), 'maestro-seed-'));

import test from 'node:test';
import assert from 'node:assert/strict';
import { readWorkflow, listWorkflows } from '../src/core/workflows.mjs';
import { ONBOARDING_WORKFLOW } from '../src/core/builtin-workflows.mjs';

test('wf_onboarding is seeded and resolvable from the DB', async () => {
  const wf = await readWorkflow('wf_onboarding');           // triggers getDb()→migrate→seed
  assert.equal(wf.id, 'wf_onboarding');
  assert.deepEqual(wf.steps, ONBOARDING_WORKFLOW.steps);
  assert.equal(wf.feedbacks[0].to, 's_infra');
});

test('the seeded workflow appears in the picker list', async () => {
  const ids = (await listWorkflows()).map((w) => w.id);
  assert.ok(ids.includes('wf_onboarding'));
});
