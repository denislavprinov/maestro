# Maestro — ARCHITECTURE (single source of truth)

This document is the authoritative contract every builder codes against. The exact
export signatures, event names, and on-disk JSON/Markdown file contracts below are
binding. Do not change a signature without updating this file first.

**Product:** a deterministic multi-agent pipeline that drives Claude Code (headless)
through **Plan -> Refine -> Implement -> Review** for a software task, exposed via a
CLI, an installable `/maestro` skill, and a web UI.

**Runtime:** plain Node.js ESM (`.mjs`), Node `>=18`. Minimal deps: `express` + `ws`
only; everything else uses Node built-ins. Frontend is vanilla HTML/CSS/JS (no
framework, no build step).

**CWD for all file writes during development:** `/Users/denislavprinov/Develop/orchestrator`

---

## 1. FILE LAYOUT (authoritative)

```
package.json                         type:module; scripts: start(ui), cli, install:agents, smoke; deps express+ws
README.md
.gitignore                           node_modules, examples/sandbox, ai-artifacts/pipelines/*/, *.log
docs/ARCHITECTURE.md                 this file

src/core/protocol.mjs                JSON contracts + validators shared by agents and orchestrator
src/core/artifacts.mjs               paths, slugify, date(DD-MM-YY), pipeline create/persist/audit
src/core/preflight.mjs               detectTools(projectDir) for graphify / code-review-graph
src/core/claude-runner.mjs           spawn claude headless, stream events, AbortSignal kill, MOCK mode
src/core/phases.mjs                  per-phase agent runners (planner clarify+plan, refiner, implementer, reviewer)
src/core/orchestrator.mjs            EventEmitter state machine sequencing all phases + loops + gates

src/cli/maestro.mjs              CLI entry: args, terminal rendering, interactive Q&A + gates
scripts/install.mjs                  copy agents/*.md + skills/maestro into a target project .claude/

agents/maestro-planner.md
agents/maestro-plan-refiner.md
agents/maestro-implementer.md
agents/maestro-code-reviewer.md
skills/maestro/SKILL.md

ui/server.mjs                        express static + REST + WebSocket, drives core
ui/public/index.html
ui/public/app.js
ui/public/style.css

ai-artifacts/plans/.gitkeep
ai-artifacts/reviews/.gitkeep
ai-artifacts/pipelines/.gitkeep
```

### Ownership (who writes which files)

- **Architect (this pass):** `package.json`, `.gitignore`, `README.md`,
  `docs/ARCHITECTURE.md`, the `.gitkeep` scaffolding, and **signature stubs** for the
  six `src/core/*.mjs` files. These stubs lock the interface; their bodies throw
  `Error("not implemented")` until the owning builder fills them in.
- **Core builders:** fill the bodies of `src/core/*.mjs` (must match signatures here).
- **CLI builder:** `src/cli/maestro.mjs`.
- **Install builder:** `scripts/install.mjs`.
- **Agents builder:** `agents/*.md`, `skills/maestro/SKILL.md`.
- **UI builder:** `ui/server.mjs`, `ui/public/*`.

---

## 2. PIPELINE OVERVIEW

Phases, in order, driven by the deterministic orchestrator state machine:

1. **preflight** — detect optional tooling (`graphify`, `code-review-graph`); build a
   `toolInstruction` string injected into agent system prompts. If both are installed,
   **always use graphify**.
2. **git checkpoint** — ensure the target project is a git repo (`git init` + initial
   commit if none); record a checkpoint ref so the reviewer can diff against it.
3. **plan (planner)** — clarify loop then plan.
   - **clarify loop:** planner asks conceptual questions whenever it would otherwise
     assume. Each question has exactly **3 options + a free-text field**. Re-run clarify
     until no questions remain. Persist the Q&A.
   - **plan:** planner writes the plan markdown (must include code snippets) and appends
     a `## Clarifications (Q&A)` section with what was asked and answered.
4. **refine loop (plan-refiner)** — `cycle++`; refiner reviews the latest plan
   (including its code snippets), writes `-vN`, and emits a `refine-review-cycleN.json`. If no
   blocking issues remain, stop. If `cycle > maxRefineCycles`, emit a **gate** question
   with the remaining blocking issues and await user decision (`continue` ends the loop,
   `another` runs one more cycle). Escalates indefinitely.
