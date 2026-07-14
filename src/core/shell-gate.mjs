// Deterministic shell validation gate: the runner behind the synthetic
// `shellGate` verifier node. Runs the user's validation commands via `sh -c`
// in the worktree and converts the outcome into the canonical protocol review
// (empty on pass; one critical issue on fail), so the existing feedback-edge
// machinery (blocked verdict -> rewind -> implementer FIX mode) needs no changes.
// Never spawns Claude. Never throws on command failure — only on abort.

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

/** Per-command wall-clock cap. Env override for operators; node.timeoutMs for tests. */
export const DEFAULT_GATE_TIMEOUT_MS = 600_000;

const TAIL_LINES = 200;

function gateTimeoutMs(node) {
  const own = Number(node?.timeoutMs);
  if (Number.isFinite(own) && own > 0) return own;
  const env = Number(process.env.MAESTRO_GATE_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_GATE_TIMEOUT_MS;
}

/**
 * Run one command via `sh -c`, streaming merged output through onLine.
 * Resolves { code, tail, timedOut } — never rejects except on signal abort.
 */
function runCommand(cmd, { cwd, timeoutMs, signal, onLine }) {
  return new Promise((resolvePromise, rejectPromise) => {
    // detached => own process group, so the timeout kill reaps grandchildren too.
    const child = spawn(cmd, { shell: true, cwd, detached: true });
    const tail = [];
    let timedOut = false;

    const push = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line) continue;
        tail.push(line);
        if (tail.length > TAIL_LINES) tail.shift();
        onLine(line);
      }
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);

    const killTree = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
    const onAbort = () => { killTree(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      // spawn-level failure (e.g. no /bin/sh): degrade to a non-zero result.
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      push(String(err.message || err));
      resolvePromise({ code: 127, tail, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        rejectPromise(Object.assign(new Error('shell gate aborted'), { name: 'AbortError' }));
        return;
      }
      resolvePromise({ code: code ?? 1, tail, timedOut });
    });
  });
}

/**
 * Gate runner. Same return contract as runGenericVerifier (phases.mjs): writes
 * the review md + json to ctx.outputs.review paths and returns
 * { review, reviewMdPath } for runners.verifier's verdict wrap.
 * @param {object} ctx node ctx from orchestrator._nodeCtx (+ _bindNodeIo outputs)
 */
export async function runShellGate(ctx) {
  const commands = (ctx.node?.commands || []).map(String).map((s) => s.trim()).filter(Boolean);
  const cycle = Number(ctx.cycle) > 0 ? Number(ctx.cycle) : 1;
  const out = ctx.outputs?.review || {};
  const reviewMdPath = out.mdPath || `${String(ctx.pipelineDir || '.').replace(/\/+$/, '')}/shellGate-review-cycle${cycle}.md`;
  const reviewJsonPath = out.jsonPath || `${String(ctx.pipelineDir || '.').replace(/\/+$/, '')}/shellGate-review-cycle${cycle}.json`;
  const timeoutMs = gateTimeoutMs(ctx.node);
  // _onAgentEvent (orchestrator.mjs:2061) surfaces `e.text` as a pipeline 'log'
  // line; no other fields are needed for plain output.
  const onLine = (line) => { try { ctx.onEvent?.({ text: line }); } catch { /* log-only */ } };

  let review;
  for (const cmd of commands) {
    onLine(`$ ${cmd}`);
    const { code, tail, timedOut } = await runCommand(cmd, {
      cwd: ctx.projectDir, timeoutMs, signal: ctx.signal, onLine,
    });
    if (code !== 0) {
      const why = timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `exit code ${code}`;
      review = {
        issues: [{
          severity: 'critical',
          title: `Validation failed: ${cmd}`,
          detail: `Command \`${cmd}\` failed (${why}).\n\nLast output:\n${tail.join('\n')}`,
          location: '',
        }],
        summary: `Validation failed: \`${cmd}\` (${why}).`,
      };
      break;
    }
  }
  review ||= { issues: [], summary: `Validation passed: ${commands.map((c) => `\`${c}\``).join(', ')}.` };

  const md = [
    `# Validation gate (cycle ${cycle})`,
    '',
    review.summary,
    '',
    ...review.issues.map((i) => `## ${i.title}\n\n${i.detail}`),
    '',
  ].join('\n');
  await writeFile(reviewMdPath, md, 'utf8');
  await writeFile(reviewJsonPath, JSON.stringify(review, null, 2), 'utf8');
  return { review, reviewMdPath };
}
