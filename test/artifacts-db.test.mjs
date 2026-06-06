// test/artifacts-db.test.mjs
// Phase 3 — artifacts.mjs on node:sqlite (store_meta, ensureMeta, writeState,
// appendAudit). Each test runs against a throwaway MAESTRO_HOME with the DB
// singleton reset so getDb() reopens against it (mirrors 01-db-foundation.md).
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetForTests } from '../src/core/db.mjs';
import { readStoreMeta, writeStoreMeta, deleteStoreMeta } from '../src/core/artifacts.mjs';

const homes = [];
beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-art-'));
  homes.push(dir);
  _resetForTests();
  process.env.MAESTRO_HOME = dir;
});
after(async () => {
  _resetForTests();
  delete process.env.MAESTRO_HOME;
  await Promise.all(homes.map((d) => rm(d, { recursive: true, force: true })));
});

// ── Task 3.1 — store_meta read/write/delete ────────────────────────────────────

test('store_meta: write then read round-trips the JSON payload', () => {
  const data = { key: 'k1', path: '/p/k1', name: 'K One', firstSeenAt: '2026-01-01T00:00:00Z' };
  writeStoreMeta('k1', 'project', data);
  assert.deepEqual(readStoreMeta('k1'), data);
});

test('store_meta: read of an unknown key returns null', () => {
  assert.equal(readStoreMeta('nope'), null);
});

test('store_meta: write is an upsert (second write replaces)', () => {
  writeStoreMeta('k1', 'project', { name: 'old' });
  writeStoreMeta('k1', 'project', { name: 'new' });
  assert.deepEqual(readStoreMeta('k1'), { name: 'new' });
});

test('store_meta: delete removes the row', () => {
  writeStoreMeta('k1', 'workspace', { name: 'x' });
  deleteStoreMeta('k1');
  assert.equal(readStoreMeta('k1'), null);
});
