# Pipeline Composer — Design

Date: 2026-06-01
Status: Approved (design); implementation plan to follow.

## 1. Goal

Add a **Pipeline Composer** to Maestro: a drag-and-drop canvas for composing how
agents collaborate into a workflow (sequential steps, parallel groups, feedback
loops), the ability to **save workflows permanently by name**, and a **New
Pipeline** integration that lets the user pick a saved workflow, configure each
agent's model/effort, and configure the cycle count of each feedback loop.

The engine becomes **data-driven**: it executes an arbitrary saved workflow
(sequential + parallel steps + user-defined feedback loops) instead of the
current hardcoded `Plan → Refine → Implement → Review` sequence.

The default workflow is the **current** pipeline `Plan → Refine → Implement →
Review`; "Reset to default" on the canvas redraws exactly that.

## 2. Scope (decided)

- **Agents — 6 runnable.** Keep the existing 4 (Plan, Refine Plan,
  Implementation, Review Implementation) and add **2 new, fully built**:
  - **Manual Tests Checklist** — drafts manual test cases.
  - **Manual web UI testing** — runs the manual cases against the live web UI via
    Playwright (MCP), emits a pass/fail verdict.
  The agent system is made **data-driven for N agents** so future agents drop in
  without core edits. We are *not* building the other mockup agents (Coordinator,
  Human-in-the-loop, Tests Implementation, Tests Execution, Manual Tests
  Execution, Pull Request) in this work.
- **Engine — full data-driven execution.** Parallel groups run concurrently;
  arbitrary feedback loops, each with its own cycle count.
- **Saved workflows — read-only + run.** Saved workflows are immutable previews
  (as in the mockup); to change one, rebuild on the canvas. They are selectable
  to run from New Pipeline via a **dropdown of saved workflow names** (+ Default).

## 3. Current architecture (verified, with anchors)

- **UI** — vanilla-JS SPA, no framework/build step. `ui/public/index.html`
  (hidden `section.view[data-view]` blocks: `new`, `running`, `history`),
  `ui/public/app.js` (~2138 lines; router `VIEW_NAMES` at `app.js:2074`,
  `showView()` toggles `.hidden`, `navLinks` auto-wires links by `data-nav`),
  `ui/public/style.css` (design tokens). Per-stage model/effort already shipped:
  `STEP_ROLES` (`app.js:22`), `.stage-cfg` markup (`index.html:156-194`),
  `renderStepConfigs()` (`app.js:486`).
- **Engine** — `src/core/orchestrator.mjs`; `run()` (L168-292) is a **hardcoded**
  sequence Preflight → Clarify → Plan → Refine-loop → Implement → Review-loop →
  Done (phase calls inline L222-256). Two hardcoded loops: `_refineLoop()`
  (L331-389) and `_reviewLoop()` (~L395-459), each gating at
  `maxRefineCycles`/`maxReviewCycles`. **No parallelism.** Phase runners in
  `src/core/phases.mjs` (`runPlannerClarify`, `runPlannerPlan`, `runRefiner`,
  `runImplementer`, `runReviewer`) each call `runClaude()`
  (`src/core/claude-runner.mjs`, headless `claude` or `MAESTRO_MOCK`).
- **Agents** — 4 fixed roles. `AGENT_STEPS` (`config.mjs:18-23`), `AGENT_FILES`
  (`orchestrator.mjs:48-53`). Prompts are markdown + YAML frontmatter
  (`name, description, tools`); no icon/displayName/connection metadata.
  `PREDEFINED_MODELS` (`config.mjs:45-55`, 9 models), `EFFORTS`
  (`config.mjs:28` = `medium|high|xhigh|max`). Verdict contract in
  `src/core/protocol.mjs` (`SEVERITIES` L15 — critical/major block; review shape
  `{issues:[{severity,title,detail,location}], summary}` L208-222).
- **Persistence/API** — `ui/server.mjs` (Express + ws); in-memory `runs` Map;
  routes `/api/run`, `/api/answer`, `/api/stop`, `/api/runs`, `/api/config`,
  `/api/projects`, `/api/install`. Per-project config
  `<projectDir>/.maestro/config.json` = `{ steps:{role:{model,effort}},
  customModels:[{id,label}] }` (`config.mjs:68`), resolved by
  `resolveStepModels()` (`config.mjs:208-216`). Runs persist to
  `<projectDir>/ai-artifacts/pipelines/<date>-<slug>-<id>/` (`artifacts.mjs`).
  Global project registry `~/.maestro/projects.json` (`projects.mjs`).

## 4. Data model

### 4.1 Agent metadata (per-agent sidecar)

Each agent gets `agents/<key>.meta.json` so adding an agent is "drop files, no
core edits". A loader scans `agents/*.meta.json` to build the registry that is
currently hardcoded across `AGENT_FILES`, `AGENT_STEPS`, and client `STEP_ROLES`.

