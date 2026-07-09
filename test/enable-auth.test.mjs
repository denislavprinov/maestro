// Auth (v2): the Enable server issues a per-boot session cookie with the UI and
// requires it on every /api/* call and on the WS handshake. Cross-origin pages
// can neither read the cookie nor send it (SameSite=Strict), so a drive-by
// browser page cannot start runs or answer gates on the localhost server.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after);

let server, base, cookie;

before(async () => {
  ({ server } = await import('../apps/enable/server.mjs'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${server.address().port}`;
});

after(async () => { if (server) await new Promise((r) => server.close(r)); });

test('serving the UI sets a strict, http-only auth cookie', async () => {
  const res = await fetch(`http://${base}/`);
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie') || '';
  assert.match(setCookie, /enable_auth=[0-9a-f]{32,}/);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /HttpOnly/i);
  cookie = setCookie.split(';')[0];
});

test('API without the cookie -> 401; with it -> 200', async () => {
  const bare = await fetch(`http://${base}/api/enable/projects`);
  assert.equal(bare.status, 401);
  const authed = await fetch(`http://${base}/api/enable/projects`, { headers: { cookie } });
  assert.equal(authed.status, 200);
});

test('mutating routes are covered too', async () => {
  const res = await fetch(`http://${base}/api/enable/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 401);
});

test('WS handshake requires the cookie', async () => {
  const rejected = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://${base}/ws`);
    ws.on('open', () => { ws.close(); resolve(false); });
    ws.on('error', () => resolve(true));
  });
  assert.equal(rejected, true, 'cookieless WS must be rejected');

  const opened = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/ws`, { headers: { cookie } });
    const t = setTimeout(() => reject(new Error('no hello')), 5000);
    ws.on('message', (d) => {
      const ev = JSON.parse(d);
      if (ev.type === 'hello') { clearTimeout(t); ws.close(); resolve(true); }
    });
    ws.on('error', reject);
  });
  assert.equal(opened, true);
});
