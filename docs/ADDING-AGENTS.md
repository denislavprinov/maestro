# Adding an agent to Maestro

Maestro's agent system is **data-driven**: an agent is two sibling files in
`agents/` plus a choice of *runner*. Drop those files in and the agent appears
in the **Pipeline Composer** palette automatically — no edits to the engine,
the orchestrator, or the UI. This page is the complete recipe.

A new agent that **reuses** an existing runner branch needs no engine edits. A
genuinely new behavior (e.g. a verifier that reviews a new artifact and loops to
a different target) additionally needs a `case` in `runners.mjs` (and a `run*` in
`phases.mjs`, a `legacyFields`/`allocate` case in `channels.mjs`, an `AGENT_FILES`
entry, and a mock case) — see `planReviewer` as the worked example.

> Authoritative module/event/file contract: [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).
> Composer design: [`docs/superpowers/specs/2026-06-01-pipeline-composer-design.md`](superpowers/specs/2026-06-01-pipeline-composer-design.md).

## TL;DR

1. Write the prompt: `agents/maestro-<your-role>.md` (YAML frontmatter incl. `tools`, then the system prompt).
2. Write the sidecar: `agents/<key>.meta.json` (`key`, `displayName`, `color`, `icon`, `agentFile`, `runnerType`, `loopSource`, `order`, …).
3. Pick a `runnerType`: `producer` (makes artifacts/code) or `verifier` (emits a review verdict, can drive a feedback loop). Only add a runner if you need genuinely new behavior. **Reusing** an existing runner branch needs no engine edits; a genuinely new behavior (e.g. a verifier that reviews a new artifact and loops to a different target) additionally needs a `case` in `runners.mjs` (plus a `run*` in `phases.mjs`, a `legacyFields`/`allocate` case in `channels.mjs`, an `AGENT_FILES` entry, and a mock case) — see `planReviewer` as the worked example.
4. **Done.** `loadAgentRegistry()` scans `agents/*.meta.json`, so the agent is in the palette and drag-droppable. Topology you draw in the Composer + your project's model/effort/cycle settings resolve into an executable plan at run time.
5. Verify the pairing: run the guard at the bottom of this page (and `node --test test/agents-meta.test.mjs`).

`key` is the canonical camelCase identifier used **everywhere** (registry,
workflow node `key`, run-config). The seven shipped keys are: `planner`,
`refiner`, `planReviewer`, `implementer`, `reviewer`, `manualTestsChecklist`,
`manualWebUiTesting`.

---

## Step 1 — Write `agents/maestro-<role>.md` (prompt + frontmatter)

The prompt is markdown with a YAML frontmatter block. The orchestrator loads the
body as the agent's *appended system prompt* (prepended with the preflight
tool instruction). Frontmatter mirrors the existing four agents
(`agents/maestro-planner.md`, `…-implementer.md`, `…-code-reviewer.md`):

```markdown
---
name: maestro-manual-web-ui-testing
description: Runs the drafted manual UI checklist against the live web app via Playwright (MCP) and emits the protocol.mjs verdict JSON so it can drive a feedback loop back to Implementation. Invoked by the deterministic orchestrator.
tools: Read, Bash, Grep, Glob, mcp__plugin_playwright_playwright__browser_navigate, mcp__plugin_playwright_playwright__browser_click, mcp__plugin_playwright_playwright__browser_type, mcp__plugin_playwright_playwright__browser_snapshot, mcp__plugin_playwright_playwright__browser_take_screenshot
model: inherit
---

You are the **Manual web UI testing** agent in a deterministic, data-driven
pipeline. You are spawned headlessly... (full role instructions here).
```

Frontmatter keys:

- **`name`** — the agent's headless identifier. By convention `maestro-<role>`,
  matching the file stem.
- **`description`** — one paragraph: what the agent does and that it is invoked
  by the orchestrator (never directly by a human). Keep it crisp; it is also a
  routing hint.
