// test/artifacts-cost.test.mjs
// Phase 3.6 — listPipelines reads totals from the pipelines row; when the row total
// is 0 it falls back to a per-step SUM/COUNT (the DB-native equivalent of the old
// step-sum). Fixtures seed DB rows (seedPipelineRow) instead of state.json. The
// three legacy cases map exactly: row-total 0 + step costs → SUM; non-null total →
// verbatim; no steps (no figures anywhere) → null (blank chip).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listPipelines } from '../src/core/artifacts.mjs';
import { projectKey } from '../src/core/store.mjs';
import { _resetForTests } from '../src/core/db.mjs';
import { seedPipelineRow } from './helpers/db-seed.mjs';

async function freshProj(prefix) {
  const home = await mkdtemp(join(tmpdir(), 'maestro-cost-home-'));
  process.env.MAESTRO_HOME = home;
  _resetForTests(); // reopen the DB singleton against this temp home
  return mkdtemp(join(tmpdir(), prefix));
}

test('listPipelines derives a missing total from per-step costs (not blank)', async () => {
  const proj = await freshProj('maestro-cost-');
  // total omitted (defaults to 0) -> the entry must SUM the steps.
  seedPipelineRow({
    id: 'abcd1234', projectKey: projectKey(proj), title: 'demo', status: 'done',
    startedAt: '2026-06-01T00:00:00Z',
    steps: [
      { key: 'plan', phase: 'plan', costUsd: 0.10 },
      { key: 'implement', phase: 'implement', costUsd: 0.07 },
    ],
  });
  const list = await listPipelines(proj);
  const entry = list.find((p) => p.id === 'abcd1234');
  assert.equal(entry.totalCostUsd, 0.17, 'summed from steps when the row total is 0');
});

test('listPipelines keeps an explicit persisted total verbatim', async () => {
  const proj = await freshProj('maestro-cost-');
  seedPipelineRow({
    id: 'bcde2345', projectKey: projectKey(proj), status: 'done',
    startedAt: '2026-06-01T00:00:00Z', totalCostUsd: 0.3232,
    steps: [{ key: 'clarify#1', phase: 'clarify', costUsd: 0.3232 }],
  });
  const list = await listPipelines(proj);
  assert.equal(list.find((p) => p.id === 'bcde2345').totalCostUsd, 0.3232);
});

test('listPipelines returns null total only when there is genuinely no cost data', async () => {
  const proj = await freshProj('maestro-cost-');
  // No steps at all (and total 0) -> COUNT(cost_usd)=0 -> null display.
  seedPipelineRow({
    id: 'cdef3456', projectKey: projectKey(proj), status: 'done',
    startedAt: '2026-06-01T00:00:00Z', steps: [],
  });
  const list = await listPipelines(proj);
  assert.equal(list.find((p) => p.id === 'cdef3456').totalCostUsd, null);
});
