// History management (v2): a past Enable run can be deleted — store dir,
// plan/review files, branch + worktree — via the engine's deletePipeline.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after);

let server, base, runs, cookie;

before(async () => {
  ({ server, runs } = await import('../apps/enable/server.mjs'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${server.address().port}`;
  const res = await fetch(`http://${base}/`);
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
});

after(async () => { if (server) await new Promise((r) => server.close(r)); });

const authed = (path, opts = {}) =>
  fetch(`http://${base}${path}`, { ...opts, headers: { ...(opts.headers || {}), cookie } });

function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'enable-hist-'));
  execSync('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: dir });
  return dir;
}

test('DELETE /api/enable/history/:id removes the run everywhere', async () => {
  const ANSWERS = { testTier: 'scaffold', vendoringDepth: 'full',
    multiToolTargets: ['cursor'], canary: 'yes', scopeConstraints: '' };
  const { runId } = await (await authed('/api/enable/run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectDir: freshRepo(), answers: ANSWERS, mock: true }),
  })).json();
  await runs.get(runId).done;

  const hist = (await (await authed('/api/enable/history')).json()).runs;
  const mine = hist.find((h) => h.dir === runs.get(runId).orch.getState().pipelineDir);
  assert.ok(mine, 'finished run listed');
  assert.ok(existsSync(mine.dir), 'run dir exists on disk');

  const del = await authed(`/api/enable/history/${mine.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await del.json()).ok, true);

  assert.equal(existsSync(mine.dir), false, 'run dir removed from disk');
  const histAfter = (await (await authed('/api/enable/history')).json()).runs;
  assert.ok(!histAfter.some((h) => h.id === mine.id), 'gone from history');

  const again = await authed(`/api/enable/history/${mine.id}`, { method: 'DELETE' });
  assert.equal(again.status, 404, 'second delete -> 404');
});

test('DELETE with unknown id -> 404; requires auth', async () => {
  const missing = await authed('/api/enable/history/ffffffff', { method: 'DELETE' });
  assert.equal(missing.status, 404);
  const bare = await fetch(`http://${base}/api/enable/history/ffffffff`, { method: 'DELETE' });
  assert.equal(bare.status, 401);
});
