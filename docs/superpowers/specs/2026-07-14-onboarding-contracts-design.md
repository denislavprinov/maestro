# Onboarding pipeline: schema-validate the LLM-written JSON contracts

Date: 2026-07-14
Status: approved (brainstorming) — pending implementation plan
Branch: `feat/onboarding-contracts` (off `enable-app`)

## Problem

The onboarding pipeline's data contracts are prose conventions inside agent
`.md` prompts, not code-validated schemas. Core never reads back what the
LLM wrote:

- `readiness.json` (the product-facing card the Enable app renders) is written
  by the evaluator agent and trusted as-is — `runGenericVerifier`
  (`src/core/phases.mjs`) reads back only the review JSON (`readReview`,
  `protocol.mjs`). A malformed or missing readiness card fails silently: the
  Enable app's null-tolerant readers (`readFinalReadiness`,
  `src/core/onboarding.mjs`) just return null.
- `graph-summary.json` (what infra-gen, test-gen, and the evaluator ground
  on: `skillCandidates`, `pureUnits`, `baselineReadiness`, `stack`,
  `degraded`) is likewise written by the analyzer and never validated. A
  renamed field silently degrades every downstream agent.
- `delta`, `baselineScore`, and all 9 dimension scores are LLM-computed;
  nothing cross-checks `delta = score − baselineScore`.

A prompt edit that renames `skillCandidates` or drops a dimension key breaks
scoring with zero errors anywhere.

## Decisions (user-confirmed)

1. **Policy: repair + warn; fail only when unusable.** Normalize what code
   can fix (recompute delta, clamp scores, default missing arrays), log each
   repair as a warning. Hard-fail the node (existing recoverable-error gate)
   only when the artifact is unusable: unparseable JSON or no usable numeric
   `score` in readiness.json / non-object graph summary.
2. **Scope: `readiness.json` + graph summary.** Review-JSON hardening and
   clarify.json validation are out of scope (review already has `readReview`;
   clarify answers are engine-normalized).
3. **Branch: `feat/onboarding-contracts` off `enable-app`** — the canonical
   newest onboarding core. Other branches' enable state is stale (see
   memory: 2026-07-14 near-duplicate incident).
