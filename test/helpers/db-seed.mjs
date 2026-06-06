// test/helpers/db-seed.mjs
// Insert a pipelines row (+ optional steps) directly, for history/list/delete tests
// that previously seeded a state.json fixture. Mirrors what writeState() persists.
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
