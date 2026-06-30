import { app, BrowserWindow } from 'electron';
import { server } from '../server.mjs'; // importing boots the module; isMain guard won't fire under electron

const PORT = Number(process.env.PORT) || 4319;
server.listen?.(PORT, '127.0.0.1');

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1100, height: 800, title: 'Enable' });
  win.loadURL(`http://127.0.0.1:${PORT}/`);
});
app.on('window-all-closed', () => app.quit());
