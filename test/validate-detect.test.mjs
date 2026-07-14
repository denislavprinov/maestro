import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectValidationCommands } from '../src/core/validate-detect.mjs';

const tmpDirs = [];
async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-detect-'));
  tmpDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

test('npm: real test script -> npm test', async () => {
  const dir = await makeTmpDir();
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  assert.deepEqual(await detectValidationCommands(dir), ['npm test']);
});

test('npm: default placeholder script is NOT suggested', async () => {
  const dir = await makeTmpDir();
  await writeFile(join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.deepEqual(await detectValidationCommands(dir), []);
});

test('make: Makefile with test target -> make test', async () => {
  const dir = await makeTmpDir();
  await writeFile(join(dir, 'Makefile'), 'build:\n\techo hi\n\ntest:\n\techo t\n');
  assert.deepEqual(await detectValidationCommands(dir), ['make test']);
});

test('pytest: pytest.ini -> pytest', async () => {
  const dir = await makeTmpDir();
  await writeFile(join(dir, 'pytest.ini'), '[pytest]\n');
  assert.deepEqual(await detectValidationCommands(dir), ['pytest']);
});

test('cargo: Cargo.toml -> cargo test', async () => {
  const dir = await makeTmpDir();
  await writeFile(join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
  assert.deepEqual(await detectValidationCommands(dir), ['cargo test']);
});

test('multiple ecosystems: ordered npm-first', async () => {
  const dir = await makeTmpDir();
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  await writeFile(join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
  assert.deepEqual(await detectValidationCommands(dir), ['npm test', 'cargo test']);
});

test('empty / missing dir -> []', async () => {
  const dir = await makeTmpDir();
  assert.deepEqual(await detectValidationCommands(dir), []);
  assert.deepEqual(await detectValidationCommands(join(dir, 'nope')), []);
});