- **`tools`** — the **allowed tools** for this agent, comma-separated. Grant the
  minimum it needs:
  - Producers that write artifacts/code use the read/write set, e.g.
    `Read, Write, Edit, Bash, Grep, Glob` (the implementer additionally uses
    `MultiEdit`; see `src/core/phases.mjs` `READ_WRITE_TOOLS`/`IMPLEMENTER_TOOLS`).
  - A verifier that only inspects + reports needs less write capability, e.g.
    `Read, Bash, Grep, Glob`.
  - **MCP tools** (e.g. Playwright) are declared by their fully-qualified tool
    names, exactly as in the example above. This is how *Manual web UI testing*
    gets a browser. Declaring a tool the environment doesn't provide simply
    means it's unavailable at run time — instruct the agent to degrade
    gracefully and report if it cannot proceed.
  - Add `Skill` if the agent must invoke project/personal skills via the `Skill`
    tool (headless `claude -p` otherwise denies skill calls).
- **`model: inherit`** — keep this. The effective model/effort is chosen
  per-node by the user's run-config (Step 5), not pinned in the prompt.

**If the agent emits a verdict** (a `verifier`, see Step 3), the prompt MUST
instruct it to write the review JSON in the `protocol.mjs` shape so the loop can
gate on it:

```json
{
  "issues": [
    { "severity": "critical", "title": "…", "detail": "…", "location": "path:line" }
  ],
  "summary": "1-3 sentence verdict."
}
```

Severities are `critical | major | minor | suggestion`; **only `critical` and
`major` are blocking** (`src/core/protocol.mjs` `SEVERITIES` / `hasBlocking`).
Report `[]` with a positive summary when the run genuinely passes. See
`agents/maestro-code-reviewer.md` for the canonical verdict-writing prose to
copy.

> A prompt may be omitted only for a non-executable, palette-only agent — set
> `"agentFile": null` in the meta. None ship today; every agent in scope has a
> prompt.

---

## Step 2 — Write `agents/<key>.meta.json` (the sidecar)

This sidecar is what makes the agent *discoverable*. `loadAgentRegistry()` scans
`agents/*.meta.json` and builds the registry that the palette, the orchestrator,
and the per-project config all read from. **Every field, explained:**

| Field | Type | Meaning |
|-------|------|---------|
| `key` | string (camelCase) | Canonical id. Must equal the file stem: `agents/<key>.meta.json`. Used as the workflow node `key`, the registry key, and across run-config. |
| `displayName` | string | Human label shown on the palette pill and node. |
| `description` | string | Short blurb (palette tooltip / node subtitle). |
| `color` | enum | One of `green, peach, red, blue, violet, amber` — maps to the CSS color tokens; tints the palette dot/pill. |
| `icon` | string | **Inline SVG inner markup** for a `viewBox="0 0 24 24"` glyph (paths only, no wrapping `<svg>`). Copy a glyph from the mockup `ICON` map. |
| `agentFile` | string \| null | Prompt filename in `agents/` (e.g. `"maestro-manual-web-ui-testing.md"`). `null` for a palette-only agent (no runner invoked). |
| `runnerType` | `"producer"` \| `"verifier"` | Selects the execution function from the runner registry (Step 3). |
| `loopSource` | boolean | `true` if this agent may **originate a feedback loop** (it emits a blocking/non-blocking verdict). Only meaningful for `verifier`. See Step 6. |
| `connectsTo` | `"*"` | Which agents it can wire to in the Composer. `"*"` (everything) for now. |
| `order` | number | Palette render order; `loadAgentRegistry` returns the registry **sorted by `order`**. |

**Complete worked example — the shipped `agents/manualWebUiTesting.meta.json`:**

```json
{
  "key": "manualWebUiTesting",
  "displayName": "Manual web UI testing",
  "description": "run manual cases via Playwright",
  "color": "violet",
  "icon": "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M10 8.5l5 3.5-5 3.5V8.5Z\" fill=\"currentColor\" stroke=\"none\"/>",
  "agentFile": "maestro-manual-web-ui-testing.md",
  "runnerType": "verifier",
  "loopSource": true,
  "connectsTo": "*",
  "order": 6
}
```

That single file is enough for *Manual web UI testing* to: appear last in the
palette (`order: 6`), render a violet pill with the play-in-circle glyph, run via the
`verifier` runner, and be eligible as a feedback-loop origin (`loopSource: true`)
— with **zero** engine edits.

For comparison, the producer sibling `agents/manualTestsChecklist.meta.json`
uses `"runnerType": "producer"`, `"loopSource": false`, `"color": "blue"`,
`"order": 5` — it drafts the checklist artifact and never originates a loop.

