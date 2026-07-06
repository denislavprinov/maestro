import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import net from 'node:net';
import { serverSpawnSpec } from './launch.mjs';

// The server (and the maestro engine underneath) runs as a child process on
// this app's own binary with ELECTRON_RUN_AS_NODE — Electron 43 bundles Node 24,
// which has node:sqlite. ENABLE_NODE_BIN overrides the binary for debugging.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4319;
const HOST = '127.0.0.1';

let child = null;

function waitForServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect(port, HOST);
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`server not up on :${port}`));
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

function startServer() {
  const spec = serverSpawnSpec({
    isPackaged: app.isPackaged,
    moduleDir: __dirname,
    resourcesPath: process.resourcesPath,
    execPath: process.execPath,
    env: process.env,
    port: PORT,
    host: HOST,
    home: homedir(),
  });
  child = spawn(spec.bin, spec.args, { cwd: spec.cwd, env: spec.env, stdio: 'inherit' });
  child.on('error', (err) => {
    console.error(`[enable] failed to spawn server via "${spec.bin}": ${err.message}`);
  });
}

app.whenReady().then(async () => {
  startServer();
  const win = new BrowserWindow({ width: 1100, height: 800, title: 'Enable' });
  try {
    await waitForServer(PORT);
    win.loadURL(`http://${HOST}:${PORT}/`);
  } catch (err) {
    win.loadURL('data:text/html,' + encodeURIComponent(
      `<body style="font:16px -apple-system;background:#0c0d0f;color:#ededef;padding:40px">
        <h2>Enable could not start its server</h2>
        <p>${err.message}</p>
        <p>Set <code>ENABLE_NODE_BIN</code> to a Node 22.13+ binary to run the
        server on an external node instead of the app's own runtime.</p></body>`));
  }
});

app.on('window-all-closed', () => { try { child?.kill(); } catch {} app.quit(); });
app.on('quit', () => { try { child?.kill(); } catch {} });
