import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readToolsReport, readTasksReport } from '../src/core/onboarding.mjs';

const dirs = [];
const tmp = async () => { const d = await mkdtemp(join(tmpdir(), 'enable-readers-')); dirs.push(d); return d; };
after(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

test('readToolsReport: absent file -> null (old runs render unchanged)', async () => {
  assert.equal(readToolsReport(await tmp()), null);
});

test('readToolsReport: base file read; later cycle file wins', async () => {
  const dir = await tmp();
  await writeFile(join(dir, 'tools.json'), JSON.stringify({ installed: [{ name: 'graphify' }] }));
  assert.equal(readToolsReport(dir).installed[0].name, 'graphify');
  await writeFile(join(dir, 'tools-cycle2.json'), JSON.stringify({ installed: [{ name: 'caveman' }] }));
  assert.equal(readToolsReport(dir).installed[0].name, 'caveman');
});

test('readTasksReport: absent -> null; latest cycle wins', async () => {
  const dir = await tmp();
  assert.equal(readTasksReport(dir), null);
  await writeFile(join(dir, 'tasks-report.json'), JSON.stringify({ attempted: [], completed: 0 }));
  await writeFile(join(dir, 'tasks-report-cycle2.json'), JSON.stringify({ attempted: [{ gap: 'x', status: 'completed' }], completed: 1 }));
  assert.equal(readTasksReport(dir).completed, 1);
});
