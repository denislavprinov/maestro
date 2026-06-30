import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import net from 'node:net';

// The maestro engine imports node:sqlite, which is only present in modern Node
// (22.5+/24+). Electron bundles its own, older Node in the main process, so we
// CANNOT import the server here — we spawn it as a child on the system `node`.
// Override the binary with ENABLE_NODE_BIN if `node` is not on PATH.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server.mjs');
const NODE_BIN = process.env.ENABLE_NODE_BIN || 'node';
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
  child = spawn(NODE_BIN, ['--disable-warning=ExperimentalWarning', SERVER], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HOST },
    stdio: 'inherit',
  });
  child.on('error', (err) => {
    console.error(`[enable] failed to spawn server via "${NODE_BIN}": ${err.message}`);
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
        <p>The bundled launcher runs the engine with the system <code>node</code>
        (needs Node 22.5+ for <code>node:sqlite</code>). Set <code>ENABLE_NODE_BIN</code>
        to a modern node binary if it is not on PATH.</p></body>`));
  }
});

app.on('window-all-closed', () => { try { child?.kill(); } catch {} app.quit(); });
app.on('quit', () => { try { child?.kill(); } catch {} });