---

## Step 3 — Choose a `runnerType` (or add a runner)

A `runnerType` names an entry in the runner registry
(`src/core/runners.mjs`): `runners = { producer, verifier }`. Each runner is
`async (ctx) => RunnerResult`. **Almost every new agent reuses one of the two —
no engine code needed.**

- **`producer`** — generates artifacts/code. The Plan, Refine, Implement, and
  **Manual Tests Checklist** agents are producers. The runner carries the
  planner/refiner/implementer specializations via mode flags on `ctx`.
- **`verifier`** — emits the `protocol.mjs` review verdict (`issues[]` +
  `summary`); eligible as a `loopSource`. The Review and **Manual web UI
  testing** agents are verifiers.

The runner receives a `ctx` that extends the orchestrator's phase context with
`{ nodeId, key, agentPrompt, stepIndex, cycle, claudeOpts:{ model, effort, … } }`,
and returns:

```js
// RunnerResult
{
  status: "ok" | "blocked",      // "blocked" when a verifier found critical/major issues
  issues?: [{ severity, title, detail, location }],
  summary?: string,
  review?: object,               // the raw protocol.mjs verdict (verifiers + the refiner)
  // plus any output paths the dispatcher folds back into shared run IO, e.g.
  // planPath / outPlanPath / checklistPath / reviewMdPath (see _afterNode)
}
```

> Cost/duration are not part of this result — the orchestrator attributes them
> from the agent's runtime `'result'` events, tagged per `nodeId` (CONV-4).

**Only add a runner if you need genuinely new behavior** the two types can't
express. The shape to add:

```js
// src/core/runners.mjs
export const runners = {
  producer,                       // existing
  verifier,                       // existing

  // New runner: a name you set as `"runnerType": "myKind"` in a meta sidecar.
  async myKind(ctx) {
    // ctx: { nodeId, key, agentPrompt, stepIndex, cycle, claudeOpts, ...phaseCtx }
    // Drive the agent (e.g. via the same claude-runner path the others use),
    // then return the contracted RunnerResult.
    return {
      status: 'ok',               // or 'blocked' to gate a loop (requires loopSource:true on the node)
      summary: 'what happened',
      // issues: [...], cost, artifacts
    };
  },
};
```

Then set `"runnerType": "myKind"` in your meta. The dispatcher calls
`runners[node.runnerType](ctx)` — an unknown `runnerType` is rejected by the
workflow validator before a run starts, so wire the registry entry first.

---

## Step 4 — It appears in the Composer automatically

There is no registration list to edit. At startup the registry is built by:

```js
// src/core/agent-registry.mjs
loadAgentRegistry(agentsDir)   // scans agents/*.meta.json -> { [key]: AgentMeta }, sorted by .order
registryToSteps(registry)      // -> [{ key, label }] (the AGENT_STEPS-shaped list)
```

Because the **Composer palette is built from this registry** (served via
`GET /api/agents`), your new agent shows up as a draggable pill the moment its
`agents/<key>.meta.json` exists — positioned by `order`, tinted by `color`,
glyphed by `icon`. The legacy fixed `AGENT_STEPS` is now *derived* from the
registry via `registryToSteps`, so per-stage model/effort pickers pick the agent
up too. No `app.js`, `index.html`, or `config.mjs` edit is required to surface a
new agent.

---

## Step 5 — How topology + run-config resolve at run time

Two layers combine when a pipeline runs. They are deliberately separate so a
workflow can be shared while each project keeps its own model/cost choices:

1. **Workflow template — topology only, global.** Stored at
   `~/.maestro/workflows/<id>.json`:

   ```json
   {
     "id": "wf_quickfix", "name": "Quick Fix", "version": 1,
     "steps": [
       [ { "id": "s0_0", "key": "planner" } ],
       [ { "id": "s1_0", "key": "implementer" } ],
       [ { "id": "s2_0", "key": "reviewer" } ]
     ],
     "feedbacks": [ { "id": "fb_0", "from": "s2_0", "to": "s1_0" } ],
     "createdAt": "…", "updatedAt": "…"
   }
   ```

   `steps` outer array = **sequential** order; an inner array with >1 node is a
   **parallel** group (run concurrently). Each node `id` is a unique *instance*
   id within the workflow (e.g. `s0_0`) — feedbacks and run-config reference
   these ids, not the role `key`, so the same agent can appear in several steps
   or cycles unambiguously. The built-in `DEFAULT_WORKFLOW` (id `wf_default`) is
   the current `Plan → Refine → Implement → Review`.

