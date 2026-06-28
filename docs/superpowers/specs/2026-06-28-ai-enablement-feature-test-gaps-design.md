# AI-Enablement Onboarding pipeline: close the feature-skill and test-seeding gaps

Date: 2026-06-28
Status: approved (brainstorming) — pending implementation plan

## Problem

The AI-Enablement Onboarding pipeline was run on `bevup-admin` (branch
`maestro/enable-the-project-for-ai-c6cf4025`, commit `8d1efef`). Two gaps surfaced in the
output:

1. **Feature-skill under-generation.** The project has 7 distinct feature domains (menu,
   orders, cities, users, venues, support, delete-requests) plus cross-cutting surfaces
   (Cloud Functions callables, catalog pages, storage-ref resolution, API routes). The
   pipeline authored exactly **one** project-specific skill (`add-firestore-entity`,
   data-layer only). High-footgun recurring surfaces — e.g. the documented `us-central1`
   callable rule, the repeated catalog-page convention — got no skill.

2. **Testing skills present, zero real tests.** Three of four vendored skills are
   process/testing (`test-driven-development`, `systematic-debugging`,
   `verification-before-completion`), yet the only test authored was an assertion-free
   placeholder (`expect(true).toBe(true)`). The cheapest high-value tests — pure data-layer
   units like `src/lib/money.ts` formatting and the lenient `parse*` functions — were never
   seeded. `jsdom` was not installed, so component tests are blocked from day one.

### Root causes (located in the pipeline source)

- **Infra-gen** (`agents/maestro-project-onboarding.md`, Phase 3) hard-caps skills:
  *"Maximum 3 skills; most projects warrant 0–2."* Combined with the absence of any
  structured "what repeats here" evidence, infra-gen has nothing to anchor feature-skill
  generation on and defaults conservative.
- **Analyzer** (`agents/maestro-onboarding-analyzer.md`) emits a project-understanding
  summary with no field for *recurring multi-file patterns* or *pure testable units* — the
  exact signals infra-gen and test-gen need.
- **Test-gen** (`agents/maestro-onboarding-tests.md`) default tier is `scaffold`, which by
  definition writes one assertion-free sample and no real tests.
- The skill-vendor allowlist (`src/core/skill-vendor.mjs`) is **not** the cause: it only
  gates *copies of pre-existing named skills*. Authored project skills bypass it entirely.

## Goals

- Make the pipeline detect recurring feature surfaces and author a skill per high-ROI
  surface, grounded in real repetition evidence (resists both under-generation and bloat).
- Make every run ship at least a few **real, passing** tests over pure units, regardless of
  the selected test tier, and pre-wire the DOM test environment for React/DOM stacks.
- Have the evaluator measure and (where appropriate) enforce both, so the feedback loop can
  fire on a genuine shortfall.

## Non-goals

- No new pipeline node / topology change. The feedback edge (`s_eval → s_infra`) is
  unchanged.
- No change to the skill-vendor security model or allowlist.
- No attempt to author a skill for every domain mechanically — generation stays
  evidence-gated and ROI-filtered.

## Design

The pipeline's per-agent contracts (summary JSON shape, readiness dimensions) are **prose
conventions inside the agent prompt `.md` files**, not code-validated schemas. Verified:
`src/core/channels.mjs` only plumbs artifact paths; `src/core/protocol.mjs#hasBlocking`
gates the loop purely on issue *severity*, shape-agnostic; no code asserts the contents of
`graph`/`readiness` JSON. Therefore this work is almost entirely prompt engineering.

### 1. Analyzer — emit repetition evidence

File: `agents/maestro-onboarding-analyzer.md`.

Add two fields to the summary JSON the analyzer produces, and add Method steps that
populate them from the graph (or the degraded direct read):

- `skillCandidates`: recurring multi-file patterns worth a skill, ranked by
  `frequency × footgun`. Each entry:
  ```json
  { "name": "add-callable", "surface": "Cloud Functions callable",
    "frequency": 4, "footgun": "wrong region silently breaks",
    "exampleFiles": ["src/lib/callables/digitize-menu.ts"],
    "whySkill": "repeated multi-step pattern with a non-obvious region rule" }
  ```
  Detection heuristic (stated in the prompt): N ≥ 2 files following the same structural
  shape, or a documented hard-rule that recurs across call sites.
- `pureUnits`: high-ROI pure/testable units — zero external deps, deterministic, easy to
  assert (formatters, parsers, validators, pure helpers). Each entry:
  ```json
  { "file": "src/lib/money.ts", "symbol": "formatMoneyAmount",
    "why": "pure cents→string, no I/O — ideal first test" }
  ```

Update the analyzer's Output Contract to mention both. Keep the existing degrade-on-graphify-
failure policy: both fields are best-effort and may be empty when degraded.