4. **Approach: hand-rolled normalizer module, hooked in the generic
   runners.** No new dependencies (matches `workflow-validator.mjs` style).
   Rejected: ajv/JSON-Schema (new dep, can't repair, only reject);
   read-time-only hardening (doesn't fix the file on disk, doesn't catch
   drift at the source).

## Design

### 1. Contract module — `src/core/onboarding-contracts.mjs`

Pure functions, no I/O. Each returns `{ ok, value, warnings }`:
`ok:false` means fatal (unusable); `warnings` is a string array describing
every repair performed; `value` is the normalized object (present only when
`ok:true`).

- `DIMENSION_KEYS` — the 9 readiness dimension keys
  (`docs, skillsAgents, rules, tests, featureSkillCoverage, realTests,
  vendoring, multiTool, codeHealth`), exported as the single source of truth.
  A parity test asserts they equal `Object.keys(DIMENSION_LABELS)` from
  `src/core/onboarding.mjs` so the two cannot drift.

- `normalizeReadiness(raw)`:
  - **Fatal:** `raw` is not a plain object, or `score` has no usable numeric
    value (numeric strings are coerced first; `"93"` → 93 with a warning).
  - Repairs (each warned):
    - `score` clamped to 0–100.
    - `baselineScore` → number-or-null (coerce numeric strings; anything
      else → null).
    - `delta` **recomputed in code**: `score − baselineScore` when baseline
      is numeric, else null. Warn when a stored delta differed from the
      recomputed value; the recomputed value always wins.
    - `dimensions`: exactly the 9 `DIMENSION_KEYS`. Each value coerced to a
      clamped 0–100 number or null (the N/A convention). Missing key →
      null + warn. Unknown key → dropped + warn. Missing/non-object
      `dimensions` → all-null object + warn.
    - `gaps` → array of strings (non-strings stringified or dropped with a
      warn); missing/non-array → `[]` + warn.
  - Unknown top-level fields are dropped with a warning (the canonical card
    has exactly `score, baselineScore, delta, dimensions, gaps`).

- `normalizeGraphSummary(raw)`:
  - **Fatal:** `raw` is not a plain object.
  - Repairs (each warned):
    - `skillCandidates` → array; non-object entries dropped + warn;
      per-entry: `name`/`surface`/`footgun`/`whySkill` coerced to strings,
      `frequency` coerced to number (else null), `exampleFiles` → string
      array (default `[]`). Missing/non-array field → `[]` + warn.
    - `pureUnits` → array of `{file, symbol, why}` strings, same
      drop-and-warn treatment; missing → `[]` + warn.
    - `baselineReadiness`: optional (absent stays absent, no warn — degraded
      runs legitimately omit it). When present: `score` → clamped
      number-or-null; `dimensions` normalized with the same 9-key rule;
      `note` → string.
    - `degraded` → boolean (missing → false + warn).
    - `stack` missing/non-object → `{}` + warn.
    - All other prose fields (`domain`, `architecture`, `conventions`,
      `gotchas`, `entryPoints`, `codeHealth`, `criticalFlows`, `graphDir`)
      pass through untouched — they are consumed by LLMs, not code; the
      schema guards only what code and scoring depend on.

### 2. Hook — generic runners in `src/core/phases.mjs`

One helper, `validateContractOutputs(ctx)`, with an internal map of channel
id → `{ pathOf(outputs), normalize }`:

- `readiness` → `ctx.outputs.readiness?.jsonPath`, `normalizeReadiness`
- `graph` → `ctx.outputs.graph?.path` (the summary JSON, not the
  `graphify-out/` dir), `normalizeGraphSummary`

Called after the agent run completes in **both** `runGenericVerifier` (before
its return — the evaluator produces `readiness`) and `runGenericProducer`
(the analyzer produces `graph`). For each declared output channel that has a
validator:

- **File missing** → `console.warn` only. Preserves mock/legacy behavior and
  the null-tolerant reader contract; absence is visible but not fatal.
- **File present, unparseable JSON or fatal-invalid** → throw
  `Error('[contracts] <channel>: <reason> (<path>)')` → surfaces through the
  existing recoverable-error gate machinery, like any other node failure.
- **Repairs performed** (`warnings.length > 0`) → rewrite the file in place
  with the normalized JSON (2-space indent) so every downstream consumer
  (evaluator reading the graph, Enable app readers, history) sees the
  canonical shape; log each warning as
  `console.warn('[contracts] <channel>: <warning>')`.
- **Clean** → leave the file byte-identical (no rewrite when `warnings` is
  empty).

No changes to `channels.mjs`, `protocol.mjs`, agent prompts, workflow
topology, or the Enable app.

### 3. Testing

- New `test/onboarding-contracts.test.mjs` — pure unit tests:
  - happy path: canonical readiness/graph objects pass with zero warnings,
    value deep-equals input.
  - delta mismatch repaired (stored 60, recomputed 65 → 65 + warning).
  - numeric-string score coerced; score >100 clamped.
  - missing dimension key → null + warn; unknown dimension dropped + warn.
  - gaps garbage → `[]` + warn.
  - fatal: non-object, missing score, `score: "high"`.
  - graph: non-object skillCandidate entry dropped; missing pureUnits → `[]`;
    baselineReadiness absent → no warn; degraded coerced.
  - parity: `DIMENSION_KEYS` ≡ `Object.keys(DIMENSION_LABELS)`.
- Runner-hook tests (extend the existing mock-runner pattern used by
  `test/phases-generic-io.test.mjs` / evaluator-gate):
  - mock verifier writes a repairable readiness.json → after the node, the
    file on disk is normalized and a `[contracts]` warning was logged.
  - mock verifier writes unparseable readiness.json → node fails (error
    propagates to the recoverable-error path).
  - readiness.json absent → node succeeds, warning logged.
- Existing suites stay green: `onboarding-api`, `phases-generic-io`,
  `evaluator-gate`, `channels-onboarding` (baseline verified 19/19 on this
  worktree before any change).

## Affected files

| File | Change |
|------|--------|
| `src/core/onboarding-contracts.mjs` | new — `DIMENSION_KEYS`, `normalizeReadiness`, `normalizeGraphSummary` |
| `src/core/phases.mjs` | add `validateContractOutputs(ctx)`; call it at the end of `runGenericProducer` and `runGenericVerifier` |
| `test/onboarding-contracts.test.mjs` | new — unit + parity tests |
| `test/phases-generic-io.test.mjs` (or a new sibling) | runner-hook tests |

## Non-goals

- Review-JSON schema hardening (severity vocabulary, `score` field) — later.
- clarify.json validation.
- Changing any agent prompt, threshold, or topology.
- Validating prose fields LLMs consume (domain/architecture/…) — passthrough.

## Open questions

None.
