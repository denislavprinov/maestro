# Onboarding: mandatory/optional tools + open-task execution — Design

Date: 2026-07-14
Status: approved (pending spec review)

## Goal

Three additions to the enable onboarding pipeline:

1. **Mandatory tools** (graphify, caveman, …) are always installed into the target repo and are visible to the user on the results screen after enablement completes.
2. **Optional tools** are offered as suggestions — at clarify time (user picks upfront) and on the results screen (one-click vendor after completion).
3. **Open tasks** identified by the evaluator (`gaps[]`) are executed by a new opt-in pipeline step, with an honest re-score afterwards.

## Decisions (clarified with user)

- Install target: **target repo only** — vendor into the onboarded repo's `.claude/skills/` via the existing skill-vendor mechanism. No user-global (`~/.claude`) mutation.
- Suggestions appear **both** at clarify (checkbox question) and on the results screen (suggested-tools section with vendor button).
- Suggestion source: **curated catalog + analyzer** — fixed curated optional list at clarify; analyzer `skillCandidates[]` (allowlist-filtered) merged into results-screen suggestions.
- Task execution: **opt-in post-eval step** gated by a clarify question (on/off + max task count), running on the enable branch.
- Re-scoring after execution: **option (a)** — feedback edge `s_execute → s_eval`, gated on `completed > 0`, max 1 iteration. Evaluator re-scores honestly.

## Current state (anchors)

- Workflow `ENABLE_WORKFLOW`: clarify → analyze → infra → tests → eval → canary, with feedback loop `fb_eval` (eval → infra, gated `hasBlocking`) — `src/core/onboarding.mjs:16-29`.
- Skill vendoring policy: `CURATED_BASELINE` (always vendored; includes graphify) and `CURATED_ALLOWLIST` in `src/core/skill-vendor.mjs:8-16`. Membership — not physical location — is the gate; infra agent does the physical copy.
- Skill resolution: `resolveSkill` (bundle/global/project) in `src/core/skills.mjs`.
- JSON contracts: pure normalizers in `src/core/onboarding-contracts.mjs` (`{ ok, value, warnings }`, repair+warn, hard-fail only when unusable), wired via `validateContractOutputs(ctx)` in `src/core/phases.mjs`.
- Results UI: `renderResults(r)` in `apps/enable/public/app.js:715-757`; gaps → TODO.md button via `POST /api/enable/todo` (`apps/enable/server.mjs:463-490`).
- No UI shows which tools were installed; `skillCandidates[]` is consumed by infra-gen but never surfaced; gaps are report-only.

## §1 Mandatory tools — install + visibility

- Add `caveman` to `CURATED_BASELINE` in `src/core/skill-vendor.mjs`. The baseline IS the mandatory list; it is already unioned into every vendor set by `resolveVendorTargets`.
- Caveman is a plugin skill. Extend skill resolution in `src/core/skills.mjs` with a **plugin-cache source**: `~/.claude/plugins/cache/**/skills/<name>/`. Resolution order: bundle → project → global → plugin cache. Vendoring remains allowlist-gated — plugin-cache lookup never copies a name outside `CURATED_ALLOWLIST`.
- New contract in `src/core/onboarding-contracts.mjs`: `normalizeToolsReport(raw)` for a new `tools.json` artifact written by the infra agent (`agents/maestro-project-onboarding.md` gains an Outputs entry, channel `tools`).

  ```json
  {
    "installed": [{ "name": "graphify", "source": "plugin|bundle|global|project", "mandatory": true }],
    "skipped":   [{ "name": "some-skill", "reason": "not in allowlist" }],
    "suggested": [{ "name": "writing-plans", "reason": "…", "source": "catalog|analyzer" }]
  }
  ```

  Normalizer policy matches siblings: repair + warn; fatal only if not an object. `installed`/`skipped`/`suggested` coerced to arrays of shaped objects; unknown entries dropped with warnings; `mandatory` derived from `CURATED_BASELINE` membership if absent.
- `validateContractOutputs` in `src/core/phases.mjs` gains the `tools` channel (producer side, infra step). Missing file → warn only (backward compatible with old runs).
- Results screen: new **"Installed tools"** section rendered from `tools.json` (served alongside readiness), mandatory badge for baseline members. Data reaches the client via the final readiness event payload (extend `readFinalReadiness` composition in `src/core/onboarding.mjs` to attach `tools` when `tools.json` exists) — history replay works unchanged.

## §2 Clarify additions

