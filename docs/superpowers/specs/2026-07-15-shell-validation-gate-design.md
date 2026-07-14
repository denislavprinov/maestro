# Shell Validation Gate — Design

**Date:** 2026-07-15
**Status:** Approved (brainstorm complete)
**Origin:** Goose-style recipe retry pattern — declare success criteria as shell
command(s) validated deterministically, auto-retry on failure.

## Problem

Maestro's Implement → Review loop terminates on reviewer judgment alone. Nothing
deterministic verifies the implementation (tests, lint, build) before the reviewer
spends tokens on it. Agents run tests themselves via Bash when prompted, but that
is non-deterministic and unenforced. Broken builds reach the reviewer.

## Solution overview

A user-supplied shell validation command runs as a **synthetic verifier node**
(`shellGate`) inserted between the implementer and the code reviewer. Failure is
converted into a canonical blocking review and fed back to the implementer via the
existing feedback-edge machinery — the implementer enters FIX mode exactly as it
does for a human-shaped review. Pass → the reviewer runs as normal.

No commands supplied → no node inserted → pipeline behavior byte-identical to today.

## Decisions (locked during brainstorm)

| Decision | Choice |
|---|---|
| Gate placement | Before reviewer; fail skips reviewer, feedback straight to implementer |
| Command source | Per-run user input, authoritative; static project detection prefills |
| Retry semantics | Shares the Implement→Review cycle budget (single cap, default 3) |
| Failure feedback | Canonical review JSON/md: one `critical` issue with command, exit code, output tail |
| Architecture | Synthetic verifier node, dynamically inserted at resolve time (not an orchestrator hook, not prompt-level) |

## 1. Config & input surface

- **CLI:** repeatable `--validate "<command>"` flag
  (e.g. `--validate "npm test" --validate "npm run lint"`).
- **UI:** optional "Validation commands" textarea on the run-start form, one
  command per line, prefilled by detection (see below).
- **Persistence:** commands ride the pipeline run record via orchestrator
  constructor opts (per-run, like existing per-run fields) so pause/resume and
  rerun keep them. Not stored in project config.
- **Timeout:** one global default of 10 minutes per command. No further knobs.

### Static detection (prefill only)

At run-start, maestro probes the project — `package.json` `scripts.test`,
`Makefile` test target, `pytest.ini`/`pyproject.toml`, `Cargo.toml` — and
prefills the UI field / prints a CLI suggestion. Pure static file inspection, no
LLM. The user's input is always authoritative; detection never auto-enables the
gate.

## 2. Topology insertion

- New registry entry `shellGate` — meta.json **only**, no `.md` prompt, never
  spawns Claude: `runnerType:"verifier"`, `loopSource:true`,
  `consumes:["code"]`, `produces:["review"]`, `fanOut:false`.
- At `resolveWorkflow` time, when the run has validation commands: insert step
  `s_gate` immediately **after the implementer, before the reviewer**, plus
  feedback edge `fb_gate: s_gate → implementer`.
- Insertion is anchored to the existing review feedback edge's target
  (`fb_review.to`, i.e. the implementer node), so it generalizes to custom
  workflows that have an implementer-like producer followed by a verifier.
- If the active workflow has **no** review-style feedback edge to anchor on
  (e.g. topologies without an implement/review loop), the gate is not inserted
  and the run emits a warning log so the user knows their `--validate` input was
  ignored.
- `DEFAULT_WORKFLOW` and seeded workflow rows are untouched (ARCHITECTURE §5.8:
  DEFAULT_WORKFLOW stays code). The workflow validator must accept the inserted
  topology (back-edge target precedes source — already legal).

## 3. Execution semantics (`runShellGate`)

New runner branch in `verifier()` (runners.mjs) dispatching on key `shellGate`
→ `runShellGate(ctx)` in phases.mjs:

- Runs commands **sequentially** via `sh -c`, cwd = project worktree.
- Streams stdout/stderr as `log` events (live in UI).
- First non-zero exit stops the sequence → fail.
- **Pass:** writes review JSON `{issues:[], summary:"validation passed: <commands>"}`
  → verdict `ok` → reviewer runs next.
- **Fail:** writes canonical review (md + json): one **critical** issue —
  title `Validation failed: <command>`, detail = exit code + last ~200 lines of
  merged stdout+stderr. Verdict `blocked` → orchestrator rewinds to the
  implementer, which binds the review path and enters FIX mode. The implementer
  prompt requires zero changes.
- Review artifacts named `shellGate-review-cycleN.{md,json}` in the pipeline
  dir (custom-verifier default from `channels.allocate`); the reviews table
  `kind` is an open set, so the verdict persists as `shellGate-review` with no
  schema change (ARCHITECTURE §5.3 note only).

## 4. Cycle-cap sharing

Feedback edges carry per-edge cycle counters today; two naive edges would allow
up to 2× the intended cycles. Therefore:

- `fb_gate` and `fb_review` declare a shared loop group: `loopGroup:"impl"`.
- The orchestrator keys the cycle counter by `loopGroup` when set, falling back
  to the edge id when absent (backward compatible).
- Budget stays `max_cycles` from `config_workflow_feedbacks` (default 3), one
  budget for the whole implement loop regardless of which edge fires.
- Cap overflow → existing `_gate` → `_ask` human question, unchanged. Auto mode
  auto-continues, unchanged.

## 5. Events / UI

- Gate node emits standard `phase` events (`start|done|error`) — UI progress
  shows it as a normal phase, no bespoke UI code.
- Command output → `log` events; review files → `artifact` events.

## 6. Error handling

- Spawn error / command not found → fail with critical issue (detail = error message).
- Timeout → kill the process tree, fail with `timed out after <N>s`.
- The gate never crashes the pipeline: any internal error degrades to a blocking
  review that the existing loop handles.

## 7. Testing

- **Unit (`runShellGate`):** `exit 0`, `exit 1`, timeout via sleep, missing
  binary → assert review JSON shape and verdict status.
- **Resolve-time:** workflow with/without commands → node inserted/absent;
  validator accepts inserted topology; loopGroup counter shared across both edges.
- **Integration (mock Claude runner):** full pipeline — implement → gate fail →
  implementer FIX mode consuming the gate review → gate pass → reviewer runs.
  Assert one cycle consumed per gate failure, shared with review cycles.
- **Detection:** fixture projects (package.json / Makefile / pytest / cargo) →
  correct prefill; no fixture → empty prefill.

## Out of scope

- Planner-proposed validation commands (rejected: LLM guessing shell commands is
  an injection-ish surface; resolve-time ordering pain).
- Per-command timeout/retry configuration.
- Goose recipe export, response-schema enforcement, alternate runner backends
  (separate ideas from the same analysis).
