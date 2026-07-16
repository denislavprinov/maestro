# BEVUP content generation as a maestro workflow

**Date:** 2026-06-06
**Status:** Approved design — ready for implementation plan
**Repos:** `maestro` (engine, this repo) + `../bevup-os` (content skills plugin)

---

## 1. Goal

Run the BEVUP content-creation chain (ideate → copy + visual brief → rubric review →
render) through maestro's deterministic **Plan→Refine→Implement→Review** machinery,
reusing its loop/gate/store/streaming-UI as-is. Output: an Instagram post package
(`concept.md`, `copy.md`, `brief.md`, `*.png`) produced under quality-gate control,
landing in the bevup-os repo for human go/no-go.

Maestro stays a **generic engine**. BEVUP contributes a saved workflow + four content
agents; the engine's software pipeline is untouched and continues to work byte-identically.

## 2. Background — how maestro works (verified)

- A **workflow** is pure topology: `steps: [[{id,key}]]` + `feedbacks: [{id,from,to}]`.
  Saved as JSON under `~/.maestro/workflows/<id>.json`. The built-in `wf_default` is
  Plan→Refine→Implement→Review.
- Each `key` resolves to `agents/<key>.md` (system prompt) + `agents/<key>.meta.json`
  (channels, `runnerType`, `connectsTo`). The registry is **data-driven** — dropping the
  two files registers an agent with no registry edit (`agent-registry.mjs`).
- Dispatch is by **`runnerType`** (`producer` | `verifier`), not by key — the runners
  are generic (`orchestrator.mjs:976`, `this._runners[node.runnerType]`).
- Headless agents already carry the **`Skill`** tool in their allowlist (`phases.mjs`
  `READ_WRITE_TOOLS`/`IMPLEMENTER_TOOLS`), so an agent can invoke a bevup-os Skill directly.
- **Channels are a closed set:** `['userPrompt','plan','review','checklist','code','workspace']`
  with hardcoded switches in `channels.mjs` (`allocate` / `publish` / `legacyRoleFields`).
  `code` is the **git worktree** itself; the implement→review loop diffs it.
- **`agentsDir` is effectively fixed** to `maestro/agents/`: `orchestrator.mjs` calls
  `loadAgentRegistry()` and `resolveWorkflow(...,undefined,...)` with no override
  (lines 255/260). New agents must live in `maestro/agents/`.
- **Clarify is hardwired to the `planner` key** (`_clarify(plannerNodeOf(plan))`,
  `orchestrator.mjs:382`). A non-planner entry agent does not trigger clarify.

## 3. Key design decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Maestro is the **engine**; BEVUP ships agents + a workflow, not engine forks | Keep software pipeline intact; one engine, two domains |
| 2 | **Reuse** `plan`/`code`/`review` channels — no new channel ids | Avoids touching `CHANNEL_IDS` + 3 switches; content maps cleanly onto them |
| 3 | **Run target = the bevup-os repo** | `code` worktree becomes bevup-os, so posts commit there, `wiki/` brand knowledge is readable, plugin Skills are on the project Skill path |
| 4 | **Fused produce agent** (copy + brief in one step) | Fewer steps, single review target; faithful enough for v1 |
| 5 | Content agents live **directly in `maestro/agents/`** | `agentsDir` is fixed to it; no install indirection |
| 6 | **No interactive clarify** in v1 — seed arrives in the prompt | Clarify is planner-keyed; generalizing it is out of scope |

## 4. Architecture

### 4.1 Channel mapping (semantic overload of existing channels)

| Content artifact | Maestro channel | Notes |
|------------------|-----------------|-------|
| Chosen concept (`concept.md`) | `plan` | Allocated via `planPath()`, cycle-aware |
| `copy.md` + `brief.md` (worktree files) | `code` | `code` = worktree; agent writes into `posts/<date>/` |
| Rubric verdict (md + maestro JSON) | `review` | `bevupReview` falls into the `impl-review` filename branch in `channels.mjs` — works unmodified |
| Rendered `*.png` (worktree files) | `code` | Render writes into the same worktree dir |

### 4.2 Topology — `wf_bevup_content`

```
steps:
  [ {id:s0_0, key:bevupIdeate}  ]   # producer:  userPrompt -> plan   (concept)
  [ {id:s1_0, key:bevupProduce} ]   # producer:  plan       -> code   (copy.md + brief.md)
  [ {id:s2_0, key:bevupReview}  ]   # verifier:  plan,code  -> review (rubric verdict)
  [ {id:s3_0, key:bevupRender}  ]   # producer:  code       -> code   (*.png)
feedbacks:
  [ {id:fb_content_review, from:s2_0, to:s1_0} ]   # gate hasBlocking: blocking rubric -> regenerate
```

On a clear rubric (no blocking) the run advances linearly s2→s3, so image generation
runs only on approved copy.