5. **implement (implementer, mode `implement`)** — follow the latest plan with no
   deviation (TDD: red-green-refactor).
6. **review loop (code-reviewer + implementer fix)** — reviewer reviews the git diff,
   writes review markdown + `impl-review-cycleN.json`. If no blocking issues remain, stop.
   Otherwise run implementer in `fix` mode pointed at the review, then review again. Cap
   at `maxReviewCycles`; on overflow emit the same kind of **gate** question.
7. **done.**

"Blocking" = any issue whose severity is `critical` or `major`. Loops terminate when
only `minor`/`suggestion` issues remain.

---

## 3. CORE CONTRACTS (exact — all builders code against these)

### 3.1 `src/core/protocol.mjs`

JSON contracts + validators shared by agents and orchestrator.

**Exports:**

- `SEVERITIES = ["critical","major","minor","suggestion"]`
  - The canonical, ordered severity list. Index order = descending severity.

- `readClarify(pipelineDir) -> { questions: [ { id, question, options: [s,s,s], allowFreeText:true } ] } | { questions: [] }`
  - Reads `clarify.json` from `pipelineDir`. **Missing file => `{ questions: [] }`.**
  - Each question: `id` (string), `question` (string), `options` (array of exactly 3
    strings), `allowFreeText` (boolean, `true`).

- `writeClarifyAnswers(pipelineDir, answers) -> void`
  - Writes `clarify-answers.json` to `pipelineDir` with shape:
    `{ answers: [ { id, question, choice } ] }`.
  - `choice` is the user's selected option text OR their free-text input.

- `readReview(jsonPath) -> { issues: [ { severity, title, detail, location } ], summary }`
  - Reads and parses a review JSON file at an absolute `jsonPath`.
  - Each issue: `severity` (one of `SEVERITIES`), `title` (string), `detail` (string),
    `location` (string, e.g. `file:line` or free text).
  - `summary` (string).

- `hasBlocking(review) -> boolean`
  - `true` if any issue in `review.issues` has severity `critical` or `major`.

- `blockingIssues(review) -> issues[]`
  - Returns `review.issues` filtered to `critical`/`major` only.

- `safeParseJson(text) -> object | null`
  - Tolerant parse: strips ```` ```json ```` / ```` ``` ```` code fences, finds the
    first balanced `{ ... }` object, and `JSON.parse`s it. Returns `null` on failure.
    Never throws.

### 3.2 `src/core/artifacts.mjs`

Paths, slugify, date, pipeline create/persist/audit.

**Exports:**

- `slugify(s) -> string`
  - kebab-case slug: lowercase, non-alphanumerics collapsed to single `-`, trimmed of
    leading/trailing `-`.

- `today() -> "DD-MM-YY"`
  - Zero-padded day-month-year from the system clock at runtime (ordinary runtime code).

- `artifactPaths(projectDir) -> { root, plans, reviews, pipelines }`
  - All **absolute** paths under `<projectDir>/ai-artifacts`:
    - `root = <projectDir>/ai-artifacts`
    - `plans = <root>/plans`
    - `reviews = <root>/reviews`
    - `pipelines = <root>/pipelines`

- `ensureArtifactDirs(projectDir) -> void`
  - `mkdir -p` all four paths from `artifactPaths`.

- `planPath(projectDir, baseName, version) -> string`
  - `<plans>/<DD-MM-YY>-<baseName>[-vN].md`.
  - **`version === 1` => no suffix**; `version === 2` => `-v2`; etc. The date prefix is
    produced by `today()`.
  - NOTE: callers must keep `baseName` stable across versions so all versions of one
    plan share the `<DD-MM-YY>-<baseName>` base.

- `reviewPath(projectDir, baseName) -> string`
  - `<reviews>/<DD-MM-YY>-<baseName>-impl-review.md`.

- `createPipeline(projectDir, { prompt, promptFile, extras, title }) -> { id, dir, promptText }`
  - `dir = <pipelines>/<DD-MM-YY>-<slug>-<id>/` where `<slug>` derives from `title` (or
    the prompt) and `id` is a short unique id.
  - Side effects:
    - writes `prompt.md` into `dir` (from `prompt` text, or copies the `promptFile`
      markdown).
    - copies each path in `extras` into `dir/extras/`.
    - writes `pipeline.md` (audit header — see §5.5) and `state.json` (see §5.4).
  - Returns `{ id, dir, promptText }` where `promptText` is the resolved prompt body.

