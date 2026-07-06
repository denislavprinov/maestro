// Unit tests for the Electron launcher's pure spawn-spec logic. The module must
// not import 'electron' so it stays testable under plain node --test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { serverSpawnSpec } from '../apps/enable/electron/launch.mjs';

const MODULE_DIR = '/repo/apps/enable/electron';
const EXEC = '/apps/Enable.app/Contents/MacOS/Enable';

test('dev: spawns own binary as node on the repo server.mjs', () => {
  const spec = serverSpawnSpec({
    isPackaged: false, moduleDir: MODULE_DIR, resourcesPath: '/x',
    execPath: EXEC, env: {}, port: 4319, host: '127.0.0.1',
  });
  assert.equal(spec.bin, EXEC);
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, '1');
  assert.ok(spec.args.includes(join('/repo/apps/enable', 'server.mjs')));
  assert.equal(spec.cwd, '/repo/apps/enable');
  assert.equal(spec.env.PORT, '4319');
  assert.equal(spec.env.HOST, '127.0.0.1');
});

test('packaged: server + cwd resolve under resourcesPath/maestro', () => {
  const spec = serverSpawnSpec({
    isPackaged: true, moduleDir: '/apps/Enable.app/Contents/Resources/app.asar/electron',
    resourcesPath: '/apps/Enable.app/Contents/Resources',
    execPath: EXEC, env: {}, port: 4319, host: '127.0.0.1',
  });
  const appRoot = '/apps/Enable.app/Contents/Resources/maestro/apps/enable';
  assert.ok(spec.args.includes(join(appRoot, 'server.mjs')));
  assert.equal(spec.cwd, appRoot);
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, '1');
});

test('ENABLE_NODE_BIN overrides: external node, no ELECTRON_RUN_AS_NODE', () => {
  const spec = serverSpawnSpec({
    isPackaged: false, moduleDir: MODULE_DIR, resourcesPath: '/x',
    execPath: EXEC, env: { ENABLE_NODE_BIN: '/opt/node/bin/node' }, port: 1, host: 'h',
  });
  assert.equal(spec.bin, '/opt/node/bin/node');
  assert.ok(!('ELECTRON_RUN_AS_NODE' in spec.env));
});

test('projects root: env wins; packaged defaults to home; dev leaves unset', () => {
  const base = { moduleDir: MODULE_DIR, resourcesPath: '/x', execPath: EXEC, port: 1, host: 'h' };
  const withEnv = serverSpawnSpec({ ...base, isPackaged: true, home: '/Users/u',
    env: { MAESTRO_ENABLE_PROJECTS_ROOT: '/custom' } });
  assert.equal(withEnv.env.MAESTRO_ENABLE_PROJECTS_ROOT, '/custom');
  const packaged = serverSpawnSpec({ ...base, isPackaged: true, home: '/Users/u', env: {} });
  assert.equal(packaged.env.MAESTRO_ENABLE_PROJECTS_ROOT, '/Users/u');
  const dev = serverSpawnSpec({ ...base, isPackaged: false, home: '/Users/u', env: {} });
  assert.ok(!('MAESTRO_ENABLE_PROJECTS_ROOT' in dev.env));
});
