// test/orchestrator-pause.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { useTempHome } from './helpers/temp-home.mjs';
import { createOrchestrator } from '../src/core/orchestrator.mjs';
import { getDb } from '../src/core/db.mjs';

useTempHome(after);

function gitDir() {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-pause-'));
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: dir });
  return dir;
}

/** Runner that emits a session id, requests pause (deterministically, from inside
 *  the in-flight node), then hangs until the pause-abort lands as AbortError. */
function pausingProducer(getOrch) {
  return async (ctx) => {
    ctx.onEvent({ type: 'session', sessionId: 'sess-hang' });
    queueMicrotask(() => getOrch().pause());
    return new Promise((_res, rej) => {
      const onAbort = () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
    });
  };
}

const okVerifier = async () => ({ status: 'ok', issues: [], review: { issues: [] }, summary: '' });

test('pause mid-node -> paused status, resume_point persisted, worktree kept', async () => {
  const dir = gitDir();
  let orch;
  orch = createOrchestrator({
    projectDir: dir, prompt: 'demo', auto: true, claude: { mock: true },
    runners: { producer: pausingProducer(() => orch), verifier: okVerifier },
  });
  const res = await orch.run();
  assert.equal(res.status, 'paused');
  assert.equal(orch.state.status, 'paused');

  const row = getDb().prepare('SELECT status, resume_point, branch FROM pipelines WHERE id = ?').get(orch.state.id);
  assert.equal(row.status, 'paused');
  const rp = JSON.parse(row.resume_point);
  assert.equal(rp.version, 1);
  assert.equal(rp.kind, 'node');
  assert.equal(rp.workflowId, 'wf_default');
  assert.ok(Array.isArray(rp.plan?.steps) && rp.plan.steps.length > 0, 'frozen plan stored');
  assert.ok(rp.bus && typeof rp.bus === 'object', 'bus snapshot stored');
  assert.ok(rp.nodes.some((n) => n.sessionId === 'sess-hang'), 'interrupted node session recorded');

  // Worktree must SURVIVE a pause (uncommitted work lives there).
  const wt = JSON.parse(row.branch || '{}').worktreeDir;
  assert.ok(wt && existsSync(wt), 'worktree dir kept while paused');
});

test('pause is a no-op unless running; double pause safe', () => {
  const dir = gitDir();
  const orch = createOrchestrator({ projectDir: dir, prompt: 'x', auto: true, claude: { mock: true } });
  assert.equal(orch.pause(), false); // idle
  orch.state.status = 'running';
  assert.equal(orch.pause(), true);  // -> pausing
  assert.equal(orch.pause(), false); // already pausing
});

test('stop still wins: stopped run is not paused', async () => {
  const dir = gitDir();
  const hangingProducer = async (ctx) => new Promise((_res, rej) => {
    const onAbort = () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); };
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });
  });
  let orch;
  orch = createOrchestrator({
    projectDir: dir, prompt: 'demo', auto: true, claude: { mock: true },
    runners: {
      producer: async (ctx) => { queueMicrotask(() => orch.stop()); return hangingProducer(ctx); },
      verifier: okVerifier,
    },
  });
  const res = await orch.run();
  assert.equal(res.status, 'stopped');
});