- `appendAudit(pipelineDir, markdownLine) -> void`
  - Appends a single markdown line (timestamped by convention) to `pipeline.md`.

- `writeState(pipelineDir, stateObj) -> void`
  - Serializes `stateObj` to `state.json` in `pipelineDir`.

- `listPipelines(projectDir) -> [ { id, dir, title, status, startedAt, mtime } ]`
  - Enumerates pipeline dirs under `<pipelines>`, reading each `state.json`. Sorted
    **newest first** (by `mtime`/`startedAt`).

- `readPipeline(projectDir, id) -> { state, auditMarkdown }`
  - Loads the pipeline's `state.json` (parsed -> `state`) and `pipeline.md` raw text
    (-> `auditMarkdown`).

### 3.3 `src/core/preflight.mjs`

Optional-tool detection. **All shell/env probes must fail safe (failure => `false`,
never throw).**

**Exports:**

- `detectTools(projectDir) -> { graphify:boolean, codeReviewGraph:boolean, tool: "graphify"|"code-review-graph"|null, instruction:string }`
  - **graphify detection — ANY true:**
    - `which graphify` succeeds, OR
    - `~/.claude/skills/graphify/SKILL.md` exists, OR
    - `<projectDir>/graphify-out` exists, OR
    - `pipx list` / `pip show graphify` mentions `graphify`.
  - **code-review-graph detection — ANY true:**
    - `which code-review-graph` succeeds, OR
    - `pipx list` / `pip show code-review-graph` mentions it, OR
    - a cloned dir named `code-review-graph` on a PATH-ish location.
  - **rule:** `tool = graphify ? "graphify" : codeReviewGraph ? "code-review-graph" : null`
    (**both installed => graphify**).
  - `instruction` = human-readable text injected into agent system prompts telling them
    to use the chosen tool, or `""` if none.

### 3.4 `src/core/claude-runner.mjs`

Spawn Claude headless, stream events, AbortSignal kill, MOCK mode.

**Exports:**

- `runClaude({ cwd, systemPrompt, prompt, allowedTools, permissionMode, model, onEvent, signal }) -> Promise<{ text, exitCode }>`
  - **Spawn command:**
    ```
    claude -p <prompt> --append-system-prompt <systemPrompt> \
      --output-format stream-json --verbose \
      --permission-mode <mode> [--model <m>] [--allowedTools a,b,c]
    ```
  - Reads stdout **line-by-line**, `JSON.parse` each line, calls
    `onEvent({ type, raw, text? })` for assistant text deltas + tool events, and
    accumulates the final result text (returned as `text`).
  - Honors `signal` (an `AbortSignal`): on abort, `child.kill()`.
  - On non-zero exit, **reject** with `stderr`.
  - `allowedTools` is an array; serialized to a comma-joined `--allowedTools` value.
    Omit the flag when empty/undefined.

  **MOCK MODE** — if `process.env.MAESTRO_MOCK` is truthy, **do not spawn `claude`**.
  Instead emit a few canned `onEvent` log lines and perform role-appropriate side
  effects so the whole pipeline runs offline. The role + target paths are passed via
  the prompt/systemPrompt as simple markers the phases layer includes (e.g. a line
  `MOCK_ROLE: planner-clarify` and `MOCK_OUT: <path>`). Mock must be deterministic.

  Role behaviors (markers, parsed from prompt/systemPrompt):
  - `planner-clarify` => write `clarify.json` with **ONE** sample question (3 options +
    `allowFreeText:true`).
  - `planner-plan` => write the plan markdown file at the path given in the prompt,
    including a code snippet and a `## Clarifications (Q&A)` section.
  - `refiner` => write the `-vN` plan file and a `refine-review-cycleN.json` whose
    blocking-issue count **decreases** with cycle (cycle 1: 1 major; cycle >= 2: only
    minor) so the loop terminates.
  - `implementer` => create/append a small file in `cwd` (e.g. `src/feature.mjs`) and a
    test. New files are staged intent-to-add by the orchestrator after each implement
    pass, so the reviewer's `git diff` against the checkpoint is non-empty.
  - `reviewer` => write the review markdown + `impl-review-cycleN.json` (cycle 1: 1 major;
    cycle >= 2: only suggestion).

  Marker convention (the phases layer emits these; the mock parses them):
  - `MOCK_ROLE: <planner-clarify|planner-plan|refiner|implementer|reviewer>`
  - `MOCK_OUT: <absolute path>` — primary output file (plan md / review md / clarify.json)
  - `MOCK_JSON: <absolute path>` — review JSON path (refiner/reviewer)
  - `MOCK_CYCLE: <n>` — current loop cycle (refiner/reviewer)