`agents/maestro-enable-clarifier.md` grows from 5 to 7 questions; `clarify.json` contract extended (normalizer updated in `onboarding-contracts.mjs` if one exists for clarify; otherwise fields documented in the agent Outputs schema):

- **Q6 `optionalTools`**: multi-select from new `OPTIONAL_CATALOG` (exported from `src/core/skill-vendor.mjs`): `writing-plans`, `executing-plans`, `requesting-code-review` (i.e. `CURATED_ALLOWLIST − CURATED_BASELINE`; keep as a distinct frozen export so catalog can diverge later). Default: none. Picked names join the vendor set for the infra step.
- **Q7 `executeTasks`**: `{ enabled: boolean, maxTasks: number }`. Default: `enabled: true, maxTasks: 3`. Gates §4.

## §3 Suggestions on results screen

- `suggested[]` in `tools.json` = (`OPTIONAL_CATALOG` − installed) ∪ (analyzer `skillCandidates[]` filtered to `CURATED_ALLOWLIST`, minus installed). Deduped by name; analyzer entries carry their reason text.
- Results UI: **"Suggested tools"** section next to the gaps list. Each row: name, reason, source tag, **Vendor** button.
- New endpoint `POST /api/enable/vendor` in `apps/enable/server.mjs`: body `{ name }`. Server re-validates against `CURATED_ALLOWLIST` (reject 400 otherwise), resolves via `resolveSkill` (incl. plugin cache), copies into target repo `.claude/skills/<name>/` with the same provenance-header convention the infra agent uses, appends to `VENDORED.md`, returns updated installed list. Client moves the row from suggested → installed.

## §4 Execute open tasks (opt-in step)

- New step `s_execute` in `ENABLE_WORKFLOW` between `s_eval` and `s_canary`. Skipped entirely when clarify `executeTasks.enabled` is false (same conditional-step mechanism the canary uses).
- New agent `agents/maestro-onboarding-executor.md`, registered as a plain **producer** runner (`src/core/runners.mjs`) — no engine changes.
  - Input: `readiness.json` `gaps[]`, cap `maxTasks` from clarify, scope constraints from clarify.
  - Behavior: pick up to N gaps (ordered as evaluator listed them), implement each on the enable branch with tests where applicable; skip a gap rather than half-finish it; never touch files outside scope constraints.
  - Output: `tasks-report.json`, channel `tasks`:

    ```json
    {
      "attempted": [{ "gap": "…", "status": "completed|skipped|failed", "notes": "…" }],
      "completed": 2, "skipped": 1, "failed": 0
    }
    ```

  - New normalizer `normalizeTasksReport` in `onboarding-contracts.mjs`; counts recomputed from `attempted[]` (contract policy: derived fields are always recomputed, mirroring `delta`).
- **Re-score (option a):** feedback edge `fb_exec` from `s_execute → s_eval`, gated on `tasks-report.completed > 0`, **max 1 iteration**. Evaluator re-runs, rewrites `readiness.json`; results screen shows the true post-execution score and shrunken gaps. Guard interplay with `fb_eval`: the re-run evaluator may again report blocking issues; `fb_eval` retains its own iteration cap so the pipeline still terminates.
- Results screen: gaps section header notes executed tasks (e.g. "2 done during enablement"), sourced from `tasks-report.json` attached to the final event the same way as `tools`.

## §5 Testing

- **Contracts** (`test/` unit): `normalizeToolsReport`, `normalizeTasksReport` (fatal/repair/warn matrix, derived-count recompute), clarify extension fields.
- **Vendoring policy**: `resolveVendorTargets` with caveman in baseline; `OPTIONAL_CATALOG` disjointness invariant (catalog ⊆ allowlist, catalog ∩ baseline = ∅); plugin-cache resolution in `skills.mjs` (hit, miss, allowlist rejection).
- **Workflow shape**: `ENABLE_WORKFLOW` contains `s_execute` with `fb_exec` edge and correct gate; step skipped when `executeTasks.enabled` false.
- **Server**: `POST /api/enable/vendor` — allowlist rejection (400), happy path copies + VENDORED.md append, idempotent re-vendor.
- **UI** (existing `test/enable-*.test.mjs` renderer pattern): installed-tools section with mandatory badges, suggested-tools rows + vendor-button flow, executed-tasks note on gaps header, history replay with and without `tools`/`tasks` payloads (old runs render unchanged).

## Out of scope

- User-global (`~/.claude`) installation of anything.
- Executing tasks beyond evaluator gaps (repo TODOs, issue trackers).
- Reel/other-format catalog UI; catalog management UI (catalog is a code constant).
