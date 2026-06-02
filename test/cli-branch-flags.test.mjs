// test/cli-branch-flags.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = resolve(fileURLToPath(import.meta.url), '..', '..', 'src', 'cli', 'maestro.mjs');

test('--help advertises --source-branch and --branch', () => {
  const r = spawnSync(process.execPath, [CLI, '--help']);
  const out = r.stdout.toString();
  assert.match(out, /--source-branch/);
  assert.match(out, /--branch /);
});

test('--source-branch without value exits 2', () => {
  const r = spawnSync(process.execPath, [CLI, '--prompt', 'x', '--source-branch']);
  assert.equal(r.status, 2);
  assert.match(r.stderr.toString(), /--source-branch requires a value/);
});