### 3.5 `src/core/phases.mjs`

Per-phase agent runners. Each:
- uses `runClaude` + the matching `agents/*.md` body as the **appended system prompt**,
  **prepended** with `toolInstruction`,
- uses `protocol` helpers for the JSON contracts,
- accepts a common context object plus a per-phase options object.

**Common context (first arg) — shape:**
`{ projectDir, pipelineDir, taskPrompt, toolInstruction, agentPrompts, onEvent, signal, claudeOpts }`
- `agentPrompts` — map of agent name => system-prompt body (loaded from `agents/*.md`).
- `claudeOpts` — `{ permissionMode, model, mock? }` passed through to `runClaude`.

**allowedTools per role:**
- planner / refiner / reviewer: `Read, Write, Edit, Bash, Grep, Glob`
- implementer: same + full edit capability.

**Exports** (each is `async (ctx, opts) -> result`):

- `runPlannerClarify(ctx) -> { questions }`
  - Writes `clarify.json`; returns `{ questions }` (the parsed clarify object's
    `questions` array).

- `runPlannerPlan(ctx, { answers, planFilePath, baseName }) -> { planPath }`
  - Writes the plan to `planFilePath` (must include code snippets + a
    `## Clarifications (Q&A)` section built from `answers`). Returns
    `{ planPath }` (the absolute path written).

- `runRefiner(ctx, { inPlanPath, outPlanPath, cycle, reviewJsonPath }) -> { outPlanPath, review }`
  - Reads `inPlanPath`, writes refined plan to `outPlanPath`, writes the refiner review
    JSON (`refine-review-cycle<cycle>.json`) to `reviewJsonPath`. Returns
    `{ outPlanPath, review }` where `review` is the parsed review object (`readReview` shape).

- `runImplementer(ctx, { planPath, reviewPath?, mode }) -> { summary }`
  - `mode` is `"implement"` or `"fix"`. In `fix` mode, `reviewPath` points at the
    review to address. Uses TDD. Returns `{ summary }` (text summary of what changed).

- `runReviewer(ctx, { planPath, reviewMdPath, reviewJsonPath, cycle }) -> { review }`
  - Reviews the git diff, writes review markdown to `reviewMdPath` and the reviewer
    review JSON (`impl-review-cycle<cycle>.json`) to `reviewJsonPath`. Returns `{ review }` (parsed).

### 3.6 `src/core/orchestrator.mjs`

EventEmitter state machine sequencing all phases + loops + gates.

**Exports:**

- `createOrchestrator(opts) -> { run(), answer(id, payload), stop(), getState(), on(event, cb), ... }`
  (EventEmitter-like; at minimum supports `on`/`emit` plus the four methods above.)

**`opts` shape:**
```
{
  projectDir,
  prompt?,                 // task prompt text
  promptFile?,             // OR path to a markdown file used as the prompt
  extras?,                 // optional extra file paths copied into the pipeline
  title?,
  maxRefineCycles = 5,
  maxReviewCycles = 5,
  claude: { bin?, permissionMode = "acceptEdits", model?, mock? },
  agentsDir,               // dir containing agents/*.md
  pipelineId?,
  auto?                    // non-interactive: auto-answer clarify+gates
}
```

**Methods:**
- `run() -> Promise<...>` — executes the full sequence (below).
- `answer(id, payload) -> void` — resolves a pending `question` event.
  - clarify payload: `{ answers: [ { id, choice } ] }`
  - gate payload: `{ decision: "continue" | "another" }`
- `stop() -> void` — aborts via an `AbortController` and marks state `stopped`.
- `getState() -> object` — current full state snapshot.

**Sequence performed by `run()`:**
1. **preflight** -> `detectTools(projectDir)`.
2. **ensure target git repo** — `git init` + initial commit if none; record checkpoint
   ref (used as the diff base for review).
3. **planner clarify loop** — emit `question` with `kind:"clarify"`; on answers, persist
   Q&A and re-run clarify until `questions` is empty.
