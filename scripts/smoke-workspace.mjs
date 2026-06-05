#!/usr/bin/env node
// scripts/smoke-workspace.mjs
// Offline mock SMOKE for a WORKSPACE pipeline run (M4). Proves the review-fanout loop
// end to end with $0 spend:
//   scanner (mock) writes a description -> a 2-project workspace run injects it into
//   every system prompt -> the reviewer node resolves to `workspaceReviewer` -> its
//   mock blocking count decays with cycle so the review -> implementer loop TERMINATES.
//
// SCOPE SEAM (§6.8): M4 exercises the mock PIPELINE RUN (fully achievable now). The
// real SCAN ENGINE (workspace-scan.mjs, the `scan-*` WS family) lands in M5; here we
// mock the scanner role directly to populate the workspace description, then run the
// pipeline. The M5 smoke will replace the mocked scan with the real engine.
//
// ISOLATION (mirrors `npm run smoke`): runs under MAESTRO_HOME=.maestro-smoke and uses
// THROWAWAY git repos created in an OS temp dir (never examples/sandbox, never this
// repo) — the orchestrator makes real worktrees + branches INSIDE each member repo, so
// pointing at a real repo would pollute it. Temp repos + the smoke home are removed in
// a finally block, so a clean run leaves no worktree/branch/dir behind.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { createOrchestrator } from '../src/core/orchestrator.mjs';
import { projectKey } from '../src/core/store.mjs';
import { runClaude } from '../src/core/claude-runner.mjs';

function die(msg) {
  console.error(`smoke:workspace FAILED — ${msg}`);
  process.exitCode = 1;
}

/** A fresh throwaway git repo with one commit, on branch `main`. */
async function freshRepo(label) {
  const dir = await mkdtemp(join(tmpdir(), `maestro-smoke-ws-${label}-`));
  const g = (args) => spawnSync('git', args, { cwd: dir });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 'smoke@maestro']);
  g(['config', 'user.name', 'smoke']);
  await writeFile(join(dir, 'README.md'), `# ${label}\n\nThrowaway smoke member project.\n`);
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);
  return dir;
}

async function main() {
  // Force mock so nothing spawns claude / spends tokens, even if the env didn't set it.
  process.env.MAESTRO_MOCK = process.env.MAESTRO_MOCK || '1';

  const repos = [];
  try {
    const a = await freshRepo('a');
    const b = await freshRepo('b');
    repos.push(a, b);

    // Member set sorted by projectKey ascending (the canonical ordering everywhere).
    const members = [a, b]
      .map((dir) => ({ projectDir: dir, projectKey: projectKey(dir), projectName: dir.split('/').pop() }))
      .sort((x, y) => (x.projectKey < y.projectKey ? -1 : x.projectKey > y.projectKey ? 1 : 0));

    // 1) SCAN (mocked role — the real engine is M5). Produce the interconnection
    // description the run will inject into every agent.
    let description = '';
    {
      const scanOut = join(repos[0], 'ws-description.md');
      const prompt = [
        '## Member projects to investigate',
        ...members.map((m) => `- **${m.projectName}** (\`${m.projectKey}\`): investigate ${m.projectDir}`),
        'MOCK_ROLE: workspace-scan',
        `MOCK_OUT: ${scanOut}`,
        'MOCK_BASE: Smoke Workspace',
      ].join('\n');
      const investigating = [];
      await runClaude({
        cwd: repos[0], prompt, mock: true,
        onEvent: (e) => { if (/^INVESTIGATING /.test(e.text || '')) investigating.push(e.text); },
      });
      description = await (await import('node:fs/promises')).readFile(scanOut, 'utf8');
      if (!/# Workspace: Smoke Workspace/.test(description)) return die('scan did not write a template description');
      if (investigating.length !== members.length) return die(`expected ${members.length} INVESTIGATING lines, got ${investigating.length}`);
      console.log(`  scan: wrote ${description.length}-char description, ${investigating.length} investigations`);
    }

    // 2) RUN the mock workspace pipeline with the frozen description injected.
    const workspace = {
      id: 'wks-smoke-00000000', key: 'wks-smoke-00000000',
      name: 'Smoke Workspace', description,
      projects: members.map((m) => ({ ...m, branch: { source: 'main' } })),
    };
    const orch = createOrchestrator({
      workspace, prompt: 'add a small feature', auto: true, claude: { mock: true }, branch: { source: 'main' },
    });

    // Capture the resolved plan to prove the review node became `workspaceReviewer`.
    const origDispatch = orch._dispatch.bind(orch);
    let seenPlan = null;
    orch._dispatch = async (plan, runArgs) => { seenPlan = plan; return origDispatch(plan, runArgs); };

    const res = await orch.run();
    if (res.status !== 'done') return die(`workspace run did not complete: status=${res.status} (${JSON.stringify(res).slice(0, 300)})`);

    const keys = (seenPlan?.steps || []).flat().map((n) => n.key);
    if (!keys.includes('workspaceReviewer')) return die(`review node was not substituted to workspaceReviewer (keys: ${keys.join(',')})`);
    if (keys.includes('reviewer')) return die('single-project reviewer node leaked into a workspace run');

    // The review->implementer loop must have TERMINATED (the mock decays blocking with cycle).
    const state = orch.getState();
    if (state.status !== 'done') return die(`final state not done: ${state.status}`);
    if (state.target !== 'workspace') return die(`state.target should be 'workspace', got ${state.target}`);

    console.log(`  run:  status=${res.status}, review node=workspaceReviewer, loop terminated (cycles capped)`);
    console.log('smoke:workspace OK — scanner wrote a description, the workspace run injected it, the workspaceReviewer loop terminated.');
  } finally {
    await Promise.all(repos.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
    // The smoke home (.maestro-smoke) is left for inspection like `npm run smoke`; the
    // workspace store lives under it. Throwaway member repos (with their worktrees +
    // maestro/* branches) are reaped above, so nothing leaks into a real repo.
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
