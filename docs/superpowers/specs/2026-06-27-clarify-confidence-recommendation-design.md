# Clarify questions: confidence percentages + recommendation

**Date:** 2026-06-27
**Status:** Approved design, pre-implementation

## Problem

During pipeline execution Maestro's Clarify agent asks the user a set of
multiple-choice questions before planning. Today each option is a bare string and
the user gets no guidance about which option the agent leans toward. We want the
agent to express, per question, a confidence split across the options and an
explicit recommendation, surfaced in both the web UI and the CLI.

## Decisions (locked)

- **Percentage meaning:** confidence split — the agent's confidence that each
  option is the right call, normalized to sum to 100 across that question's
  options.
- **Recommendation:** an explicit field the agent sets (decoupled from the
  numbers, so it can recommend a near-tie option). Falls back to the
  max-confidence option when the agent supplies confidence but no recommendation.
- **Scope:** the pre-plan Clarify questions only (`clarify.json` from
  `maestro-clarify`). Mid-cycle loop gates are unchanged.
- **Preselect:** the recommended option starts selected, so an empty submit takes
  the recommendation. The user can change it.
- **Granularity:** per-question — some questions in a set may carry
  confidence/recommended while others don't; each renders independently.
- **Back-compat:** both new fields are optional. A question without them renders
  exactly as today.

## Schema

Per-question canonical shape produced by `protocol.normalizeClarify`
(`src/core/protocol.mjs`) gains two optional fields:

```json
{
  "id": "auth-storage",
  "question": "Where should sessions be stored?",
  "options": ["Redis", "Postgres", "In-memory"],
  "allowFreeText": true,
  "confidence": [60, 30, 10],
  "recommended": "Redis"
}
```

- `confidence`: array of integers aligned 1:1 with `options`, summing to 100.
  Present only when the agent supplied usable numbers.
- `recommended`: a string equal to one of the (surviving) `options`. Present only
  when valid.

Answers are unchanged: `{ id, choice }`. No DB migration — the questions JSON row
carries the new fields automatically.

## Normalization rules (`normalizeClarify`)

The current function trims/filters blank options and caps at
`MAX_CLARIFY_OPTIONS` (4). New behavior:

1. **Zip then filter.** Pair each option with its confidence entry (if a
   `confidence` array of matching length exists) BEFORE dropping blanks and
   capping at 4. This guarantees option↔confidence alignment survives filtering.
2. **Validate confidence.** Require `confidence` to be an array whose length
   equals the raw `options` length and whose entries are all finite numbers. On
   any mismatch, drop `confidence` entirely (graceful → no bars).
3. **Renormalize to 100.** After filtering, coerce kept confidences to
   non-negative numbers, scale to sum 100, round to integers, and assign any
   rounding remainder to the largest entry so the displayed values sum to exactly
   100. If the kept confidences sum to 0, drop `confidence`.
4. **Resolve recommended.**
   - If `recommended` is a string matching a surviving option, keep it.
   - Else if `confidence` is present, default `recommended` to the
     max-confidence surviving option (first one on ties).
   - Else omit `recommended`.
5. Existing caps still apply (max 8 questions, max 4 options).

Output remains parallel arrays (`options`, `confidence`) plus the `recommended`
string — no nested option objects — so every existing string consumer
(`normalizeClarifyAnswer`, history readers, answer matching by string) is
untouched.

## Agent prompt (`agents/maestro-clarify.md`)

Add to the question rules: each question MAY include `confidence` (an array of
integers aligned to `options`, summing to 100, expressing how confident you are
that each option is the right call) and `recommended` (the single option string
you would pick). Include them when you have a genuine lean; omit both when you
truly have no basis to prefer one option. Update the JSON example to show the
fields and update the output-contract reminders to mention they are optional and
that `confidence` must align with `options` and sum to 100.

## Web UI (`ui/public/app.js`, `renderClarifyBody`)

For each question, after building the option buttons:

- If `q.confidence` is present (aligned to the filtered options):
  - Each `.qopt` button shows its `NN%` and a thin horizontal confidence bar
    (width = the percentage). Styling via existing CSS conventions in the panel.
  - The option equal to `q.recommended` gets a "Recommended" badge.
  - **Preselect** the recommended option: set its `.sel`/`aria-pressed` state and
    `slot.choice` to that option on render, mirroring a user click (clears the
    free-text field). The user can still pick another option or type free text.
- If `q.confidence` is absent, render exactly as today (no bars, no badge, no
  preselect).

Selection/clearing logic (option click clears siblings + free text; typing clears
options) is unchanged.

## CLI (`src/cli/maestro.mjs`, `askClarify`)

When printing options for a question that has aligned `confidence`:

- Suffix each option line with ` — NN%`.
- Append ` (recommended)` to the recommended option's line.
- Empty input still defaults to the first option today; when `recommended` is
  present, default an empty answer to the recommended option instead (matches the
  web preselect behavior).

Questions without confidence print as today.

## Persistence

No schema/migration change. `phases.runClarify` /
`orchestrator._writeClarifyAnswers` persist the normalized questions JSON, which
now includes `confidence`/`recommended` when present. Answers remain
`[{id, choice}]`.

## Testing

`test/clarify.test.mjs` (and/or protocol tests) cover `normalizeClarify`:

- Confidence aligned to options after blank-option filtering (zip-then-filter).
- Renormalization to sum exactly 100, including rounding-remainder assignment.
- Drop `confidence` on length mismatch or non-numeric entries.
- Drop `confidence` when entries sum to 0.
- `recommended` kept when it matches a surviving option.
- `recommended` defaulted to max-confidence option when omitted but confidence
  present; omitted when no confidence.
- A mixed set (one question with confidence, one without) normalizes
  independently.

UI and CLI rendering are covered by existing manual-verification conventions for
those layers; add a focused unit test for any pure helper extracted (e.g. a
percentage/bar formatter) if one is introduced.

## Out of scope

- Loop/cycle gate prompts.
- Any change to the answer payload shape or DB schema.
- Persisting or learning real popularity priors (the percentage is the agent's
  confidence, not usage data).
