// test/artifacts-duration.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listPipelines } from '../src/core/artifacts.mjs';

test('listPipelines surfaces totalActiveMs from saved state', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'maestro-'));
  const dir = join(proj, 'ai-artifacts', 'pipelines', '01-06-26-x-abcd1234');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    id: 'abcd1234', title: 'x', status: 'done', startedAt: '2026-06-01T00:00:00.000Z',
    totalActiveMs: 4200,
    steps: [{ key: 'plan', phase: 'plan', activeMs: 4200, runningSince: null }],
  }));
  const list = await listPipelines(proj);
  assert.equal(list[0].totalActiveMs, 4200);
});

test('totalActiveMs falls back to summing steps when absent', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'maestro-'));
  const dir = join(proj, 'ai-artifacts', 'pipelines', '01-06-26-y-bcde2345');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    id: 'bcde2345', title: 'y', status: 'done',
    steps: [{ key: 'plan', activeMs: 1000 }, { key: 'refine#1', activeMs: 2000 }],
  }));
  const list = await listPipelines(proj);
  assert.equal(list[0].totalActiveMs, 3000);
});

test('totalActiveMs is null for a pre-timer state with no timing data', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'maestro-'));
  const dir = join(proj, 'ai-artifacts', 'pipelines', '01-06-26-z-cdef3456');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    id: 'cdef3456', title: 'z', status: 'done',
    steps: [{ key: 'plan', costUsd: 0.1 }], // older run: no activeMs anywhere
  }));
  const list = await listPipelines(proj);
  assert.equal(list[0].totalActiveMs, null);
});
