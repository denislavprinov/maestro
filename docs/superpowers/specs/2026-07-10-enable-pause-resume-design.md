# Enable App: Pipeline Pause & Continuation

Date: 2026-07-10
Status: approved

## Problem

Maestro's core engine and main UI support graceful pause and resume of pipelines:
`orch.pause()` persists a `resume_point` (db v5), session/usage limits auto-pause
runs, and `POST /api/pause` / `POST /api/resume` in `ui/server.mjs` drive it. The
Enable app has none of this. A real run (bevup-studio, pipeline `c0dc5726`) was
auto-paused mid-fix-cycle by a Claude session limit and is only resumable from the
core UI or CLI — not from the Enable app that started it.

## Goal

Full parity in the Enable app: user-triggered pause on a live run, resume of
paused/interrupted runs (covers both manual pause and session-limit auto-pause),
surfaced in both the live run screen and the history list.

## Non-goals

- No new engine capability. Pure reuse of existing core primitives.
- No cross-app HTTP calls: the Enable server does NOT call the maestro UI server's
  endpoints (separate process, separate auth). It imports the same core functions
  one layer down.
- No workspace-target resume in Enable (Enable runs are always single-project).

## Reused core primitives

| Primitive | Location |
|---|---|
| `orch.pause()` | `src/core/orchestrator.mjs:304` |
| `orch.resume()` | `src/core/orchestrator.mjs:593` |
| `readPipelineForResume(pipelineId)` | `src/core/artifacts.mjs:1163` |
| `createOrchestrator({ resume: saved })` | `src/core/orchestrator.mjs` |
| `reconcileStaleRunning()` | `src/core/artifacts.mjs` |
| Reference HTTP semantics | `ui/server.mjs:760` (pause), `:780` (resume) |

## Design

### 1. Core: `src/core/onboarding.mjs`

**Extract shared wiring.** The body of `runOnboarding()` steps 3–5 (event
forwarding, `wireGateAnswers`, readiness emission on phase boundaries, the
done-promise that emits final readiness) moves into an internal helper:

```
wireOnboardingRun(orch, { answers, interactive, kick })
  -> { runId, events, done, orch }
```

`kick` is the function that starts the engine: `() => orch.run()` for fresh runs,
`() => orch.resume()` for resumed ones. `runOnboarding()` becomes a thin caller;
its public signature and behavior are unchanged.

**New export:**

```
resumeOnboarding({ pipelineId, interactive = false, mock = false, answers = {} })
  -> { runId, events, done, orch, pipelineId }
```

Steps:
1. `saved = readPipelineForResume(pipelineId)`; 404-style error if absent.
2. Validate: `saved.row.status` is `paused` or `interrupted`; `saved.resumePoint`
   present; `saved.row.title === ENABLE_TITLE` (refuse resuming non-Enable
   pipelines through the Enable app).
3. Resolve `projectDir` from the projects registry via `saved.row.project_key`
   (same mapping as `ui/server.mjs:817`). Error if the project is not onboarded
   on this machine.
4. Worktree check: if `saved.row.branch.worktreeDir` set and missing on disk,
   fail fast with `worktree missing: <path>`.
5. `createOrchestrator({ projectDir, resume: saved, claude: { permissionMode:
   'acceptEdits', mock } })`.
6. `wireOnboardingRun(orch, { answers, interactive, kick: () => orch.resume() })`.

