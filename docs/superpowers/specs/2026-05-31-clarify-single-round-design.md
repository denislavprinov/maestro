# Clarify Single-Round — Design

**Date:** 2026-05-31
**Status:** Approved (brainstorm) — ready for implementation plan

## Problem

The "planning agent cycles 3 times." That is the **clarify loop**, not the plan
write. `orchestrator.mjs:_clarifyLoop()` re-runs the planner in *clarify* mode up
to `maxClarifyCycles` (default **3**) rounds, asking a fresh batch of questions
each round; it only stops early when the planner returns `{ questions: [] }`. The
recent commits + `CLARIFY-LOOP-FIX-PLAN*.md` only *reduced* the re-asking (feed
prior answers back, cap questions at 4, expose `--max-clarify`); they did not
change the multi-round model.

The user wants a clean, single-pass model for the front of the pipeline.

## Current pipeline (for reference)

```
preflight
  -> clarify loop      (planner, UP TO 3 rounds)      <- the cycling complained about
  -> plan              (planner, 1x)                  already single-pass
  -> refine loop       (refiner; until no blocking; gate at maxRefine=5)
  -> implement         (implementer, 1x)              already single-pass
  -> review loop       (reviewer + fix; until no blocking; gate at maxReview=5)
  -> done
```

`implement 1x`, `refine loop`, and `review loop` **already match** what the user
described. The only mismatch is the clarify rounds.

## Desired behavior

```
preflight
  -> clarify           (planner, EXACTLY 1 round; up to 4 questions; skip if none)
  -> plan              (planner, 1x)
  -> refine loop       (UNCHANGED — until no blocking; gate at maxRefine=5)
  -> implement         (UNCHANGED — 1x)
  -> review loop       (UNCHANGED — until no blocking; gate at maxReview=5)
  -> done
```

### Decisions (from brainstorm)

1. **Clarify runs exactly once.** Hard cap = 1 round. No re-ask loop. The single
   round still asks up to 4 questions (existing `normalizeClarify` cap stays).
2. **Zero questions → skip straight to plan.** If the planner returns no
   questions, do not prompt the user; proceed to the plan write. (Current
   behavior, preserved.)
3. **Remove `--max-clarify`.** With a hard 1-round model the flag controls
   nothing, so strip it from CLI, UI server, orchestrator, and its tests
   (Approach A). It was added only to tame the loop we are now deleting.
4. **Refine and review loops are untouched** — keep looping until no blocking
   issues, keep the user gate at the `maxRefine` / `maxReview` cap (default 5).

## Approach

Surgical. Collapse one loop, delete one flag's plumbing. Do **not** touch
`phases.mjs` — `buildClarifyPrompt` / `runPlannerClarify` stay intact as pure,
still-tested functions. Their prior-answers branch simply becomes unreachable
from the orchestrator (the orchestrator always calls them with `round: 1`,
`priorAnswers: []`). Leaving them in place keeps the diff small and low-risk.

### Components changed

**`src/core/orchestrator.mjs`**
- Replace the `while (round < maxRounds)` body of `_clarifyLoop()` with a single
  pass: run `runPlannerClarify({ round: 1, priorAnswers: [] })`; if questions is
  empty, audit "no questions" and return `[]`; otherwise emit the clarify
  question, normalize + persist answers, audit, return them. Rename to
  `_clarify()` to reflect it is no longer a loop (keep a one-line comment noting
  the single-round contract).
- Remove the `maxClarifyCycles` field and its constructor default (`numOr(...
  3)` at line 83) and the `@param maxClarifyCycles` jsdoc.

**`src/cli/maestro.mjs`**
- Remove `maxClarify: undefined` (line 39), `--max-clarify` from `takesValue`
  (56) and `map` (69), the `maxClarify` arm of the numeric-coerce branch (107),
  the `--max-clarify` help line (151), and `maxClarifyCycles: flags.maxClarify`
  in the `createOrchestrator` call (347).

**`ui/server.mjs`**
- Remove `const maxClarifyCycles = clampInt(body.maxClarify, 3);` (218) and the
  `maxClarifyCycles,` property passed to `createOrchestrator` (235). No
  front-end input exists for it, so no HTML/JS change.

**`test/clarify.test.mjs`**
- Remove the `maxClarifyCycles defaults to 3 and is overridable` test (lines
  ~61–64) and the `CLI advertises --max-clarify in help` test (~82–86).
- **Keep** the `buildClarifyPrompt` and `runPlannerClarify` convergence/cap
  tests — they exercise `phases.mjs`, which is unchanged and still valid.
- Add one test asserting the orchestrator runs clarify exactly once: with a mock
  planner that always returns questions, the pipeline must emit exactly one
  `clarify` question (no round 2). Prefer an orchestrator-level assertion over a
  loop-internal one.

## Data flow

Unchanged except the front segment. `_clarify()` returns the same
`collected` answers array shape (`[{ id, question, choice }]`) that
`runPlannerPlan` already consumes via its `answers` param. No protocol or
artifact-format change. `clarify.json` is still written once.

## Error handling

No new failure modes. Abort checks (`_checkAbort`) around the clarify run and the
question await stay as they are today. If the planner write fails / returns
malformed JSON, `readClarify` behavior is unchanged.

## Testing

- `npm test` (node:test) — adjusted clarify tests pass; new single-round
  assertion passes.
- `npm run smoke` (`MAESTRO_MOCK=1`, `--yes`) — full offline pipeline runs end
  to end with one clarify round, then plan → refine → implement → review → done.

## Out of scope / YAGNI

- No change to refine/review loop logic, gates, or their caps.
- No change to `phases.mjs` clarify prompt machinery (left as dead-but-tested
  code rather than ripped out — lower risk; revisit only if it later confuses).
- No new flag to re-enable multi-round clarify.

## Symptom → fix map

| Symptom | Fix |
| --- | --- |
| Planner asks questions across up to 3 rounds | `_clarify()` runs the planner once |
| `--max-clarify` flag exists but model is now fixed | Flag + plumbing removed (CLI, UI, orchestrator, tests) |
| Confusion that implement/review "cycle" wrongly | None — those already match desired (documented for clarity) |
