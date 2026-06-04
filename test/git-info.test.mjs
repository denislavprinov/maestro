// test/git-info.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  parseShortstat, normalizeMergeable, diffShortstat, branchExists,
} from '../src/core/git-info.mjs';

test('parseShortstat handles all four shortstat shapes', () => {
  assert.deepEqual(parseShortstat(' 2 files changed, 44 insertions(+), 25 deletions(-)'), { added: 44, removed: 25 });
  assert.deepEqual(parseShortstat(' 1 file changed, 5 insertions(+)'), { added: 5, removed: 0 });
  assert.deepEqual(parseShortstat(' 1 file changed, 3 deletions(-)'), { added: 0, removed: 3 });
  assert.deepEqual(parseShortstat(''), { added: 0, removed: 0 });
});

test('normalizeMergeable maps gh + mergeStateStatus values to 3 states', () => {
  assert.equal(normalizeMergeable('MERGEABLE'), 'MERGEABLE');
  assert.equal(normalizeMergeable('CLEAN'), 'MERGEABLE');
  assert.equal(normalizeMergeable('CONFLICTING'), 'CONFLICTING');
  assert.equal(normalizeMergeable('DIRTY'), 'CONFLICTING');
  assert.equal(normalizeMergeable(''), 'UNKNOWN');
  assert.equal(normalizeMergeable('anything-else'), 'UNKNOWN');
});

test('branchExists + diffShortstat against a real throwaway repo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gi-'));
  const g = (a) => spawnSync('git', a, { cwd: dir });
  g(['init', '-q', '-b', 'main']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  await writeFile(join(dir, 'a.txt'), 'one\n'); g(['add', '-A']); g(['commit', '-qm', 'init']);
  g(['checkout', '-q', '-b', 'feature/x']);
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\n'); g(['add', '-A']); g(['commit', '-qm', 'add line']);

  assert.equal(await branchExists(dir, 'feature/x'), true);
  assert.equal(await branchExists(dir, 'no-such-branch'), false);
  assert.equal(await branchExists('/path/does/not/exist', 'feature/x'), false);

  const d = await diffShortstat(dir, 'main', 'feature/x');
  assert.equal(d.added, 1);
  assert.equal(d.removed, 0);
  await rm(dir, { recursive: true, force: true });
});
