// test/git-info-diff.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { diffNameStatus, diffNumstat, diffPatch } from '../src/core/git-info.mjs';

let repo;
const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });

before(async () => {
  repo = await mkdtemp(join(tmpdir(), 'maestro-diff-'));
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
  await writeFile(join(repo, 'keep.txt'), 'one\n');
  await writeFile(join(repo, 'gone.txt'), 'bye\n');
  git(['add', '-A']); git(['commit', '-qm', 'base']);
  // mutate working tree
  await writeFile(join(repo, 'keep.txt'), 'one\ntwo\n');   // modify
  await writeFile(join(repo, 'new.txt'), 'fresh\n');        // add
  await rm(join(repo, 'gone.txt'));                          // delete
  git(['add', '-A', '-N']);                                 // intent-to-add new file
});

after(async () => { await rm(repo, { recursive: true, force: true }); });

test('diffNameStatus buckets A/M/D against working tree', async () => {
  const rows = await diffNameStatus(repo, 'HEAD');
  const byPath = Object.fromEntries(rows.map((r) => [r.path, r.status]));
  assert.equal(byPath['new.txt'], 'A');
  assert.equal(byPath['keep.txt'], 'M');
  assert.equal(byPath['gone.txt'], 'D');
});

test('diffNumstat returns per-file counts', async () => {
  const m = await diffNumstat(repo, 'HEAD');
  assert.equal(m.get('keep.txt').added, 1);
  assert.equal(m.get('keep.txt').removed, 0);
  assert.equal(m.get('new.txt').binary, false);
});

test('diffPatch returns a unified diff string', async () => {
  const p = await diffPatch(repo, 'HEAD');
  assert.match(p, /\+two/);
  assert.match(p, /new\.txt/);
});

test('helpers are safe on bad refs', async () => {
  assert.deepEqual(await diffNameStatus(repo, 'nope'), []);
  assert.deepEqual([...(await diffNumstat(repo, 'nope')).keys()], []);
  assert.equal(await diffPatch(repo, 'nope'), '');
});
