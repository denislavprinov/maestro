// test/graphify-gitignore.test.mjs
// ensureGraphifyGitignore: the copy-back step (orchestrator._buildWorktreeGraph)
// writes graphify-out/ into the main project dir, outside git's normal write
// path. Any project lacking its own ignore rule would then see it as untracked
// (and `git add -A`-able) content — this helper makes that impossible.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureGraphifyGitignore } from '../src/core/preflight.mjs';

const tmpDirs = [];
async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-gi-'));
  tmpDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

test('no .gitignore: creates one with a graphify-out/ entry', async () => {
  const dir = await makeTmpDir();
  await ensureGraphifyGitignore(dir);
  const text = await readFile(join(dir, '.gitignore'), 'utf8');
  assert.match(text, /^graphify-out\/$/m);
});

test('.gitignore exists without the entry: appends it, keeps existing content', async () => {
  const dir = await makeTmpDir();
  await writeFile(join(dir, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');
  await ensureGraphifyGitignore(dir);
  const text = await readFile(join(dir, '.gitignore'), 'utf8');
  assert.match(text, /node_modules\//);
  assert.match(text, /dist\//);
  assert.match(text, /^graphify-out\/$/m);
});

test('.gitignore already covers it (various forms): no duplicate line added', async () => {
  for (const line of ['graphify-out/', '/graphify-out', '/graphify-out/', 'graphify-out']) {
    const dir = await makeTmpDir();
    await writeFile(join(dir, '.gitignore'), `${line}\n`, 'utf8');
    await ensureGraphifyGitignore(dir);
    const text = await readFile(join(dir, '.gitignore'), 'utf8');
    assert.equal((text.match(/graphify-out/g) || []).length, 1, `no duplicate for "${line}"`);
  }
});

test('.gitignore with no trailing newline: appended entry still lands on its own line', async () => {
  const dir = await makeTmpDir();
  await writeFile(join(dir, '.gitignore'), 'node_modules/', 'utf8'); // no trailing \n
  await ensureGraphifyGitignore(dir);
  const text = await readFile(join(dir, '.gitignore'), 'utf8');
  assert.match(text, /^graphify-out\/$/m);
  assert.doesNotMatch(text, /node_modules\/graphify-out/);
});

test('fail-safe: never throws (e.g. unwritable project dir)', async () => {
  const dir = await makeTmpDir();
  await chmod(dir, 0o500); // read+execute only, no write
  try {
    await assert.doesNotReject(() => ensureGraphifyGitignore(dir));
  } finally {
    await chmod(dir, 0o700); // restore so cleanup can rm it
  }
});