```json
{
  "key": "manualWebUiTesting",
  "displayName": "Manual web UI testing",
  "description": "run manual cases via Playwright",
  "color": "violet",
  "icon": "<svg path markup, viewBox 0 0 24 24>",
  "agentFile": "maestro-manual-web-ui-testing.md",
  "runnerType": "verifier",
  "loopSource": true,
  "connectsTo": "*",
  "order": 6
}
```

- `agentFile` — prompt markdown; may be `null` for non-executable palette-only
  agents (none in this scope).
- `runnerType` — selects a function from the runner registry (see §6).
- `loopSource` — may originate a feedback loop (emits a blocking/non-blocking
  verdict).
- `connectsTo` — `"*"` for now (every agent connects to every other).
- `order` — palette render order.

The 6 shipped meta files: `planner`, `refiner`, `implementer`, `reviewer`,
`manualTestsChecklist`, `manualWebUiTesting`. Colors/icons seeded from the mockup
palette (`C`/`TINT`/`ICON` maps) and the existing CSS color tokens.

### 4.2 Workflow template (topology only, reusable, global)

Stored at `~/.maestro/workflows/<id>.json`. Topology only — no model/effort/cycle
data (those are per-project run-config, §4.3).

```json
{
  "id": "wf_quickfix",
  "name": "Quick Fix",
  "version": 1,
  "steps": [
    [ { "id": "s0_0", "key": "planner" } ],
    [ { "id": "s1_0", "key": "implementer" } ],
    [ { "id": "s2_0", "key": "reviewer" } ]
  ],
  "feedbacks": [ { "id": "fb_0", "from": "s2_0", "to": "s1_0" } ],
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

- `steps` — outer array = sequential step order; inner array = parallel group
  (a step with >1 node runs concurrently).
- node `id` — **unique instance id** within the workflow (not the role key).
  Feedback `from`/`to` and run-config keys reference these instance ids, which
  resolves the "a role repeats across cycles/steps" ambiguity surfaced in the
  scan.

The **default workflow** is a built-in template (not persisted to the user store,
always present): `Plan → Refine → Implement → Review` with the feedback loops
that reproduce today's `_refineLoop`/`_reviewLoop` behavior (see §6.4).

### 4.3 Run-config (per-project: model/effort/cycles)

Extends `.maestro/config.json`. Backward-compatible: the existing `steps`/
`customModels` keys are untouched.

```json
{
  "steps": { "...legacy per-role..." : {} },
  "customModels": [],
  "workflows": {
    "wf_quickfix": {
      "nodes": { "s1_0": { "model": "claude-opus-4-8", "effort": "high" } },
      "feedbacks": { "fb_0": { "maxCycles": 3 } }
    }
  },
  "activeWorkflowId": "wf_quickfix"
}
```

Keyed by node-instance id (model/effort) and feedback id (cycle count).
`activeWorkflowId` remembers the last workflow selected in New Pipeline.

## 5. UI

### 5.1 Pipeline Composer view (`data-view="composer"`)

New left-nav item + topnav link (wired through `VIEW_NAMES`/`navLinks`) and a new
`section.view[data-view="composer"]`. Canvas ported from the mockup:

- **Palette** built from the agent registry (6 pills, colored dot + display
  name), `draggable`.
- **Canvas** (dotted grid): drop on a gap strip → `steps.splice(i,0,[node])`
  (new sequential step); drop onto an existing column → `steps[i].push(node)`
  (parallel member; column tagged "Step N · parallel").
- **Wires** via a shared `paintWires` SVG renderer: grey dashed beziers fan
  sequential flow; amber dashed arcs for feedback loops with a clickable
  circle-X delete. Loop creation: hover a node → "loop" button → linking mode
  (amber banner) → click target.
- **Toolbar**: **Reset to default** (rebuild the current 4-step pipeline),
  **Clear canvas**, **Save pipeline** (prompt for a name → `POST /api/workflows`
  → prepend to saved list).
- **Saved pipelines** card: collapsible rows (name; meta line "N steps · M
  agents · K feedback loops"; distinct-agent chips; **read-only** locked canvas
  preview; trash/delete). No edit/load affordance (read-only + run).

### 5.2 New Pipeline integration

Add a **workflow dropdown** (options: Default + each saved workflow name). On
select:

- Render each workflow node with model + effort pickers (reuse the `.stage-cfg`
  pattern / `renderStepConfigs`, iterating workflow nodes keyed by node id rather
  than the fixed `STEP_ROLES`).
- Render each feedback loop with a **cycle-count** input (default from
  run-config or 3).
- Persist edits to run-config (`PATCH /api/config` style).
- On run, `POST /api/run` sends `{ projectDir, prompt, workflowId }`; the server
  resolves topology + run-config into an executable plan.

## 6. Engine (data-driven dispatcher)

### 6.1 Resolution

`resolveWorkflow(projectDir, workflowId)` loads the template (global store, or the
built-in default) and merges per-project run-config → an executable plan:
`{ steps:[ [ {nodeId,key,runnerType,agentFile,model,effort,tools,loopSource} ] ],
feedbacks:[ {id,from,to,maxCycles} ] }`.

### 6.2 Dispatcher

`run()`'s inline sequence is replaced by a dispatcher that walks the resolved
steps in order:

- A step with one node runs that node's runner.
- A step with >1 node runs them concurrently (`Promise.all`). Events are tagged
  with `nodeId`, `stepIndex`, and `cycle` so the WS stream and UI can attribute
  interleaved emits from parallel nodes (the current single-threaded emit
  assumption is replaced by id-tagged aggregation).

### 6.3 Generic feedback loop

`_refineLoop`/`_reviewLoop` collapse into one generic loop mechanism: when a
`loopSource` node emits **blocking** issues (critical/major per `protocol.mjs`)
and the loop's `maxCycles` is not exhausted, the dispatcher jumps the execution
pointer back to the loop's `to` step and re-runs forward (incrementing that
loop's cycle counter). When cycles are exhausted, it **gates to the user**
(continue/stop) exactly as today.

### 6.4 Runner registry & types

`phases.mjs`'s named exports are wrapped in a registry `Map<runnerType, fn>`:

- `producer` — generates artifacts/code (Plan, Refine, Implement, **Manual Tests
  Checklist**). Carries the existing planner/refiner/implementer specializations
  via mode flags.
- `verifier` — emits the review-cycle verdict JSON; eligible as a `loopSource`
  (Review, **Manual web UI testing**).

New agents pick an existing `runnerType` and need **no engine code**. Adding a
genuinely new behavior = add one runner to the registry.

### 6.5 Default-workflow parity

The default 4-step workflow is a built-in template executed through the **same
dispatcher** — there is no separate hardcoded path. Its feedback loops are
configured to reproduce current `_refineLoop`/`_reviewLoop` semantics and cycle
gates. Parity is protected by the existing test suite and
`MAESTRO_MOCK=1 npm run smoke`.

### 6.6 Validator

New `src/core/workflow-validator.mjs`: feedback `to` step precedes its `from`
step; no empty steps; every node `key` exists in the registry and is runnable
(else the run is rejected with a clear message); `maxCycles >= 1`. The forward
step graph is inherently acyclic (steps are ordered); only feedback edges create
cycles, and those are bounded by `maxCycles`.

## 7. Persistence + API

- New **`/api/workflows`** CRUD mirroring the `/api/config` handler pattern
  (`server.mjs`): `GET` (list), `GET /:id`, `POST` (create), `DELETE /:id`.
  Templates stored at `~/.maestro/workflows/<id>.json` (global, atomic
  temp+rename write like config).
- `/api/run` accepts an optional `workflowId` (defaults to the built-in default
  workflow → current behavior).
- `artifacts.mjs` is unchanged; runs still persist under
  `ai-artifacts/pipelines/`.

## 8. The two new agents

- **Manual Tests Checklist** (`runnerType: producer`, `loopSource: false`) —
  prompt reads the plan + implementation diff and writes a markdown checklist of
  manual test cases as a pipeline artifact.
- **Manual web UI testing** (`runnerType: verifier`, `loopSource: true`) —
  frontmatter declares Playwright MCP tools; prompt drives the running web UI
  through the checklist and emits the `protocol.mjs` verdict JSON
  (`issues[]` + `summary`). On blocking issues it can drive a feedback loop back
  to Implementation.

**Open item (one):** the Manual web UI testing agent needs the target app
running. The plan will define a `webUiTesting.startCommand` (and optional base
URL) in the project's `.maestro/config.json`; if absent, the agent is instructed
to start the app per the project README and report if it cannot. This is the only
unresolved detail and will be pinned in the implementation plan.

## 9. Adding-an-agent docs

A new doc (in `skills/maestro` or `docs/ADDING-AGENTS.md`) describing: create
`agents/<key>.md` (prompt + frontmatter, incl. `tools`), create
`agents/<key>.meta.json` (icon/displayName/color/runnerType/loopSource/
connectsTo), choose an existing `runnerType` or add one to the registry, and how
template topology + per-project run-config resolve at run time.

## 10. Testing (TDD)

Unit tests: registry loader; workflow validator (each rejection rule); generic
loop dispatcher (loop fires on blocking, stops at maxCycles, gates user);
parallel step aggregation (id-tagged events, all nodes complete); workflow CRUD
(create/list/get/delete, atomic write). Integration: `MAESTRO_MOCK=1 npm run
smoke` green for both the default workflow and a custom saved workflow (incl. a
parallel step and a feedback loop).

## 11. Decisions (override if needed)

- Workflow **templates are global** (`~/.maestro/workflows/`); model/effort/cycle
  **run-config is per-project** (`.maestro/config.json`).
- Feedback/run-config references use **node-instance ids**, not role names.
- **Generic runner types** (`producer`/`verifier`) so most new agents need no
  engine code.
- The final **implementation plan file lands at the repo root** (per request);
  this design doc lives under `docs/superpowers/specs/`.
