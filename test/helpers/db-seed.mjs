// test/helpers/db-seed.mjs
// Insert a pipelines row (+ optional steps) directly, for history/list/delete tests
// that previously seeded a state.json fixture. Mirrors what writeState() persists.
//
// ⚠️ TEMPORARY STOPGAP (Phase 3) — REPLACE IN PHASE 6 (Task 6.x / A6(2) + A15(3)).
// The binding plan requires this shared helper to seed via the PRODUCTION writers
// (createPipeline + writeState) so fixtures can't drift from the schema — NOT a
// hand-maintained raw INSERT. The canonical design is `seedPipeline(projectDir, state)`
// / `seedWorkspacePipeline(...)` (SQLITE-MIGRATION-PLAN-v3.md §"New shared helper:
// test/helpers/db-seed.mjs"). Phase 6 must: (1) implement those production-writer helpers
// with the A15(3) id contract (persisted id IS createPipeline's MINTED id; callers use
// the RETURNED id; drop `id` from the seed state); (2) re-point all 9 call sites
// (artifacts-cost/duration/branch-stats/pr-state, list-all-pipelines, read-pipeline-by-key,
// history-api, pr-api, workspaces-api) to a real/throwaway projectDir + returned id/key;
// (3) delete seedPipelineRow. The column list below is verified to match writeState/
// toPipelineRow as of Phase 3 — keep it in sync if the row shape changes before Phase 6.
import { getDb, tx } from '../../src/core/db.mjs';

export function seedPipelineRow(row) {
  const {
    id, projectKey = 'proj-00000001', workspaceKey = null, target = 'project',
    title = null, baseName = null, datePrefix = null, status = 'done', phase = 'done',
    cycle = 0, startedAt = null, updatedAt = startedAt, totalCostUsd = 0, totalActiveMs = 0,
    prompt = null, branch = null, workspaceMeta = null, stepper = null, tools = null,
    steps = [],
  } = row;
  tx(() => {
    getDb().prepare(`
      INSERT INTO pipelines (id, project_key, workspace_key, target, title, base_name,
        date_prefix, status, phase, cycle, started_at, updated_at, total_cost_usd,
        total_active_ms, prompt, branch, workspace_meta, stepper, tools)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, projectKey, workspaceKey, target, title, baseName, datePrefix, status, phase,
      cycle, startedAt, updatedAt, totalCostUsd, totalActiveMs, prompt,
      branch == null ? null : JSON.stringify(branch),
      workspaceMeta == null ? null : JSON.stringify(workspaceMeta),
      stepper == null ? null : JSON.stringify(stepper),
      tools == null ? null : JSON.stringify(tools),
    );
    const ins = getDb().prepare(`
      INSERT INTO pipeline_steps (pipeline_id, key, node_id, phase, step_index, cycle,
        status, started_at, updated_at, active_ms, running_since, cost_usd)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const st of steps) {
      ins.run(id, st.key, st.nodeId ?? null, st.phase ?? null, st.stepIndex ?? null,
        st.cycle ?? null, st.status ?? null, st.startedAt ?? null, st.updatedAt ?? null,
        st.activeMs ?? 0, st.runningSince ?? null, st.costUsd ?? 0);
    }
  });
}
