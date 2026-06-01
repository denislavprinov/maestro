// test/artifacts-cost.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listPipelines } from '../src/core/artifacts.mjs';

async function pipelineWith(state) {
  const proj = await mkdtemp(join(tmpdir(), 'maestro-cost-'));
  const dir = join(proj, 'ai-artifacts', 'pipelines', state.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'), JSON.stringify(state), 'utf8');
  return proj;
}

test('listPipelines derives a missing total from per-step costs (not blank)', async () => {
  const proj = await pipelineWith({
    id: '01-06-26-demo-abcd1234', title: 'demo', status: 'done',
    startedAt: '2026-06-01T00:00:00Z',
    // NOTE: no totalCostUsd field (older / partially written state.json)
    steps: [
      { key: 'plan', phase: 'plan', costUsd: 0.10 },
      { key: 'implement', phase: 'implement', costUsd: 0.07 },
    ],
  });
  const list = await listPipelines(proj);
  const entry = list.find((p) => p.id === '01-06-26-demo-abcd1234');
  assert.equal(entry.totalCostUsd, 0.17, 'summed from steps when totalCostUsd absent');
});

test('listPipelines keeps an explicit persisted total verbatim', async () => {
  const proj = await pipelineWith({
    id: '01-06-26-explicit-abcd1234', status: 'done',
    totalCostUsd: 0.3232,
    steps: [{ key: 'clarify#1', phase: 'clarify', costUsd: 0.3232 }],
  });
  const list = await listPipelines(proj);
  assert.equal(list.find((p) => p.id === '01-06-26-explicit-abcd1234').totalCostUsd, 0.3232);
});

test('listPipelines returns null total only when there is genuinely no cost data', async () => {
  const proj = await pipelineWith({
    id: '01-06-26-empty-abcd1234', status: 'done',
    steps: [{ key: 'preflight', phase: 'preflight' }], // no costUsd anywhere
  });
  const list = await listPipelines(proj);
  assert.equal(list.find((p) => p.id === '01-06-26-empty-abcd1234').totalCostUsd, null);
});
