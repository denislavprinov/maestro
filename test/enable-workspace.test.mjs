import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { createWorkspace } from '../src/core/workspaces.mjs';

useTempHome(after);

let app, server, base, runs, cookie;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts = {}) =>
  realFetch(url, { ...opts, headers: { ...(opts.headers || {}), cookie } });

before(async () => {
  ({ app, server, runs } = await import('../apps/enable/server.mjs'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${server.address().port}`;
  const res = await realFetch(`http://${base}/`);
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
});
after(async () => { if (server) await new Promise((r) => server.close(r)); });

function freshRepo(name) {
  const dir = mkdtempSync(join(tmpdir(), `enable-ws-${name}-`));
  execSync('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: dir });
  return dir;
}

test('GET /api/enable/workspaces returns saved workspaces', async () => {
  const a = freshRepo('a'), b = freshRepo('b');
  await createWorkspace({ name: 'Combo', projectPaths: [a, b] });
  const res = await fetch(`http://${base}/api/enable/workspaces`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.workspaces));
  assert.ok(body.workspaces.some((w) => w.name === 'Combo'));
});

test('POST /api/enable/run: both projectDir and workspaceId -> 400', async () => {
  const a = freshRepo('c'), b = freshRepo('d');
  const ws = await createWorkspace({ name: 'Both', projectPaths: [a, b] });
  const res = await fetch(`http://${base}/api/enable/run`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectDir: a, workspaceId: ws.id, mock: true }) });
  assert.equal(res.status, 400);
});

test('POST /api/enable/run: neither projectDir nor workspaceId -> 400', async () => {
  const res = await fetch(`http://${base}/api/enable/run`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mock: true }) });
  assert.equal(res.status, 400);
});

test('POST /api/enable/run: unknown workspaceId -> 404', async () => {
  const res = await fetch(`http://${base}/api/enable/run`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: 'wks-nope-deadbeef', mock: true }) });
  assert.equal(res.status, 404);
});

test('POST /api/enable/run: valid workspaceId starts a mock workspace run', async () => {
  const a = freshRepo('e'), b = freshRepo('f');
  const wsEntry = await createWorkspace({ name: 'Runnable', projectPaths: [a, b] });
  const res = await fetch(`http://${base}/api/enable/run`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: wsEntry.id, mock: true }) });
  assert.equal(res.status, 200);
  const { runId } = await res.json();
  assert.ok(runId);
  const entry = runs.get(runId);
  assert.equal(entry.orch.isWorkspace, true);
  await entry.done;
});
