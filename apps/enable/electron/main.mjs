// Thin desktop wrapper: importing ../server.mjs boots the module (its isMain
// guard won't fire under electron), then we bind the port and open a window.
// Web mode = `npm start` + browser; desktop mode = `npm run electron`.
import { app, BrowserWindow } from 'electron';
import { server } from '../server.mjs';

const PORT = Number(process.env.PORT) || 4319;
server.listen?.(PORT, '127.0.0.1');

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1100, height: 800, title: 'Enable' });
  win.loadURL(`http://127.0.0.1:${PORT}/`);
});
app.on('window-all-closed', () => app.quit());