2. **Run-config — model/effort/cycles, per-project.** Stored in
   `<projectDir>/.maestro/config.json` (the legacy `steps`/`customModels` keys
   are untouched):

   ```json
   {
     "steps": { "…legacy per-role…": {} },
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

**At run time** `resolveWorkflow(projectDir, workflowId, registry)` loads the
template (or the built-in default), looks each node's `key` up in the registry
to attach `runnerType`, `agentFile`, the prompt body, `tools`, and `loopSource`,
then merges the per-project run-config (via
`resolveRunConfig(projectDir, workflowId)`) to attach `model`/`effort` per node
and `maxCycles` per feedback — producing the **ExecutablePlan**:

```js
{
  id, name,
  steps: [ [ { nodeId, key, runnerType, agentFile, agentPrompt, model, effort, tools, loopSource } ] ],
  feedbacks: [ { id, from, to, maxCycles, gate: "hasBlocking" } ]
}
```

The dispatcher walks `plan.steps` in order: a single-node step runs
`runners[node.runnerType](ctx)` directly; a multi-node step runs its nodes with
`Promise.all` (parallel). Every emitted engine event is tagged with `{ nodeId,
stepIndex, cycle }` so parallel/looped output stays attributable.

**Net effect for a new agent:** you only authored two files in `agents/`. Its
model/effort come from whatever the user picks in *New Pipeline* (keyed by node
id), and its place in the flow comes from whatever workflow includes it. Nothing
in the agent is hardcoded to a position.

---

## Step 6 — `loopSource` semantics (feedback loops)

`loopSource: true` marks an agent that can **originate a feedback loop**. It is
only meaningful for a `verifier` (a producer has no verdict to gate on).

A feedback edge `{ id, from, to }` points **backward**: `from` is a later step
(where the `loopSource` node lives) and `to` is an earlier step to re-run. At run
time, when a `loopSource` node returns `status: "blocked"` (i.e. its verdict has
`critical`/`major` issues per `protocol.mjs` `hasBlocking`) **and** that loop's
`cycle < maxCycles`, the dispatcher moves the execution pointer back to the
loop's `to` step and re-runs forward, incrementing that loop's `cycle`. When
`maxCycles` is exhausted, it **gates to the user** (continue / stop) exactly as
the original `_refineLoop`/`_reviewLoop` did (`src/core/orchestrator.mjs`).

This is how the default workflow reproduces today's two loops:

- **Refine loop** — `refiner` (`loopSource`) gating back to `Plan`.
- **Review loop** — `reviewer` (`loopSource`) gating back to `Implement`.

The two new agents follow the same rule:

- **Manual Tests Checklist** — `loopSource: false`; it produces an artifact and
  never gates.
- **Manual web UI testing** — `loopSource: true`; on a blocking verdict it can
  drive a feedback loop back to *Implementation*.

The workflow validator (`src/core/workflow-validator.mjs`) enforces that a
feedback's `to` step precedes its `from` step, that ids are unique, and that
every referenced node exists — so a malformed loop is rejected before a run
starts, and `maxCycles ≥ 1` bounds every cycle.

---

## Verify (the pairing guard)

Adding an agent means **two** files. This invariant — every prompt has a sibling
meta that claims it — is guarded two ways. Run both before you commit:

```bash
node --test test/agents-meta.test.mjs
```

…and the offline shell guard (CI-friendly; exits non-zero on the first
unpaired prompt):

```bash
for f in agents/*.md; do
  grep -lq "\"agentFile\"[[:space:]]*:[[:space:]]*\"$(basename "$f")\"" agents/*.meta.json \
    || { echo "UNPAIRED: $f has no agents/*.meta.json with agentFile \"$(basename "$f")\""; exit 1; }
done; echo "OK: every agents/*.md is paired with a meta sidecar"
```

Then run the full offline smoke to confirm the engine still drives the default
workflow end to end:

```bash
MAESTRO_MOCK=1 npm run smoke
```