**Readiness replay on resume.** A reconnecting/resumed UI needs its ring and
per-cycle scores back. Before kicking `orch.resume()`, read what already exists
in the pipeline dir and emit synchronously into the events stream (so the
server's buffer replays them to any subscriber):

- `readBaselineReadiness(dir)` → emit `{ kind: 'baseline', ... }` if present,
  and seed `baselineEmitted = true`.
- `readCycleScore(dir, n)` for `n = 1..` while present → emit
  `{ kind: 'cycle', cycle: n, ... }` and seed `cyclesEmitted`.

The phase-boundary listeners then continue exactly as in a fresh run. The dir
for the replay reads is resolved from `saved.row` BEFORE the engine starts, via
the same store-path logic `listAllPipelines()` uses (`projectStorePath(
project_key)/pipelines/<date-prefix>-...-<id>`); do not wait for
`orch.getState().pipelineDir`, which is only set once resume dispatch begins.

**Clarify on resume.** The clarify step is already `done` in cycle 1; the
orchestrator's resume point restarts at the paused node (e.g. `2:s_infra#2`), so
no clarify question re-fires. `wireGateAnswers` still handles gate/recovery
questions with the same policy as fresh runs: unattended by default
(`gate → continue`, `recovery → abort`), interactive when requested.

### 2. Core: `src/core/artifacts.mjs`

`listAllPipelines()` SELECT gains `resume_point IS NOT NULL AS has_resume_point`;
each returned row carries `hasResumePoint: boolean`. No other callers change
(additive field).

### 3. Server: `apps/enable/server.mjs`

**`POST /api/enable/pause { runId }`**
- Unknown runId → 400.
- `entry.orch.pause()`; falsy return → 400 `cannot pause in the current state`.
- Set `entry.status = 'pausing'`; buffer + broadcast `{ type: 'paused', runId }`
  frame so replaying clients render the paused banner.
- The orchestrator's own `done`/`state` events land afterwards with final status
  `paused` (existing `done.then` already mirrors `entry.status`).

**`POST /api/enable/resume { pipelineId, interactive?, mock? }`**
- Double-resume guard: reject if any live entry in `runs` has this `pipelineId`
  with status not in `done|stopped|error|paused|interrupted`.
- Call `resumeOnboarding(...)`. Validation errors → 400 with message.
- Register a NEW entry (new `runId`, `entry.pipelineId = pipelineId`) with the
  same EVENTS forwarding loop as `/api/enable/run` (factor the wiring into a
  local `registerRun(runId, handle)` helper — run and resume share it).
- Evict superseded paused/interrupted entries for the same `pipelineId` from
  `runs` (mirrors `ui/server.mjs:851`).
- Respond `{ runId, pipelineId }`.

**History.** `enableHistory()` calls `reconcileStaleRunning()` first (orphaned
`running` rows from a crashed server become `interrupted`), then tags each entry:

```
resumable = (status === 'paused' || status === 'interrupted') && hasResumePoint
```

`/api/enable/run` entries also record `entry.pipelineId` (from
`orch.getState().pipelineId` once available) so pause/resume guards and history
cross-references work for fresh runs too.

The existing delete route keeps refusing runs that are live; paused runs remain
deletable (engine `deletePipeline` already handles them).

### 4. Renderer: `apps/enable/public/` (app.js, index.html, styles.css)

**Live run screen**
- Pause button in the progress header, visible while a run is active.
  Click → `POST /api/enable/pause` → button enters "Pausing…" disabled state.
- On `{ type: 'paused' }` frame or `done` with `status: 'paused'`: freeze the
  stepper, stop the live meter, show a banner — "Run paused — resume when
  ready" — with a Resume button. Show the pause reason when the last log line
  carries one (session-limit message).
- Resume click → `POST /api/enable/resume { pipelineId }` → reconnect the WS
  with the NEW `runId` (`?runId=` replay restores frames, including the
  readiness replay) and continue rendering on the same progress screen.

**History list**
- Entries with `resumable: true` render a Resume button beside the existing
  actions; status chip shows "Paused" / "Interrupted".
- Click → same resume POST → navigate to the progress screen wired to the new
  `runId`.

**Session-limit auto-pause** needs no special casing: the engine pauses itself,
the `done` promise resolves with `status: 'paused'`, and the same banner path
renders. The reason string comes from the run's last warn log frame.

### 5. Errors

All resume failure modes surface as 400s with actionable text, rendered in the
existing error strip: `pipeline not found`, `pipeline is "X", not resumable`,
`pipeline has no resume point`, `worktree missing: <path>`, `project ... not
onboarded on this machine`, `pipeline is already live`.

### 6. Testing

Style mirrors `test/server-pause-resume.test.mjs` (mock runner, real engine).

1. **Core unit — `resumeOnboarding`**: refuses wrong title / wrong status /
   missing resume point; wires readiness replay (baseline + cycle frames emitted
   before engine events); kicks `orch.resume()` not `orch.run()`.
2. **Core unit — `runOnboarding` regression**: unchanged behavior through the
   extracted `wireOnboardingRun` (existing onboarding tests keep passing).
3. **Enable server e2e**: start mock run → pause → status lands `paused`,
   paused frame buffered/broadcast → resume → new runId, old entry evicted,
   run completes `done`; double-resume guarded; history shows
   `resumable: true` while paused.
4. **`listAllPipelines`**: `hasResumePoint` true for paused row with resume
   point, false otherwise.

## Out of scope / follow-up

- `Workflow warning: feedback "fb_eval": "onboardingEvaluator" is not allowed to
  connect to "projectOnboarding" (connectsTo)` — wf_enable topology declaration
  inconsistency, separate fix.
- Electron menu integration for pause/resume shortcuts.
