// test/migrate-fs-to-db.test.mjs
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getDb, _resetForTests } from '../src/core/db.mjs';
import { maybeMigrateFromFs } from '../src/core/migrate-fs-to-db.mjs';
import { maestroHome } from '../src/core/projects.mjs';
import { projectKey } from '../src/core/store.mjs';

// Each test gets its own MAESTRO_HOME so the singleton DB + legacy tree are fully
// isolated. _resetForTests() drops the cached handle so the next getDb() reopens
// against the new home (mirrors db.test.mjs / the temp-home discipline).
const homes = [];
function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-fsmig-'));
  homes.push(dir);
  _resetForTests();
  process.env.MAESTRO_HOME = dir;
  return dir;
}

beforeEach(() => { freshHome(); });

after(() => {
  _resetForTests();
  delete process.env.MAESTRO_HOME;
  for (const d of homes) rmSync(d, { recursive: true, force: true });
});

// ── fixture builder ────────────────────────────────────────────────────────────
// Writes a realistic legacy JSON+markdown tree under the CURRENT MAESTRO_HOME.
// Returns the key info the assertions need (project keys, the home path). The
// shapes are copied verbatim from the live store (see Phase 4 §2).
//
// A12 (DATA-DESTRUCTION GUARD): the two registered projects are THROWAWAY
// git-initialized temp dirs (tempGitRepo), NEVER process.cwd(). This is required
// because the per-project config import writes <projA>/.maestro/config.json and a
// later task archives→removes it; pointing projA at the real repo would delete the
// developer's actual <repo>/.maestro/config.json. The temp dirs are git-initialized
// so projectKey() resolves a stable git-based key and the dirs exist (config import
// skips gone dirs); both are pushed to `homes` for cleanup.
function tempGitRepo(label) {
  const dir = mkdtempSync(join(tmpdir(), `maestro-fsmig-${label}-`));
  homes.push(dir); // reuse the same cleanup list
  try { execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' }); } catch { /* projectKey degrades to realpath */ }
  return dir;
}

function writeJson(p, obj) {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
function writeText(p, text) {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text, 'utf8');
}

function buildFixture(home) {
  // A12: two THROWAWAY git temp dirs as the registered projects, so their dirs
  // EXIST (per-project config import skips gone dirs), projectKey() resolves a
  // stable git-based key, and NOTHING under the real repo (process.cwd()) is ever
  // written or removed.
  const projA = tempGitRepo('a');
  const projB = tempGitRepo('b');
  const keyA = projectKey(projA);
  const keyB = projectKey(projB);

  // 1) registry
  writeJson(join(home, 'projects.json'), [
    { name: 'Maestro', path: projA },
    { name: 'sandbox', path: projB },
  ]);

  // 2) a saved workflow template
  writeJson(join(home, 'workflows', 'wf_quick-fix.json'), {
    id: 'wf_quick-fix', name: 'Quick Fix', version: 1,
    steps: [[{ id: 's0_0', key: 'planner' }], [{ id: 's1_0', key: 'implementer' }],
            [{ id: 's2_0', key: 'reviewer' }]],
    feedbacks: [{ id: 'fb_0', from: 's2_0', to: 's1_0' }],
    createdAt: '2026-06-02T20:20:00.708Z', updatedAt: '2026-06-02T20:20:00.708Z',
  });

  // 3) per-project config for projA (steps + customModels + activeWorkflowId +
  //    workflows{nodes,feedbacks} + an UNKNOWN top-level key to test `extra`).
  writeJson(join(projA, '.maestro', 'config.json'), {
    steps: {
      planner: { model: 'claude-opus-4-8', effort: 'max' },
      refiner: { model: 'claude-opus-4-8', effort: 'max', fanOut: true },
    },
    customModels: [{ id: 'my-model', label: 'My Model' }],
    activeWorkflowId: 'wf_quick-fix',
    workflows: {
      'wf_quick-fix': {
        nodes: {
          s0_0: { model: 'claude-opus-4-8[1m]', effort: 'xhigh' },
          s1_0: { model: 'claude-opus-4-8', effort: 'high', fanOut: false },
        },
        feedbacks: { fb_0: { maxCycles: 2 } },
      },
    },
    webUiTesting: { enabled: true },                    // UNKNOWN key → must land in `extra`
  });

  // 4) store tree for projA's key: meta + one pipeline with the full file set.
  const keyDir = join(home, 'store', keyA);
  writeJson(join(keyDir, 'meta.json'), {
    key: keyA, path: projA, name: 'Maestro', firstSeenAt: '2026-06-03T12:22:12.230Z',
  });
  const runId = 'abcd1234';
  const runDir = join(keyDir, 'pipelines', `06-06-26-history-rework-${runId}`);
  writeJson(join(runDir, 'state.json'), {
    id: runId, title: 'History rework', projectDir: projA,
    status: 'done', phase: 'done', cycle: 0,
    startedAt: '2026-06-06T07:04:14.625Z', updatedAt: '2026-06-06T08:15:13.099Z',
    steps: [
      { key: 'preflight', phase: 'preflight', cycle: 0, status: 'done',
        startedAt: '2026-06-06T07:04:14.629Z', updatedAt: '2026-06-06T07:04:15.030Z',
        activeMs: 401, runningSince: null },
      { key: '0:s0_0', phase: 'planner', nodeId: 's0_0', stepIndex: 0, cycle: 1,
        status: 'done', startedAt: '2026-06-06T07:13:26.120Z',
        updatedAt: '2026-06-06T07:25:31.006Z', activeMs: 724886, runningSince: null,
        costUsd: 4.9647 },
      { key: 'done', phase: 'done', cycle: 0, status: 'done',
        startedAt: '2026-06-06T08:15:13.099Z', updatedAt: '2026-06-06T08:15:13.099Z',
        activeMs: 0, runningSince: null },
    ],
    stepper: { version: 1, steps: [{ kind: 'preflight', nodes: [] }], feedbacks: [] },
    tools: { graphify: true, tool: 'graphify', kind: 'cli', instruction: 'x' },
    checkpointRef: 'd50b0b46bd29f6997352f30c7265158b77e5a4b1',
    totalCostUsd: 25.1017, totalActiveMs: 3932418,
    branch: { source: 'main', feature: 'maestro/history-rework-abcd1234',
              worktreeDir: '/tmp/wt/abcd1234', reusedExisting: false },
    baseName: 'history-rework', datePrefix: '06-06-26',
  });
  writeText(join(runDir, 'prompt.md'), '# History fast-load plan\n\nbody text\n');
  writeText(join(runDir, 'pipeline.md'),
    '# Pipeline: History rework\n\n- **id**: abcd1234\n\n## Prompt\n\n' +
    '- `not a timeline line` should be ignored (pre-Timeline backtick line)\n\n' +
    '## Timeline\n\n' +
    '- `2026-06-06T07:04:15.010Z` Pipeline created (id abcd1234).\n' +
    '- `2026-06-06T07:04:15.029Z` Git checkpoint at `d50b0b46bd`.\n' +
    '- `2026-06-06T08:15:13.099Z` Pipeline finished with status **done**.\n');
  writeJson(join(runDir, 'clarify.json'), {
    questions: [{ id: 'q1', question: 'Which approach?', options: ['a', 'b', 'c'],
                  allowFreeText: true }],
  });
  writeJson(join(runDir, 'clarify-answers.json'), {
    answers: [{ id: 'q1', question: 'Which approach?', choice: 'a' }],
  });
  writeJson(join(runDir, 'impl-review-cycle1.json'), {
    issues: [{ severity: 'minor', title: 'x', detail: 'y', location: 'z' }],
    summary: 'impl ok',
  });
  writeJson(join(runDir, 'refine-review-cycle1.json'), {
    issues: [], summary: 'refine ok',
  });
  writeJson(join(runDir, 'webui-review-cycle1.json'), {
    issues: [], summary: 'webui ok',
  });
  // markdown that STAYS + extras + a stray md
  writeText(join(runDir, 'manual-tests-checklist.md'), '# checklist\n- [ ] do thing\n');
  writeText(join(runDir, 'webui-review-cycle1.md'), '# webui review\nPASS\n');
  writeText(join(runDir, 'DEVIATIONS.md'), '# deviations\nnone\n');
  writeText(join(runDir, 'extras', 'attachment.txt'), 'user attachment\n');
  // shared plan/review markdown linked by <datePrefix>-<base>
  writeText(join(keyDir, 'plans', '06-06-26-history-rework.md'), '# plan v1\n');
  writeText(join(keyDir, 'plans', '06-06-26-history-rework-v2.md'), '# plan v2\n');
  writeText(join(keyDir, 'reviews', '06-06-26-history-rework-impl-review.md'), '# review\n');

  // 5) settings.json — MUST be ignored + left in place.
  writeJson(join(home, 'settings.json'), { root: '/some/where' });

  return { projA, projB, keyA, keyB, runId, runDir, keyDir };
}

test('maybeMigrateFromFs imports the full legacy tree into every table', () => {
  const home = maestroHome();                 // <MAESTRO_HOME>/.maestro
  mkdirSync(home, { recursive: true });
  const fx = buildFixture(home);

  const db = getDb();                          // opens + migrate(); hook is the no-op stub still
  maybeMigrateFromFs(db);                      // explicit call (decoupled from getDb's own call)

  // projects
  const projCount = db.prepare('SELECT count(*) AS n FROM projects').get().n;
  assert.equal(projCount, 2, 'both registry projects imported');
  const pa = db.prepare('SELECT * FROM projects WHERE key = ?').get(fx.keyA);
  assert.equal(pa.name, 'Maestro');
  assert.equal(pa.path, fx.projA);
  assert.ok(pa.created_at, 'created_at synthesized');

  // workflows (DEFAULT excluded; the saved one present)
  const wf = db.prepare('SELECT * FROM workflows WHERE id = ?').get('wf_quick-fix');
  assert.equal(wf.name, 'Quick Fix');
  assert.deepEqual(JSON.parse(wf.steps)[0], [{ id: 's0_0', key: 'planner' }]);

  // project_config + normalized rows + extra
  const cfg = db.prepare('SELECT * FROM project_config WHERE project_key = ?').get(fx.keyA);
  assert.equal(cfg.active_workflow_id, 'wf_quick-fix');
  assert.deepEqual(JSON.parse(cfg.steps).planner, { model: 'claude-opus-4-8', effort: 'max' });
  assert.deepEqual(JSON.parse(cfg.custom_models), [{ id: 'my-model', label: 'My Model' }]);
  assert.deepEqual(JSON.parse(cfg.extra), { webUiTesting: { enabled: true } });
  const nodeRows = db.prepare(
    'SELECT * FROM config_workflow_nodes WHERE project_key = ? AND workflow_id = ? ORDER BY node_id'
  ).all(fx.keyA, 'wf_quick-fix');
  assert.equal(nodeRows.length, 2);
  assert.equal(nodeRows[0].node_id, 's0_0');
  assert.equal(nodeRows[0].fan_out, null, 's0_0 had no fanOut → NULL');
  assert.equal(nodeRows[1].fan_out, 0, 's1_0 fanOut:false → 0');
  const fbRows = db.prepare(
    'SELECT * FROM config_workflow_feedbacks WHERE project_key = ?'
  ).all(fx.keyA);
  assert.equal(fbRows.length, 1);
  assert.equal(fbRows[0].max_cycles, 2);

  // store_meta
  const meta = db.prepare('SELECT * FROM store_meta WHERE key = ?').get(fx.keyA);
  assert.equal(meta.kind, 'project');
  assert.equal(JSON.parse(meta.data).name, 'Maestro');

  // pipelines
  const pl = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(fx.runId);
  assert.ok(pl, 'pipeline row present');
  assert.equal(pl.project_key, fx.keyA);
  assert.equal(pl.workspace_key, null, 'single-project run has null workspace_key');
  assert.equal(pl.target, 'project');
  assert.equal(pl.status, 'done');
  assert.equal(pl.base_name, 'history-rework');
  assert.equal(pl.date_prefix, '06-06-26');
  assert.equal(pl.total_cost_usd, 25.1017);
  assert.equal(pl.total_active_ms, 3932418);
  assert.match(pl.prompt, /History fast-load plan/, 'prompt body from prompt.md');
  assert.equal(JSON.parse(pl.branch).feature, 'maestro/history-rework-abcd1234');
  assert.equal(JSON.parse(pl.stepper).version, 1);
  assert.equal(JSON.parse(pl.tools).tool, 'graphify');

  // pipeline_steps
  const steps = db.prepare(
    'SELECT * FROM pipeline_steps WHERE pipeline_id = ? ORDER BY key'
  ).all(fx.runId);
  assert.equal(steps.length, 3);
  const planner = steps.find((s) => s.key === '0:s0_0');
  assert.equal(planner.node_id, 's0_0');
  assert.equal(planner.step_index, 0);
  assert.equal(planner.cost_usd, 4.9647);
  assert.equal(planner.active_ms, 724886);
  const pre = steps.find((s) => s.key === 'preflight');
  assert.equal(pre.node_id, null, 'preflight carries no nodeId');
  assert.equal(pre.step_index, null);

  // pipeline_events (strict timeline lines ONLY; the pre-Timeline backtick line excluded)
  const events = db.prepare(
    'SELECT * FROM pipeline_events WHERE pipeline_id = ? ORDER BY id'
  ).all(fx.runId);
  assert.equal(events.length, 3, 'exactly the 3 timeline lines');
  assert.equal(events[0].ts, '2026-06-06T07:04:15.010Z');
  assert.match(events[0].text, /Pipeline created/);
  assert.match(events[2].text, /finished with status/);

  // clarify (one row, both halves)
  const cl = db.prepare('SELECT * FROM clarify WHERE pipeline_id = ?').get(fx.runId);
  assert.equal(JSON.parse(cl.questions).questions[0].id, 'q1');
  assert.equal(JSON.parse(cl.answers).answers[0].choice, 'a');

  // reviews (impl/refine/webui; cycle derived)
  const reviews = db.prepare(
    'SELECT * FROM reviews WHERE pipeline_id = ? ORDER BY kind'
  ).all(fx.runId);
  assert.deepEqual(reviews.map((r) => r.kind), ['impl', 'refine', 'webui']);
  assert.equal(reviews.every((r) => r.cycle === 1), true);
  const impl = reviews.find((r) => r.kind === 'impl');
  assert.equal(JSON.parse(impl.verdict).summary, 'impl ok');

  // artifacts: per-pipeline kept md + extras + stray md + shared plan/review
  const arts = db.prepare(
    'SELECT kind, rel_path FROM artifacts WHERE pipeline_id = ? ORDER BY kind, rel_path'
  ).all(fx.runId);
  const byKind = (k) => arts.filter((a) => a.kind === k).map((a) => a.rel_path);
  assert.deepEqual(byKind('manual-checklist'), ['manual-tests-checklist.md']);
  assert.deepEqual(byKind('webui-review'), ['webui-review-cycle1.md']);
  assert.deepEqual(byKind('extra'), ['extras/attachment.txt']);
  assert.deepEqual(byKind('extra-md'), ['DEVIATIONS.md']);
  assert.deepEqual(byKind('plan').sort(),
    ['plans/06-06-26-history-rework-v2.md', 'plans/06-06-26-history-rework.md']);
  assert.deepEqual(byKind('review'), ['reviews/06-06-26-history-rework-impl-review.md']);
});

// ── Task 4.2 — the self-guard (idempotent + no-op on empty/corrupt tree) ─────────

test('a second call is a no-op (idempotent) and does not duplicate rows', () => {
  const home = maestroHome();
  mkdirSync(home, { recursive: true });
  const fx = buildFixture(home);
  const db = getDb();

  maybeMigrateFromFs(db);
  const counts1 = tableCounts(db);
  assert.equal(counts1.projects, 2, 'first run imported');

  // Second call: the row-count self-guard must make it a no-op (no throw, no dupes).
  assert.doesNotThrow(() => maybeMigrateFromFs(db));
  const counts2 = tableCounts(db);
  assert.deepEqual(counts2, counts1, 'no table changed on the second call');
  void fx;
});

test('no-op when there is no legacy JSON at all', () => {
  const home = maestroHome();
  mkdirSync(home, { recursive: true });
  // Only a settings.json (bootstrap) — NOT a consumable source.
  writeJson(join(home, 'settings.json'), { root: '/x' });
  const db = getDb();
  assert.doesNotThrow(() => maybeMigrateFromFs(db));
  const counts = tableCounts(db);
  assert.equal(counts.projects, 0);
  assert.equal(counts.pipelines, 0);
  // settings.json must still be present (never consumed).
  assert.ok(existsSync(join(home, 'settings.json')), 'settings.json left in place');
  // No backup dir created when nothing was migrated.
  assert.equal(readdirSync(home).some((n) => n.startsWith('backup-')), false);
});

test('no-op when legacy JSON is present but only corrupt (no importable rows)', () => {
  const home = maestroHome();
  mkdirSync(home, { recursive: true });
  writeText(join(home, 'projects.json'), '{ this is not valid json');
  const db = getDb();
  assert.doesNotThrow(() => maybeMigrateFromFs(db));
  assert.equal(tableCounts(db).projects, 0, 'corrupt registry imported nothing');
});

// Sum helper used by the idempotency assertions.
function tableCounts(db) {
  const tables = ['projects', 'workspaces', 'workspace_projects', 'workflows',
    'project_config', 'config_workflow_nodes', 'config_workflow_feedbacks', 'pipelines',
    'pipeline_steps', 'pipeline_events', 'clarify', 'reviews', 'store_meta', 'artifacts'];
  const out = {};
  for (const t of tables) out[t] = db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;
  return out;
}

// ── Task 4.3 — archive: consumed JSON → backup-<ts>/; md/extras/settings stay ────

test('archives consumed JSON into backup-<ts>/ mirroring layout; leaves md/extras/settings', () => {
  const home = maestroHome();
  mkdirSync(home, { recursive: true });
  const fx = buildFixture(home);
  const db = getDb();
  maybeMigrateFromFs(db);

  // Exactly one backup-<ts>/ dir was created.
  const backups = readdirSync(home).filter((n) => n.startsWith('backup-'));
  assert.equal(backups.length, 1, 'one backup dir created');
  const backup = join(home, backups[0]);

  // CONSUMED json moved OUT of their original locations...
  assert.ok(!existsSync(join(home, 'projects.json')), 'projects.json moved');
  assert.ok(!existsSync(join(fx.runDir, 'state.json')), 'state.json moved');
  assert.ok(!existsSync(join(fx.runDir, 'pipeline.md')), 'pipeline.md moved (consumed)');
  assert.ok(!existsSync(join(fx.runDir, 'clarify.json')), 'clarify.json moved');
  assert.ok(!existsSync(join(fx.runDir, 'impl-review-cycle1.json')), 'review json moved');
  assert.ok(!existsSync(join(fx.keyDir, 'meta.json')), 'meta.json moved');
  assert.ok(!existsSync(projectConfigPath(fx.projA)), 'per-project config.json moved');

  // ...and now live under backup-<ts>/ mirroring the home-relative layout.
  assert.ok(existsSync(join(backup, 'projects.json')), 'projects.json mirrored');
  assert.ok(existsSync(join(backup, 'workflows', 'wf_quick-fix.json')), 'workflow mirrored');
  const relRun = relativeToHome(home, fx.runDir);
  assert.ok(existsSync(join(backup, relRun, 'state.json')), 'state.json mirrored under store/.../');
  assert.ok(existsSync(join(backup, relRun, 'pipeline.md')), 'pipeline.md mirrored');
  assert.ok(existsSync(join(backup, relRun, 'clarify.json')), 'clarify.json mirrored');
  assert.ok(existsSync(join(backup, relRun, 'impl-review-cycle1.json')), 'review mirrored');
  // per-project config namespaced by projectKey under project-config/<key>/.
  assert.ok(existsSync(join(backup, 'project-config', fx.keyA, 'config.json')),
    'per-project config namespaced in backup');

  // MARKDOWN + extras + settings + the run dir itself STAY in place.
  assert.ok(existsSync(join(fx.runDir, 'prompt.md')), 'prompt.md stays');
  assert.ok(existsSync(join(fx.runDir, 'manual-tests-checklist.md')), 'checklist md stays');
  assert.ok(existsSync(join(fx.runDir, 'webui-review-cycle1.md')), 'webui review md stays');
  assert.ok(existsSync(join(fx.runDir, 'DEVIATIONS.md')), 'stray md stays');
  assert.ok(existsSync(join(fx.runDir, 'extras', 'attachment.txt')), 'extras stay');
  assert.ok(existsSync(join(fx.keyDir, 'plans', '06-06-26-history-rework.md')), 'plan md stays');
  assert.ok(existsSync(join(fx.keyDir, 'reviews', '06-06-26-history-rework-impl-review.md')),
    'review md stays');
  assert.ok(existsSync(join(home, 'settings.json')), 'settings.json NEVER moved');
  // NONE of the kept markdown/extras leaked into the backup.
  assert.ok(!existsSync(join(backup, relRun, 'prompt.md')), 'prompt.md not in backup');
  assert.ok(!existsSync(join(backup, relRun, 'manual-tests-checklist.md')), 'checklist not in backup');
  assert.ok(!existsSync(join(backup, relRun, 'extras', 'attachment.txt')), 'extras not in backup');
  assert.ok(!existsSync(join(backup, 'settings.json')), 'settings.json not in backup');
});

// Path helpers for the archive assertions (kept local to the test file). join is
// already imported at the top; relative is aliased here to avoid shadowing it.
import { relative as _relative } from 'node:path';
function relativeToHome(home, p) { return _relative(home, p); }
function projectConfigPath(projectDir) { return join(projectDir, '.maestro', 'config.json'); }