### 4.3 Agents (4 new `.md` + `.meta.json` pairs in `maestro/agents/`)

| Key | runnerType | consumes | produces | connectsTo | Wraps Skill(s) | Writes |
|-----|-----------|----------|----------|-----------|----------------|--------|
| `bevupIdeate` | producer | `userPrompt` | `plan` | `[bevupProduce]` | `bevup-ideate` | concept → `{planFilePath}` |
| `bevupProduce` | producer | `plan`,`review`* | `code` | `[bevupReview]` | `bevup-copywriter` + `bevup-visual-brief` | `copy.md`, `brief.md` in worktree |
| `bevupReview` | verifier | `plan`,`code` | `review` | `[bevupProduce,bevupRender]` | `bevup-reviewer` | review md + maestro JSON |
| `bevupRender` | producer | `code` | `code` | `[]` | `bevup-graphic-generator` | `*.png` in worktree |

`*` `review` is an **optional** consume on `bevupProduce` — present only on a feedback
re-entry (fix mode), absent on the first pass.

Each agent prompt instructs the headless `claude -p` to (1) read the task input from the
bound path, (2) invoke the named bevup-os Skill, (3) write the result to the maestro
contracted artifact path so `protocol.mjs` reads it back.

### 4.4 The one non-trivial mapping — review adapter

`bevup-reviewer` is rubric-driven (scores against `wiki/_review/*.md`). The `bevupReview`
agent prompt must translate its rubric output into maestro's review JSON shape
(`critical` / `major` / `minor` / `suggestion` arrays) so the `hasBlocking` gate drives
the loop. Mapping: rubric hard-fails → `critical`; voice/brand violations → `major`;
polish notes → `minor`/`suggestion`. The verifier runner already emits this JSON; the
agent only has to populate it from the rubric verdict.

### 4.5 The one engine change — `legacyRoleFields`

`channels.mjs` `legacyRoleFields(node, ...)` switches on `node.key` to name the fields the
runners read. New keys hit `default → {cycle}`, which starves a producer of its input
path. Add four cases mirroring the existing roles (≈15 lines, isolated):

- `bevupIdeate` → planner-shape output: `{ planFilePath: outputs.plan?.path, baseName, answers: inputs.userPrompt?.answers || [] }`
- `bevupProduce` → implementer-shape: `{ planPath: inputs.plan?.path, reviewPath: inputs.review?.mdPath, mode: inputs.review?.mdPath ? 'fix' : 'produce', cycle }`
- `bevupReview` → reviewer-shape: `{ planPath: inputs.plan?.path, reviewMdPath: outputs.review?.mdPath, reviewJsonPath: outputs.review?.jsonPath, cycle }`
- `bevupRender` → `{ planPath: inputs.plan?.path, baseName, cycle }`

No other engine file changes: `allocate`/`publish` already handle `plan`/`code`/`review`;
the registry reads channels from the sidecars; `entrySeedChannels` seeds nothing (entry
consumes `userPrompt`, which is always present).

## 5. Runtime / prerequisites

- bevup-os plugin Skills resolvable by headless `claude -p` in the project (plugin
  installed or on the project Skill path).
- `claude` CLI + maestro on `PATH`.
- `wf_bevup_content.json` placed in `~/.maestro/workflows/`.
- Invocation: `npm run cli -- --project /Users/bulibas/dev/repo/bevup-os --workflow wf_bevup_content --prompt "<seed/topic>"` (confirm the `--workflow` flag name during implementation).

## 6. Testing

- **Mock run** (`MAESTRO_MOCK=1`): the four agents carry MOCK markers so the full topology
  + the review→produce loop + gate run without spawning `claude`. Asserts artifact paths,
  channel wiring, and loop/gate behavior.
- **`legacyRoleFields` unit test**: each new key returns the expected field shape.
- **Validator test**: `wf_bevup_content` passes `workflow-validator` (connectsTo legality,
  entry-seed reachability).
- **One live smoke run** against bevup-os with a fixed seed; eyeball `concept/copy/brief`
  and one render.

## 7. Out of scope (v1)

Interactive seed-clarify (generalizing clarify off the planner key); dedicated content
channels; split copy/brief steps; calendar scheduling + Zernio posting
(`bevup-calendar-queue` / `bevup-posting-manager` consume this pipeline's output
downstream); reels/stories/push formats.

## 8. Risks / open questions

- **Skill resolution in headless runs** — verify `claude -p` finds plugin Skills in the
  project context; if not, install bevup-os Skills into the project `.claude/skills/`.
- **`--workflow` selection path** — confirm the CLI/skill expose workflow selection by id
  (UI does; CLI flag to be verified).
- **Render cost/time** — image generation is the slow/expensive step; it runs once,
  post-approval, by topology design.
- **Rubric→JSON fidelity** — the adapter is prompt-level; the live smoke run validates
  that blocking rubric failures actually trip the gate.