4. **planner plan** — write the plan (base name derived once; version 1).
5. **refine loop** — `cycle++`; `runRefiner`; if `!hasBlocking(review)` => stop the
   loop; if `cycle > maxRefineCycles`, emit `question` with `kind:"gate"` + the
   `blockingIssues`, and await the user: `"continue"` ends the loop, `"another"`
   continues.
6. **implementer (mode `implement`)**.
7. **review loop** — `runReviewer`; if `!hasBlocking` stop; else `runImplementer(mode
   "fix")`; if `cycle > maxReviewCycles` emit a `gate` (same semantics as refine).
8. **done.**

**Emitted events (names + payloads are binding):**
- `phase` — `{ phase, cycle, status }`
- `log` — `{ source, level, text, ts }`
- `question` — `{ id, kind, questions?, issues? }`
  - `kind:"clarify"` carries `questions`; `kind:"gate"` carries `issues`
    (the open critical/major issues).
- `artifact` — `{ kind, path }`
- `state` — full state snapshot (same shape as `getState()`)
- `done` — `{ status, pipelineDir }`
- `error` — `{ message }`

**Auto mode (`opts.auto`):** non-interactive auto-answer — clarify => first option;
gate => `continue`.

---

## 4. CLI / INSTALL / UI CONTRACTS (downstream consumers)

These are not core stubs, but their interface to core is fixed here so builders agree.

### 4.1 `src/cli/maestro.mjs`
Flags:
- `--project <dir>` (default cwd)
- `--prompt <text>` | `--file <md>`
- `--title <text>`
- `--ui` (launch `ui/server` then exit)
- `--max-refine <N>`
- `--max-review <N>`
- `--model <m>`
- `--permission-mode <m>`
- `--mock`
- `--yes` / `--non-interactive` (sets `auto`)
- `--install <targetDir>` (run `scripts/install`)

Behavior: subscribes to core events; renders phases + streams logs to the terminal; on
a `question` event uses `readline` to show 3 options + free-text (clarify) or the two
gate choices + issue list, then calls `answer()`. On `done`, prints the pipeline dir.

### 4.2 `scripts/install.mjs`
`node scripts/install.mjs <targetDir> [--force]` — copies `agents/*.md` into
`<targetDir>/.claude/agents/` and `skills/maestro/` into
`<targetDir>/.claude/skills/maestro/`. Prints a next-step hint
(`/maestro <prompt>`).

### 4.3 `ui/server.mjs` (express + ws, `PORT || 4317`)
- Serves `ui/public`.
- REST:
  - `POST /api/run` `{ projectDir, prompt|promptMarkdown, title, maxRefine, maxReview, mock }` -> starts a core run, returns `{ runId }`.
  - `POST /api/answer` `{ runId, id, payload }`.
  - `POST /api/stop` `{ runId }`.
  - `GET /api/runs?projectDir` -> history via `listPipelines`.
  - `GET /api/runs/:id?projectDir` -> `readPipeline`.
  - `POST /api/install` `{ projectDir }` -> runs install into `projectDir`.
- WebSocket at `/ws` broadcasts core events tagged with `runId`.
- Holds active runs in a `Map`.

### 4.4 `ui/public/*`
Single page. Sections: (1) New pipeline form (project folder input, radio
prompt-vs-markdown, optional extras, mock checkbox, "Install agents into this folder"
button, Start). (2) Steps tracker (preflight/plan/refine#/implement/review#/done,
current highlighted). (3) Live log window (auto-scroll, WS). (4) Question panel —
clarify: each question with its 3 option buttons + free-text input + submit; gate: open
critical/major issues list + two buttons "Don't have another cycle and continue" / "I
approve another cycle". (5) Stop button. (6) History list (`/api/runs`) with
click-to-view saved markdown. Clean minimal dark CSS.

---

## 5. ON-DISK FILE CONTRACTS

All pipeline files live under
`<projectDir>/ai-artifacts/pipelines/<DD-MM-YY>-<slug>-<id>/`.

### 5.1 `clarify.json` (written by planner-clarify; read by `readClarify`)
```json
{
  "questions": [
    {
      "id": "q1",
      "question": "Which storage backend should the feature use?",
      "options": ["In-memory", "SQLite", "Postgres"],
      "allowFreeText": true
    }
  ]
}
```
- Missing file is valid and means "no open questions" => `{ "questions": [] }`.
- `options` MUST contain exactly 3 strings. `allowFreeText` MUST be `true`.