### 2. Infra-gen — evidence-gated skill generation

File: `agents/maestro-project-onboarding.md`, Phase 3 ("ROI selection") and the report.

- Replace the fixed cap *"Maximum 3 skills; most projects warrant 0–2"* with:
  > Author one skill per `graph.skillCandidates` entry that clears the ROI bar (recurring,
  > multi-step, non-obvious, project-specific). There is no fixed cap — but every authored
  > skill MUST trace to a candidate backed by real repetition evidence. Do not invent a
  > skill with no repetition behind it; a one-command pattern still belongs in CLAUDE.md.
- Keep the anti-bloat ROI filter and the "every line must change agent behavior" framing.
- Add a **Skill coverage** table to the Output Contract report: each `skillCandidate` →
  `authored` / `folded into CLAUDE.md` / `skipped (reason)`. This forces honest accounting
  and gives the evaluator something to score against.
- Standalone fallback (graph absent) is unchanged: with no `skillCandidates`, infra-gen
  falls back to its own Phase 1–2 inventory and the prior conservative judgment.

### 3. Test-gen — always seed real pure-unit tests

File: `agents/maestro-onboarding-tests.md`.

- Add a **tier-independent** rule (applies even at `docs-only`/`scaffold`): write 2–3 real,
  asserting tests over `graph.pureUnits` (pick the highest-ROI units), and RUN them. The
  sample/template file stops being assertion-free — the seeded tests ARE the copy-me
  examples. If `pureUnits` is empty (or degraded with none found), fall back to the current
  placeholder and say so in the report.
- **jsdom pre-wire:** when the stack is React/DOM (`graph.stack.framework` indicates
  React/Next or DOM testing is plausible), add `jsdom` to devDependencies and wire the test
  config so component tests are not blocked. Node-env data-layer tests remain the default.
- Reword the tier descriptions so `scaffold` reads as "toolchain + real pure-unit tests"
  rather than "one sample with no real assertions."

### 4. Evaluator — measure and enforce

File: `agents/maestro-onboarding-evaluator.md`.

- Add two rubric dimensions to the AI-readiness score and the `readiness.dimensions` JSON:
  - `featureSkillCoverage` — authored skills vs `graph.skillCandidates` that cleared the
    bar, read from infra-gen's Skill-coverage table. **Soft:** contributes to the /100
    score; does NOT by itself emit a blocking issue (prevents loop-thrash / bloat pressure).
  - `realTests` — are there real, passing tests over pure units? **Hard:** emit a
    `critical` issue (which fires the existing `s_eval → s_infra` loop) when `graph.pureUnits`
    is non-empty but no real test runs / passes. Consistent with the evaluator's other HARD
    self-eval checks (broken frontmatter, failing CLAUDE.md command).
- Extend the `readiness.dimensions` JSON shape in the prompt to include both keys.
- No code change: the loop already fires on any `critical` issue via `hasBlocking`.

### 5. skill-vendor.mjs — no change

Documented here to record the decision: authored feature skills do not pass through
`resolveVendorTargets`, so the allowlist neither helped nor hurt feature coverage. Left
untouched.

## Affected files

| File | Change |
|------|--------|
| `agents/maestro-onboarding-analyzer.md` | add `skillCandidates` + `pureUnits` to summary JSON + Method + Output Contract |
| `agents/maestro-project-onboarding.md` | Phase 3 cap → evidence-gated; add Skill-coverage table to report |
| `agents/maestro-onboarding-tests.md` | always-on pure-unit test seeding; jsdom pre-wire; tier rewording |
| `agents/maestro-onboarding-evaluator.md` | `featureSkillCoverage` (soft) + `realTests` (hard) dimensions; readiness JSON shape |

No changes to `src/core/*` (channels, protocol, builtin-workflows topology, skill-vendor).

## Verification

Prompt edits are not unit-testable the way code is. Verification plan:

1. **Static review** of each edited prompt for internal consistency (the field a downstream
   agent reads is the field the upstream agent now emits — `skillCandidates`/`pureUnits`
   names match across analyzer → infra-gen / test-gen → evaluator).
2. **Existing maestro tests stay green** (`evaluator-gate`, `phases-generic-io`,
   `channels-onboarding`, `workflow-onboarding-topology`) — none assert the JSON contents,
   so they should be unaffected; run them to confirm.
3. **End-to-end re-run** of the onboarding pipeline against a sample repo (bevup-admin is
   the natural regression target) and inspect: the readiness card now reports
   `featureSkillCoverage` and `realTests` dimensions; more than one feature skill is
   authored where candidates exist; the seeded tests actually run and pass; jsdom is wired.

## Open questions

None outstanding. Enforcement strength was decided: feature-skill coverage soft, real-tests
hard. No fixed cap on authored skills (evidence-gated instead).
