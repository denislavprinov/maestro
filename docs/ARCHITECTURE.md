# Maestro — ARCHITECTURE (single source of truth)

This document is the authoritative contract every builder codes against. The exact
export signatures, event names, and on-disk JSON/Markdown file contracts below are
binding. Do not change a signature without updating this file first.

**Extension decisions:** where a new feature belongs (agent, runner, workflow,
platform, external skill) is decided by the `.claude/skills/maestro-arch-decision`
skill; each verdict is recorded as a mini-ADR in `docs/adr/`.

**Product:** a deterministic multi-agent pipeline that drives Claude Code (headless)
through **Plan -> Refine -> Implement -> Review** for a software task, exposed via a
CLI, an installable `/maestro` skill, and a web UI.

**Runtime:** plain Node.js ESM (`.mjs`), Node `>=22.13.0`. The floor is set by the
built-in **`node:sqlite`** module (Maestro's structured-state store), which is
flag-free from Node v22.13 (v22 LTS "Jod") and all v23/24/25+. `node:sqlite` is
synchronous (`DatabaseSync`) and still flagged *experimental*, so its one-time
`ExperimentalWarning` is suppressed at startup. The npm scripts that open the DB
pass the inline flag `node --disable-warning=ExperimentalWarning` (the primary
suppressor; not a `NODE_OPTIONS=` prefix, so it is Windows-safe); both entry points
(`src/cli/maestro.mjs`, `ui/server.mjs`) ALSO `process.removeAllListeners('warning')`
then attach one `process.on('warning')` filter that drops only
`name === 'ExperimentalWarning' && /SQLite/i` and forwards every other warning —
the fallback for a direct `bin` invocation that bypasses the npm script. The DB is
opened in **WAL** mode with `foreign_keys=ON`, `busy_timeout=5000`, and
`synchronous=NORMAL` so the CLI and web UI can write concurrently. Minimal external
deps: `express` + `ws` only; everything else uses Node built-ins. Frontend is
vanilla HTML/CSS/JS (no framework, no build step). A runtime preflight
(`src/core/preflight-node.mjs`) runs at each entry point and fails fast with an
actionable message if the Node version is below the floor or `node:sqlite` cannot
load.

**CWD for all file writes during development:** `/Users/denislavprinov/Develop/orchestrator`

---

## 1. FILE LAYOUT (authoritative)

```
package.json                         type:module; engines.node>=22.13; scripts: start(ui), cli, install:agents, smoke, smoke:workspace, test (DB-opening scripts pass --disable-warning=ExperimentalWarning); deps express+ws
.nvmrc                               lts/jod — pins a flagless-node:sqlite Node (>=22.13) for contributors
README.md
.gitignore                           node_modules, examples/sandbox, *.log, graphify-out/, .maestro/, plus any abandoned legacy ai-artifacts/
docs/ARCHITECTURE.md                 this file

src/core/protocol.mjs                JSON contracts + validators shared by agents and orchestrator
src/core/store.mjs                   project identity + external store paths (projectKey, storeRoot, projectStorePath)
src/core/db.mjs                      singleton node:sqlite (DatabaseSync) at <maestroHome>/maestro.db; pragmas; versioned migrate() (user_version); tx(), prepare(), getDb(), closeDb(); node:sqlite is loaded LAZILY via createRequire on first getDb() (so the entry points install their warning filter first)
src/core/migrate-fs-to-db.mjs        one-shot fs->db importer (runs from getDb() when the DB is empty AND legacy JSON is present); archives consumed JSON to backup-<ts>/
src/core/preflight-node.mjs          runtime guard: Node>=22.13 + node:sqlite load probe; fails fast with an actionable message (does NOT import db.mjs)
src/core/artifacts.mjs               paths, slugify, date(DD-MM-YY), pipeline create/persist/audit — now reads/writes the DB; FS only for markdown + extras/
src/core/preflight.mjs               detectTools(projectDir) for graphify / code-review-graph
src/core/claude-runner.mjs           spawn claude headless, stream events, AbortSignal kill, MOCK mode
src/core/phases.mjs                  per-phase agent runners (planner clarify+plan, refiner, plan-review, implementer, reviewer)
src/core/orchestrator.mjs            EventEmitter state machine sequencing all phases + loops + gates

src/cli/maestro.mjs              CLI entry: args, terminal rendering, interactive Q&A + gates (runs preflightNode() + installs the warning filter at startup)
scripts/install.mjs                  copy agents/*.md + skills/maestro into a target project .claude/

agents/maestro-planner.md
agents/maestro-plan-refiner.md
agents/maestro-plan-reviewer.md
agents/maestro-implementer.md
agents/maestro-code-reviewer.md
skills/maestro/SKILL.md

ui/server.mjs                        express static + REST + WebSocket, drives core (runs preflightNode() + installs the warning filter at startup)
ui/public/index.html
ui/public/app.js
ui/public/style.css

# Structured state (projects, workspaces, workflows, per-project config, pipeline run
# state + steps + audit events, clarify Q&A, review verdicts, store meta, artifact index)
# is NOT in this repo and is NO LONGER scattered JSON. It lives in a single machine-wide
# SQLite DB at <maestroHome>/maestro.db (WAL; default ~/.maestro/maestro.db). The ONLY
# on-disk artifacts are agent MARKDOWN outputs + user attachments, under the external
# store at <maestroHome>/store/<projectKey>/{plans,reviews,pipelines}/ (created on demand
# by ensureArtifactDirs()). settings.json keeps only the {root} bootstrap key (it locates
# the DB, so it cannot itself live in the DB). On first launch of this version, legacy
# JSON is auto-migrated into the DB and archived to <maestroHome>/backup-<ts>/.
```

### On-disk layout after migration (authoritative)

```
<maestroHome>/                         default ~/.maestro
  settings.json                        {root} ONLY — bootstrap that locates the DB (not in the DB)
  maestro.db  (+ maestro.db-wal, -shm) the single SQLite store for ALL structured state (WAL)
  backup-<ts>/                          legacy JSON archived on first migration (mirror of old layout)
  store/<projectKey>/
    plans/    <DD-MM-YY>-<name>[-vN].md       agent plan markdown            (FS)
    reviews/  <DD-MM-YY>-<name>-impl-review.md agent review markdown          (FS)
    pipelines/<DD-MM-YY>-<slug>-<id>/
      prompt.md                               the run prompt body            (FS)
      manual-tests-checklist.md               manual-test agent markdown     (FS)
      webui-review-cycleN.md                  web-UI review agent markdown    (FS)
      extras/                                 user attachments (arbitrary)   (FS)
```

The filesystem now holds **only** the markdown agent outputs above and `extras/` user
attachments; the existence of each is indexed in the DB `artifacts` table. Everything
else that used to be a `.json`/`.md` control file is a DB table (see §5).

### Ownership (who writes which files)

- **Architect (this pass):** `package.json`, `.gitignore`, `README.md`,
  `docs/ARCHITECTURE.md`, and **signature stubs** for the
  `src/core/*.mjs` files. These stubs lock the interface; their bodies throw
  `Error("not implemented")` until the owning builder fills them in. (No in-repo history
  scaffolding is checked in — the external store under `<maestroHome>/store/` is created
  on demand at runtime.)
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
3. **plan (planner)** — single clarify round then plan.
   - **clarify:** planner asks one round of conceptual questions whenever it would otherwise
     assume. Each question has **2–4 options + a free-text field** (up to 8 per round). Persist the Q&A.
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

- `readClarify(pipelineDir) -> { questions: [ { id, question, options: [ ... 2–4 strings ], allowFreeText:true } ] } | { questions: [] }`
  - Reads `clarify.json` from `pipelineDir`. **Missing file => `{ questions: [] }`.**
  - Each question: `id` (string), `question` (string), `options` (array of **2–4**
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

### 3.2 `src/core/store.mjs`

Durable project identity + external history store paths. All resolution is **synchronous
and fail-safe** (a non-repo / missing git degrades to the realpath of the dir, never
throws).

**Exports:**

- `canonicalProjectRoot(projectDir) -> string`
  - Absolute path to the canonical main-repo root: the parent of the shared `.git`
    (via `git rev-parse --git-common-dir`), so **every worktree of a repo resolves to the
    same root**. Falls back to the realpath of `projectDir` outside a git repo.

- `projectKey(projectDir) -> string`
  - Stable per-repo key: `<repo-basename-slug>-<sha1(canonicalRoot)[:8]>`. Memoized by
    resolved input path. Identical for all worktrees of one repo.

- `storeRoot() -> string`
  - Root of the external history store: `<maestroHome>/store` (default `~/.maestro/store`).

- `projectStorePath(key) -> string`
  - Per-project store directory: `<maestroHome>/store/<key>`.

### 3.3 `src/core/artifacts.mjs`

Paths, slugify, date, pipeline create/persist/audit. **All markdown/extras paths it
returns are rooted in the external store from `store.mjs`, not the project working tree.**

> **Storage substrate (node:sqlite migration):** the export **signatures below are
> unchanged**, but pipeline run state, audit events, clarify Q&A, review verdicts, and
> store meta are now persisted as **rows in `<maestroHome>/maestro.db`** via
> `src/core/db.mjs`, **not** as `state.json` / `pipeline.md` / `clarify*.json` /
> `*-review-cycleN.json` / `meta.json` files. JSON-shaped values are (de)serialized at
> this module boundary only (the DB columns are `TEXT`). `createPipeline` inserts a
> `pipelines` row (and seeds the dir->id cache); `writeState` upserts that row + its
> `pipeline_steps`; `appendAudit` inserts a `pipeline_events` row; `listPipelines`/
> `readPipeline` SELECT them. `prompt.md` and all plan/review markdown + `extras/` remain
> on the FS (and are indexed in the `artifacts` table via `recordArtifact`). The exact
> table contracts are in §5.

**Exports:**

- `slugify(s) -> string`
  - kebab-case slug: lowercase, non-alphanumerics collapsed to single `-`, trimmed of
    leading/trailing `-`.

- `today() -> "DD-MM-YY"`
  - Zero-padded day-month-year from the system clock at runtime (ordinary runtime code).

- `artifactPaths(projectDir) -> { root, plans, reviews, pipelines }`
  - All **absolute** paths under the machine-wide external store (see
    `src/core/store.mjs`), **not** the project working tree. Routing every
    plan/review/pipeline reader and writer through this one function is what keeps all
    three out of the repo:
    - `root = projectStorePath(projectKey(projectDir))` = `<maestroHome>/store/<projectKey>`
      (default `~/.maestro/store/<projectKey>`)
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
      markdown) and indexes it in the `artifacts` table.
    - copies each path in `extras` into `dir/extras/` (each indexed in `artifacts`).
    - INSERTs the run's `pipelines` row (via `writeState`; see §5.4) — there is no
      `state.json`. A human-facing `pipeline.md` header is still written into `dir` for
      convenience, but the audit trail itself is `pipeline_events` (see §5.5).
  - Returns `{ id, dir, promptText }` where `promptText` is the resolved prompt body.

- `appendAudit(pipelineDir, markdownLine) -> void`
  - INSERTs one `pipeline_events` row `{ ts, text }` (see §5.5); the pipeline id is
    resolved from `pipelineDir` (a dir->id cache, else the trailing 8-hex of the basename),
    so the signature is unchanged. Best-effort: an unresolvable dir is a safe no-op.

- `writeState(pipelineDir, stateObj) -> void`
  - Upserts the state object's `pipelines` row and REPLACEs its `pipeline_steps` rows, in
    one transaction (see §5.4 for the A11 curated-UPSERT data-loss contract). `pipelineDir`
    is retained for signature stability + to seed the `appendAudit` dir->id cache.

- `listPipelines(projectDir) -> [ { id, dir, title, status, startedAt, mtime } ]`
  - SELECTs the project's `pipelines` rows (via the `(project_key, started_at)` index),
    newest first; one `readdir` per store key re-attaches the real on-disk `dir`.

- `readPipeline(projectDir, id) -> { state, auditMarkdown }`
  - Reconstructs `state` from the `pipelines` row + its `pipeline_steps` and rebuilds the
    `pipeline.md`-format `auditMarkdown` from the row + its `pipeline_events`. Returns
    `null` when no pipeline with that id exists.

### 3.4 `src/core/preflight.mjs`

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

### 3.5 `src/core/claude-runner.mjs`

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
  - `planner-clarify` => write `clarify.json` with **two** sample questions (2 and 4 options +
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
  - `plan-review` => write the plan-review markdown + `plan-review-cycleN.json` whose
    blocking-issue count **decreases** with cycle (cycle 1: 1 major; cycle >= 2: only
    suggestion) so the Plan -> Plan Review loop terminates and bounces back to the planner.

  Marker convention (the phases layer emits these; the mock parses them):
  - `MOCK_ROLE: <planner-clarify|planner-plan|refiner|implementer|reviewer|plan-review>`
  - `MOCK_OUT: <absolute path>` — primary output file (plan md / review md / clarify.json)
  - `MOCK_JSON: <absolute path>` — review JSON path (refiner/reviewer)
  - `MOCK_CYCLE: <n>` — current loop cycle (refiner/reviewer)

### 3.6 `src/core/phases.mjs`

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
- planner / refiner / plan-review / reviewer: `Read, Write, Edit, Bash, Grep, Glob`
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

- `runPlanReviewer(ctx, { planPath, reviewMdPath, reviewJsonPath, cycle }) -> { review }`
  - Reviews the PLAN markdown (no git diff; role `plan-review`) without rewriting it, writes
    review markdown to `reviewMdPath` and the plan-review JSON (`plan-review-cycle<cycle>.json`)
    to `reviewJsonPath`. A **review-JSON producer**: on blocking issues the loop bounces back to
    the planner for a cold re-plan. Returns `{ review }` (parsed).

### 3.7 `src/core/orchestrator.mjs`

EventEmitter state machine sequencing all phases + loops + gates.

**Exports:**

- `createOrchestrator(opts) -> { run(), resume(), answer(id, payload), stop(), pause(), getState(), on(event, cb), ... }`
  (EventEmitter-like; at minimum supports `on`/`emit` plus the methods above.)

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
  auto?,                   // non-interactive: auto-answer clarify+gates
  resume?                  // readPipelineForResume(id) result; drives resume() (no prompt needed)
}
```

**Methods:**
- `run() -> Promise<...>` — executes the full sequence (below).
- `answer(id, payload) -> void` — resolves a pending `question` event.
  - clarify payload: `{ answers: [ { id, choice } ] }`
  - gate payload: `{ decision: "continue" | "another" }`
- `stop() -> void` — aborts via an `AbortController` and marks state `stopped`.
- `pause() -> boolean` — graceful pause: SIGTERMs in-flight node children via a
  pause-only `AbortController`, unwinds the dispatch loop at the next safe point,
  persists a `resume_point` (§5.4) and marks state `paused` (transiently `pausing`
  while unwinding). Returns `false` unless currently `running`; stop always wins over
  a pause in flight. Unlike stop, a pause NEVER tears down the per-pipeline
  worktree(s) — the checkout (with any uncommitted agent work) is what resume re-enters.
- `resume() -> Promise<...>` — continues a paused pipeline. Requires
  `opts.resume = readPipelineForResume(id)` (`{ row, resumePoint, steps }`, src/core/
  artifacts.mjs); rehydrates identity/steps/worktree(s) entirely from the DB row — so it
  works in a fresh process after a server restart — re-dispatches from the saved
  position, and re-attaches the interrupted step's Claude session
  (`claude --resume <session_id>`), falling back to one fresh re-run (with an audit
  note) when the session is gone. Refuses non-`paused` rows. Resolves like `run()`.
- `getState() -> object` — current full state snapshot.

**Sequence performed by `run()`:**
1. **preflight** -> `detectTools(projectDir)`.
2. **ensure target git repo** — `git init` + initial commit if none; record checkpoint
   ref (used as the diff base for review).
3. **planner clarify (single round)** — emit `question` with `kind:"clarify"`; on answers, persist
   Q&A.
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

Subcommands:
- `resume <pipelineId> [--mock] [--yes]` — continue a paused pipeline from its
  `resume_point` (re-attaches Claude sessions). Resolves the project dir from the
  registry, falling back to the cwd when the project is not onboarded.

Behavior: subscribes to core events; renders phases + streams logs to the terminal; on
a `question` event uses `readline` to show its 2–4 options + free-text (clarify) or the two
gate choices + issue list, then calls `answer()`. On `done`, prints the pipeline dir.
`Ctrl+C` ladder: the 1st gracefully **pauses** (prints the `maestro resume <id>` hint;
falls back to stop when not pausable), the 2nd stops, the 3rd hard-exits (130).

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
  - `POST /api/pause` `{ runId }` -> gracefully pause a live run (lands on status `paused`).
  - `POST /api/resume` `{ pipelineId }` -> rehydrate a paused pipeline from the DB
    (works across server restarts) and continue it as a new live run entry with the
    SAME pipeline id / history row; returns `{ ok, runId, pipelineId }`. Guards: row must
    be `paused` with a `resume_point`, not already live, worktree still on disk.
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

## 5. STORAGE CONTRACTS (DB tables + the few remaining FS files)

Structured state lives in a single SQLite DB at `<maestroHome>/maestro.db` (WAL;
default `~/.maestro/maestro.db`), opened by `src/core/db.mjs`. There are **14 tables**
(full DDL is in `src/core/db.mjs`#`SCHEMA_V1`, stamped at `PRAGMA user_version = 1`);
the binding contracts are below. SQLite has no JSON type, so columns marked **(JSON)**
are `TEXT` holding a `JSON.stringify`'d value that the owning service module parses on
read (a null/empty/corrupt column reads back as the fallback, never a throw). Case-
insensitive uniqueness (`projects.name`, `workspaces.name`) is enforced with
`COLLATE NOCASE`. Foreign keys are ON; child rows (`pipeline_steps`, `pipeline_events`,
`clarify`, `reviews`, `artifacts`, `workspace_projects`) cascade-delete with their
parent.

The **only** files still on disk are the agent **markdown** outputs and `extras/`
attachments (see §5.6–§5.7 and the on-disk layout above), under
`<maestroHome>/store/<projectKey>/...` — outside the project working tree, never
committed. Their existence is indexed in the `artifacts` table.

On first launch of this version, `src/core/migrate-fs-to-db.mjs` imports any legacy JSON
into these tables in one transaction and archives the consumed files to
`<maestroHome>/backup-<ts>/` (it runs from `getDb()` only when the DB has no migrated
data AND legacy JSON is present; the row-count guard makes a re-run a no-op).

### 5.1 `clarify` table (was `clarify.json` + `clarify-answers.json`)

One row per pipeline. Per Amendment A3, the live planner loop still reads the
`clarify.json` the agent subprocess physically wrote (a subprocess cannot write the
parent's in-process DB handle); `writeClarify` then MIRRORS it into this row, which is
the durable history record `readClarifyRow` reads. `writeClarifyAnswers` (protocol.mjs)
stays file-based for the same live hand-off and is likewise mirrored into the `answers`
column.

```
clarify(
  pipeline_id  TEXT PRIMARY KEY  REFERENCES pipelines(id) ON DELETE CASCADE,
  questions    TEXT  -- (JSON) { questions: [ { id, question, options:[2..4 strings], allowFreeText:true } ] }
  answers      TEXT  -- (JSON) { answers:   [ { id, question, choice } ] }
)
```
- `questions` JSON payload shape: `options` MUST
  contain **2–4** strings and `allowFreeText` MUST be `true`.
- **No row, or `questions` NULL, means "no open questions"** => `{ "questions": [] }` (the
  former "missing file" semantics).
- `answers` JSON is the old `clarify-answers.json` body; `choice` is the chosen option text
  OR the user's free-text answer. A partial `writeClarify` updates only the column it was
  given, preserving the other.

### 5.2 (removed) `clarify-answers.json` — folded into the `clarify` table (§5.1, `answers` column).

### 5.3 `reviews` table (was `refine-review-cycleN.json` / `plan-review-cycleN.json` / `impl-review-cycleN.json`)

One row per (pipeline, kind, cycle). `kind ∈ {refine, impl, plan, ws, webui}` (a 5-value
OPEN set, A2: real run dirs also carry `webui-review-cycleN.json` from the manual web-UI
verifier; `reviewKindOf` derives it by stripping the `-review-cycleN.json` suffix and
passes an unknown base through unchanged, so the mapping is lossless). `kind` replaces the
filename prefix; `cycle` (1-based) replaces the `cycleN` suffix. Per Amendment A3 the live
agent hand-off still reads the JSON file the subprocess wrote; the DB row is the durable
mirror `writeReview` upserts, and the `reviews` table is the authoritative history record.

```
reviews(
  pipeline_id TEXT  REFERENCES pipelines(id) ON DELETE CASCADE,
  kind        TEXT,            -- 'refine' | 'plan' | 'impl' | 'ws' | 'webui'  (A2; free text)
  cycle       INTEGER,         -- 1-based loop cycle
  verdict     TEXT,            -- (JSON) { issues:[ {severity,title,detail,location} ], summary }
  PRIMARY KEY (pipeline_id, kind, cycle)
)
```
- `verdict` JSON shape is unchanged from the old review JSON files. Re-running a cycle
  REPLACES its verdict (`ON CONFLICT(pipeline_id, kind, cycle) DO UPDATE`).
- `severity` ∈ `SEVERITIES` = `["critical","major","minor","suggestion"]`; `hasBlocking`
  is true iff any issue is `critical` or `major`.
- Mapping from the old filenames: `refine-review-cycleN.json` => `kind='refine', cycle=N`;
  `plan-review-cycleN.json` => `kind='plan'`; `impl-review-cycleN.json` => `kind='impl'`;
  workspace review => `kind='ws'`; `webui-review-cycleN.json` => `kind='webui'`.

### 5.4 `pipelines` (+ `pipeline_steps`) tables (was `state.json`)

One pipeline run = one `pipelines` row; its per-step array (`state.steps[]`) is normalized
into `pipeline_steps` rows. `createPipeline` INSERTs the row; `writeState` upserts it +
REPLACES its `pipeline_steps`; `listPipelines`/`readPipeline` SELECT them (newest-first via
the `(project_key, started_at)` index). The in-memory state object the orchestrator emits is
unchanged — only its persistence moved; the former `state.json` file is gone.

```
pipelines(
  id              TEXT PRIMARY KEY,
  project_key     TEXT NOT NULL,
  workspace_key   TEXT,                          -- the workspace key for a workspace run; NULL for single-project
  target          TEXT NOT NULL DEFAULT 'project', -- 'project' | 'workspace'
  title           TEXT,
  base_name       TEXT,
  date_prefix     TEXT,
  status          TEXT NOT NULL DEFAULT 'created',
  phase           TEXT NOT NULL DEFAULT 'created',
  cycle           INTEGER NOT NULL DEFAULT 0,
  started_at      TEXT,
  updated_at      TEXT,
  total_cost_usd  REAL NOT NULL DEFAULT 0,
  total_active_ms INTEGER NOT NULL DEFAULT 0,
  prompt          TEXT,                            -- the resolved prompt body (was prompt.md only)
  branch          TEXT,  -- (JSON) { source, feature, worktreeDir, reusedExisting, ... }
  workspace_meta  TEXT,  -- (JSON) { workspaceId, workspaceName, workspaceDescription, projectKeys, projects[], checkpointRefs, branches }
  stepper         TEXT,  -- (JSON) buildStepperManifest() snapshot
  tools           TEXT,  -- (JSON) detectTools()/resolved tool descriptor
  resume_point    TEXT   -- (JSON, added v5) serialized dispatch position while paused; NULL otherwise
)
-- indexes: (project_key, started_at), (workspace_key, started_at), (status)

pipeline_steps(
  pipeline_id   TEXT REFERENCES pipelines(id) ON DELETE CASCADE,
  key           TEXT,            -- stable "<stepIndex>:<nodeId>[#cycle]"
  node_id       TEXT, phase TEXT, step_index INTEGER, cycle INTEGER, status TEXT,
  started_at    TEXT, updated_at TEXT,
  active_ms     INTEGER NOT NULL DEFAULT 0,
  running_since TEXT,            -- resume timestamp (epoch-ms as TEXT); NULL when paused
  cost_usd      REAL NOT NULL DEFAULT 0,
  session_id    TEXT,            -- (added v5) Claude Code session id (stream-json init event)
  PRIMARY KEY (pipeline_id, key)
)
```
- `status` ∈ `{ "running", "done", "stopped", "error", "interrupted", "pausing", "paused" }`
  (on `pipelines.status`).
  `interrupted` is set by the boot/history reconciler (`reconcileStaleRunning`, src/core/artifacts.mjs)
  for runs whose owning process died before writing a terminal status; staleness window is
  `MAESTRO_STALE_RUN_MS` (default 30 min). `pausing` is TRANSIENT (pause requested, dispatch
  unwinding) and counts as non-terminal: a process that crashes mid-pause leaves a stale
  `pausing` row, which the same reconciler sweeps to `interrupted`. `paused` is STABLE — it
  is never swept, stays resumable indefinitely, and is the only status `resume()` /
  `POST /api/resume` accept. Delete guards (src/core/pipeline-delete.mjs ACTIVE set) treat
  `pausing` as live and refuse deletion; a `paused` row is settled and deletable like any
  finished run (deleting it discards the kept worktree).
- **`pipelines.resume_point` (TEXT/JSON, added v5)** — the serialized dispatch position of a
  paused run; NULL otherwise. Shape:
  `{ version: 1, kind: "node"|"boundary"|"gate", stepIndex, stepCycle[], loopState, bus,
  stepModels, workflowId, plan, nodes[], gate, toolInstruction, pipelineDir, pausedAt }`.
  `kind` says where the pause landed (mid-node / between steps / awaiting a gate answer);
  `plan` is the FROZEN resolved topology and `bus` the channel snapshot; `nodes[]` records
  the interrupted step's nodes as `{ nodeId, key, sessionId, completed }` (the sessionId
  drives the one-shot `claude --resume` re-attach); `gate` snapshots an interrupted
  feedback-loop gate. It also carries `toolInstruction` (the EFFECTIVE post-graph-build
  instruction, not the detect-time `tools.instruction`) plus `pipelineDir` and `pausedAt`,
  so resume needs no path re-derivation. Cleared to NULL once the run leaves `paused` (resume consumes it;
  completion persists the cleared value), and NEVER persisted on `stopped` rows.
- **`pipeline_steps.session_id` (TEXT, added v5)** — the Claude Code session id captured from
  the stream-json init event, stamped eagerly on the step row that spawned it (a crash still
  leaves a resumable trail); deterministic `mock-session-<role>-c<cycle>` in mock mode.
- **No worktree teardown on pause:** done/stopped/error tear the per-pipeline worktree(s)
  down (the feature branch is kept), but a pause keeps the checkout on disk for the whole
  paused period — uncommitted agent work lives there and `resume()` re-attaches to
  `branch.worktreeDir` (failing fast if it is missing).
- `phase` ∈ `{ "preflight","plan","refine","plan-review","implement","review","done" }`
  (data-driven workflows may also emit `manual-checklist`/`manual-web`).
- The old `state.json` scalar fields map 1:1 to `pipelines` columns; the old
  `state.steps[]` entries map to `pipeline_steps` rows (one per step key). The former
  `state.artifacts[]` / `planVersions[]` / `reviews[]` derived arrays are reconstructed on
  read from the `artifacts` and `reviews` tables.
- **Data-loss-prevention UPSERT contract (A11):** `createPipeline`'s INSERT writes every
  column, but the orchestrator's in-memory `this.state` omits several `createPipeline`-owned
  columns, and the SAME row-mapper feeds `writeState`'s `ON CONFLICT(id) DO UPDATE`. So the
  UPDATE arm is **curated** — it SETs ONLY the columns that legitimately mutate during a run
  (`status, phase, cycle, updated_at, total_cost_usd, total_active_ms, branch,
  workspace_meta, stepper, tools`) and NEVER touches the creation-immutable identity columns
  (`project_key, prompt, target, title, workspace_key, started_at`), so a post-create persist
  can never null them. `base_name`/`date_prefix` are the one exception: `createPipeline`
  leaves them NULL and the orchestrator fills them just before the first persist, so they are
  updated with a `COALESCE(excluded.col, col)` guard that fills NULL->value once and never
  clobbers a set value back to NULL.

### 5.5 `pipeline_events` table (was the `pipeline.md` audit log)

Append-only audit trail. Per Amendment A7 each former `pipeline.md` is consumed losslessly
on migration: its `## Timeline` body becomes `pipeline_events` rows and the header is the
parent `pipelines` row. `appendAudit` INSERTs one row per call; `readPipeline` rebuilds the
old `pipeline.md`-format `auditMarkdown` (header + `- \`<ts>\` <text>` timeline) from the
row + its events, so a History detail view renders identically. (A human-facing
`pipeline.md` header is still written into a fresh run dir for convenience, but it is no
longer the audit source.)

```
pipeline_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_id TEXT REFERENCES pipelines(id) ON DELETE CASCADE,
  ts   TEXT,   -- ISO timestamp
  text TEXT    -- the audit line body (no leading "- [ts]" — ts is its own column)
)
-- index: (pipeline_id, id)
```
- Ordering is by the autoincrement `id` (insertion order), replacing line order in the file.
- The history view renders these rows instead of reading `pipeline.md`.

### 5.6 Plan markdown (`planPath`) — STILL ON THE FILESYSTEM
`<plans>/<DD-MM-YY>-<baseName>[-vN].md`. The plan MUST include code snippets for the
features. The planner appends a final section:
```md
## Clarifications (Q&A)

- **Q:** <question> — **A:** <choice>
```

### 5.7 Review markdown (`reviewPath`) — STILL ON THE FILESYSTEM
`<reviews>/<DD-MM-YY>-<baseName>-impl-review.md`. Human-readable review of the git diff;
its machine-readable counterpart is now the matching `reviews` table row (§5.3,
`kind='impl'`, `cycle=N`), not a `*-review-cycleN.json` file. This markdown is indexed in
the `artifacts` table (`kind='review'`) so the pipeline deleter can unlink the exact file.

### 5.8 Registry / config / meta tables (was `projects.json`, `workspaces.json`, `workflows/*.json`, per-project `config.json`, `meta.json`)

These back the `projects`/`workspaces`/`workflows`/`config`/`settings`/`artifacts` service
modules. Signatures in §3 + §4 are unchanged; only the substrate moved to the DB. With §5.1–
§5.5 these complete the **14 tables**.

```
projects(key PK, name NOT NULL COLLATE NOCASE, path NOT NULL, created_at)        -- was projects.json [{name,path}]; key is the store.mjs projectKey; UNIQUE INDEX on name COLLATE NOCASE
workspaces(id PK, name NOT NULL COLLATE NOCASE, description DEFAULT '', created_at, updated_at) -- was workspaces.json header; id is the frozen wks-<slug>-<sha1[:8]>; UNIQUE INDEX on name COLLATE NOCASE
workspace_projects(workspace_id FK->workspaces.id, project_key, ordinal, PK(workspace_id, ordinal)) -- the ordered projectPaths[]
workflows(id PK, name NOT NULL, version DEFAULT 1, steps (JSON) DEFAULT '[]', feedbacks (JSON) DEFAULT '[]', created_at, updated_at) -- was workflows/<id>.json; built-in DEFAULT_WORKFLOW stays code, never a row
project_config(project_key PK, steps (JSON) DEFAULT '{}', custom_models (JSON) DEFAULT '[]', active_workflow_id, extra (JSON) DEFAULT '{}') -- was <projectDir>/.maestro/config.json; `extra` preserves unknown top-level keys (e.g. webUiTesting)
config_workflow_nodes(project_key, workflow_id, node_id, model, effort, fan_out, PK(project_key, workflow_id, node_id)) -- normalized per-node {model?,effort?,fanOut?} overrides; fan_out is a nullable 0/1
config_workflow_feedbacks(project_key, workflow_id, fb_id, max_cycles NOT NULL, PK(project_key, workflow_id, fb_id)) -- normalized feedback cycle caps (max_cycles >= 1)
store_meta(key PK, kind NOT NULL, data (JSON) NOT NULL) -- was per-project / per-workspace meta.json; kind ∈ 'project' | 'workspace'
artifacts(pipeline_id FK->pipelines.id, kind, rel_path, PK(pipeline_id, kind, rel_path)) -- index of the FS markdown + extras paths kept on disk
```
- **A1 — `workspace_projects.project_key` holds the absolute member PATH, not a key.**
  Despite the column NAME (`project_key`, as built — it was deliberately NOT renamed), each
  row stores the **absolute member path**, ordinal-ordered by `ordinal`. The real
  `projectKey` is recomputed on read via `store.projectKey(path)` (a one-way hash, so the
  path can never be recovered from a key); `projectKeys`/`exists` are derived on read (not
  stored), per `workspaces.mjs#annotate`.
- `artifacts.kind` is free text — the values written today are `prompt`, `extra`,
  `workspace-description`, `plan`, `review`, `manual-checklist`, `webui-review` (and the
  importer also tags stray run-dir markdown `extra-md`). `rel_path` is relative to the
  pipeline dir for pipeline-local files (`prompt.md`, `extras/*`,
  `manual-tests-checklist.md`, `webui-review-cycleN.md`) and relative to the store root for
  the shared `plans/`/`reviews/` markdown (siblings of `pipelines/`).
- `settings.json` is intentionally NOT a table: it keeps only `{ root }`, the bootstrap key
  that locates `maestro.db` (chicken/egg). Everything else that was in `settings.json` (if
  anything) moves into the DB.

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
