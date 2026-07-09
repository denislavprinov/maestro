// Pure spawn-spec logic for the Electron launcher. No 'electron' import so
// node --test can exercise it directly (test/enable-electron-launch.test.mjs).
import { join, dirname } from 'node:path';

// Electron >=35 bundles Node 22+, which has node:sqlite — so the app's own
// binary, run with ELECTRON_RUN_AS_NODE, hosts the server. No system node
// needed. ENABLE_NODE_BIN still overrides for debugging against another node.
export function serverSpawnSpec({
  isPackaged, moduleDir, resourcesPath, execPath, env = {}, port, host, home,
}) {
  const appRoot = isPackaged
    ? join(resourcesPath, 'maestro', 'apps', 'enable')
    : dirname(moduleDir);
  const childEnv = { ...env, PORT: String(port), HOST: String(host) };
  if (!childEnv.MAESTRO_ENABLE_PROJECTS_ROOT && isPackaged && home) {
    childEnv.MAESTRO_ENABLE_PROJECTS_ROOT = home; // Finder-launched cwd is useless
  }
  let bin = env.ENABLE_NODE_BIN;
  if (!bin) { bin = execPath; childEnv.ELECTRON_RUN_AS_NODE = '1'; }
  return {
    bin,
    args: ['--disable-warning=ExperimentalWarning', join(appRoot, 'server.mjs')],
    cwd: appRoot,
    env: childEnv,
  };
}