### 5.2 `clarify-answers.json` (written by `writeClarifyAnswers`)
```json
{
  "answers": [
    { "id": "q1", "question": "Which storage backend should the feature use?", "choice": "SQLite" }
  ]
}
```
- `choice` is the chosen option text OR the user's free-text answer.

### 5.3 review JSON (written by refiner and reviewer; read by `readReview`)
Two distinct per-cycle files are written: the refiner writes `refine-review-cycle1.json`,
`refine-review-cycle2.json`, ... (one per refine cycle); the code-reviewer writes
`impl-review-cycle1.json`, `impl-review-cycle2.json`, ... (one per review cycle). Both share
the schema below (N = the loop cycle).
```json
{
  "issues": [
    {
      "severity": "major",
      "title": "Missing input validation",
      "detail": "The handler trusts req.body without schema checks.",
      "location": "src/api/handler.mjs:42"
    }
  ],
  "summary": "One major issue; otherwise the plan/implementation is sound."
}
```
- `severity` ∈ `SEVERITIES` = `["critical","major","minor","suggestion"]`.
- `hasBlocking` is true iff any issue is `critical` or `major`.

### 5.4 `state.json` (written by `createPipeline` / `writeState`; read by `listPipelines` / `readPipeline`)
Full state snapshot. Minimum fields (extra fields allowed; keep these stable):
```json
{
  "id": "ab12cd",
  "title": "Add search endpoint",
  "projectDir": "/abs/path/to/project",
  "pipelineDir": "/abs/path/.../pipelines/31-05-26-add-search-endpoint-ab12cd",
  "status": "running",
  "phase": "refine",
  "cycle": 2,
  "startedAt": "2026-05-31T19:30:00.000Z",
  "updatedAt": "2026-05-31T19:32:10.000Z",
  "preflight": { "graphify": false, "codeReviewGraph": false, "tool": null, "instruction": "" },
  "checkpointRef": "<git sha>",
  "planBaseName": "add-search-endpoint",
  "planVersions": ["31-05-26-add-search-endpoint.md", "31-05-26-add-search-endpoint-v2.md"],
  "reviews": ["refine-review-cycle1.json", "impl-review-cycle1.json"],
  "artifacts": [ { "kind": "plan", "path": "/abs/.../plans/31-05-26-add-search-endpoint.md" } ]
}
```
- `status` ∈ `{ "running", "done", "stopped", "error" }`.
- `phase` ∈ `{ "preflight", "plan", "refine", "implement", "review", "done" }`.

### 5.5 `pipeline.md` (audit log; header written by `createPipeline`, lines by `appendAudit`)
Human-readable markdown audit trail saved for history/audit. Header carries the run
metadata; each subsequent line is one timestamped audit entry.
```md
# Pipeline <id> — <title>

- Project: <projectDir>
- Started: <ISO timestamp>
- Prompt: <prompt or source markdown filename>

## Audit

- [<ISO ts>] preflight: tool=none
- [<ISO ts>] phase: plan/clarify started
- [<ISO ts>] artifact: plan -> .../plans/31-05-26-...md
- [<ISO ts>] phase: refine cycle 1 (1 blocking issue)
- ...
```

### 5.6 Plan markdown (`planPath`)
`<plans>/<DD-MM-YY>-<baseName>[-vN].md`. The plan MUST include code snippets for the
features. The planner appends a final section:
```md
## Clarifications (Q&A)

- **Q:** <question> — **A:** <choice>
```

### 5.7 Review markdown (`reviewPath`)
`<reviews>/<DD-MM-YY>-<baseName>-impl-review.md`. Human-readable review of the git diff;
machine-readable counterpart is the matching `impl-review-cycleN.json`.

---

## 6. CONVENTIONS / QUALITY BAR

- ESM throughout (`.mjs`, `import`/`export`).
- Small, focused functions; clear names; consistent style across files.
- **Every shell/env probe fails safe** (failure => falsey, never throws).
- The MOCK path (`MAESTRO_MOCK=1`) must run a FULL pipeline end-to-end, producing real
  artifact files, without spawning `claude` and without spending tokens.
- No `TODO`/placeholder/stub bodies in the final product. (Architect-phase stubs throw
  `Error("not implemented")` and are replaced by the owning builder.)
- All paths produced by `artifacts.mjs` are absolute.
