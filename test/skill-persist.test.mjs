// test/skill-persist.test.mjs
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertSubAgent, listSubAgents } from '../src/core/artifacts.mjs';
import { _resetForTests } from '../src/core/db.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';

const homes = [];
beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-skill-persist-'));
  homes.push(dir);
  _resetForTests();
  process.env.MAESTRO_HOME = dir;
});
after(async () => {
  _resetForTests();
  delete process.env.MAESTRO_HOME;
  await Promise.all(homes.map((d) => rm(d, { recursive: true, force: true })));
});

test('sub_agents.skills round-trips as a JSON array; NULL -> []', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'maestro-skill-proj-'));
  const { id: pid } = await seedPipeline(proj, { title: 'Run', status: 'running' });

  upsertSubAgent(pid, { id: 'a1', label: 'AR sheet', nodeId: 'n1', stepIndex: 0, cycle: 1,
    status: 'finished', startedAt: '2026-06-20T00:00:00Z', skills: ['skill:graphify', 'mcp:playwright'] });
  upsertSubAgent(pid, { id: 'a2', label: 'AR items', nodeId: 'n1', stepIndex: 0, cycle: 1,
    status: 'finished', startedAt: '2026-06-20T00:00:01Z' }); // no skills

  const subs = listSubAgents(pid);
  assert.deepEqual(subs.find((s) => s.id === 'a1').skills, ['skill:graphify', 'mcp:playwright']);
  assert.deepEqual(subs.find((s) => s.id === 'a2').skills, [], 'absent skills surface as []');
});

test('a skills update never nulls the COALESCE-guarded skills (grows monotonically)', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'maestro-skill-proj-'));
  const { id: pid } = await seedPipeline(proj, { title: 'Run', status: 'running' });
  upsertSubAgent(pid, { id: 'a1', status: 'running', startedAt: '2026-06-20T00:00:00Z', skills: ['skill:graphify'] });
  // A later status-only upsert (no skills) must NOT wipe the stored array (COALESCE guard).
  upsertSubAgent(pid, { id: 'a1', status: 'finished', finishedAt: '2026-06-20T00:00:09Z' });
  assert.deepEqual(listSubAgents(pid)[0].skills, ['skill:graphify'], 'skills preserved across a skill-less finish update');
});
