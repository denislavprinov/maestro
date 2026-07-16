# Stack-Specific Skills Mirror — Design

**Date:** 2026-07-15
**Status:** Approved
**Builds on:** 2026-07-14 onboarding tools/task-execution work (suggested-tools UI, `/api/enable/vendor`, tools report contract).

## Problem

The onboarding pipeline vendors only generic process skills (`CURATED_BASELINE`) and offers three generic optional ones (`OPTIONAL_CATALOG`). The analyzer already detects each project's language/framework/toolchain, but nothing turns that signal into stack-specific skills — a Spring Boot repo gets no Spring skill, a Swift repo no Swift skill, a dockerized repo no DevOps skills. Additionally, vendored skills land only in `.claude/skills/`, even when the user asked for multi-tool setup (Cursor, AGENTS.md agents).

## Decisions (user-approved)

1. **Trust model: pinned + vetted mirror.** Skills from external repos are reviewed once and committed into maestro's own `skills/` bundle with attribution. The allowlist mechanism is unchanged — membership is the gate, no runtime network dependency, no new trust surface.
2. **V1 scope: all four stack groups** — Spring Boot/Java, Swift/iOS, DevOps, broader web (React/Next, Django/FastAPI, Express).
3. **Delivery: suggest on the results screen.** Matched skills join the existing suggested-tools section with one-click Add. No auto-vendoring, no new UI.
4. **Multi-tool placement:** vendored skills are copied to each tool location implied by the run's `multiToolTargets` answer (see §5).

## Sources (verified 2026-07-15)

| Repo | What we take | License |
|---|---|---|
| [rrezartprebreza/spring-boot-skills](https://github.com/rrezartprebreza/spring-boot-skills) | Boot 3 variants: rest-api-conventions, spring-data-jpa, spring-security-jwt, flyway-migrations, testing-pyramid | MIT |
| [Mindrally/skills](https://github.com/Mindrally/skills) | swift, swiftui; docker, kubernetes, terraform, github-actions; react, nextjs, django, fastapi, express | Apache-2.0 |

~16 skills total in v1. Not used: anthropics/skills (no framework skills), VoltAgent/awesome-agent-skills (link aggregator, hosts nothing).

## 1. Mirror layout + licensing

Each vetted skill is committed at `skills/<name>/` (flat, beside existing bundled skills). `resolveSkill()` already resolves `<repoRoot>/skills/<name>/SKILL.md` as source `bundle`, and both `injectSkills()` and the vendor endpoint copy from there — **zero resolver changes**.

Per mirrored skill dir:
- upstream content (`SKILL.md`, plus `examples/`/`templates/`/`references/` where upstream ships them)
- upstream `LICENSE` copy
- `ATTRIBUTION.md`: upstream repo URL, pinned commit SHA reviewed at, date, local modifications (normally "none")

Name collisions with existing bundled/baseline/optional skills are a validation error at ingestion time (upstream `swift` dir etc. are new names today).

Ingestion is a one-time scripted fetch (per repo, at a pinned SHA) → human review of every file → commit. The script lives in `scripts/` for repeat use when refreshing pins; refreshing is always a deliberate PR with re-review.

## 2. Catalog + matching (deterministic, no LLM)

In `src/core/skill-vendor.mjs`:

```js
export const STACK_CATALOG = Object.freeze({
  'spring-boot': Object.freeze(['rest-api-conventions', 'spring-data-jpa', 'spring-security-jwt', 'flyway-migrations', 'testing-pyramid']),
  swift:            Object.freeze(['swift', 'swiftui']),
  docker:           Object.freeze(['docker']),
  kubernetes:       Object.freeze(['kubernetes']),
  terraform:        Object.freeze(['terraform']),
  'github-actions': Object.freeze(['github-actions']),
  react:            Object.freeze(['react']),
  nextjs:        Object.freeze(['nextjs']),
  django:        Object.freeze(['django']),
  fastapi:       Object.freeze(['fastapi']),
  express:       Object.freeze(['express']),
});
```

`CURATED_ALLOWLIST` grows to include every `STACK_CATALOG` skill. Invariants (tested): every catalog skill is in the allowlist; catalog is disjoint from `CURATED_BASELINE`; catalog ∪ `OPTIONAL_CATALOG` may overlap only deliberately (v1: disjoint).

New pure function, new module `src/core/stack-detect.mjs`:

```js
detectStacks(projectDir) -> Array<{ stack: string, evidence: string }>
```

Manifest sniffing, read-only, offline:
- `pom.xml` / `build.gradle(.kts)` containing `spring-boot` → `spring-boot` (evidence: file name)
- `Package.swift` / `*.xcodeproj` / `*.xcworkspace` → `swift`
- `Dockerfile` / `docker-compose*.yml` → `docker`
- `kustomization.yaml` / `Chart.yaml` (helm) / yaml under `k8s/` or `manifests/` with `apiVersion:` + `kind:` → `kubernetes`
- `*.tf` → `terraform`
- `.github/workflows/*.yml` → `github-actions`
- `package.json` deps: `react` → react; `next` → nextjs (nextjs implies react — suggest nextjs only); `express` → express
- `pyproject.toml` / `requirements.txt` deps: `django` → django; `fastapi` → fastapi

Per-stack evidence string is human-readable ("Spring Boot detected (pom.xml)") and becomes the suggestion `reason`.

## 3. Delivery — rides the existing suggestion pipe

Where the tools report is normalized (the `validateContractOutputs` hook path for `tools.json` in `src/core/onboarding-contracts.mjs`), matcher output is unioned into `tools.suggested[]`:

```js
{ name, reason: evidence, source: 'stack-match' }
```

Union rules: skip names already installed or already suggested (agent suggestions win on collision — they carry project-specific reasoning); skip names already vendored in the repo. The results screen, one-click Add button, `/api/enable/vendor` endpoint, and `~/.claude` guard are all already shipped and remain untouched. Old runs (no tools field) keep the existing backward-compat path.

## 4. Multi-tool skill placement

SKILL.md is an open standard; per-tool project dirs are fixed: `.claude/skills/`, `.cursor/skills/`, `.codex/skills/`, `.gemini/skills/`, plus vendor-neutral `.agents/skills/` read by multiple agents (Codex et al.).

New function in `skill-vendor.mjs` (fs probes only, no mutation):

```js
vendorDestinations(projectDir) -> string[]   // relative dirs
```

Presence-based — reads which tool footprints the repo actually has (infra-gen writes those footprints from `multiToolTargets` during the run, so the answer is reflected on disk; also correct for old runs and hand-configured repos):

- Always `['.claude/skills']` (current behavior, Claude Code primary).
- `.cursor/rules/` or `.cursorrules` exists → add `.cursor/skills`.
- `AGENTS.md` exists (generic-agents signal) → add `.agents/skills`.
- Copilot footprint (`.github/copilot-instructions.md`) → nothing extra (Copilot has no skills support; instructions file only).
- Bare repo → just `.claude/skills`.

The same skill dir is copied verbatim to each destination — duplication over symlinks, deliberately (cross-platform; the vendor guard was just hardened against symlink tricks and stays effective per destination).

Both vendor paths honor destinations:
- **Infra-gen agent (during run):** prompt updated to mirror vendored skills into `.cursor/skills/` / `.agents/skills/` per its `multiToolTargets` clarify answer.
- **`/api/enable/vendor` endpoint (one-click):** server computes destinations via `vendorDestinations(dir)` — never client-supplied — copies to each, and applies the existing realpath `~/.claude` guard per destination. Response gains `destinations: string[]`.

`.claude/skills/VENDORED.md` manifest lists destinations per skill.

## 5. Explicitly out of scope (v1)

- Per-tool skill translation (format is shared; none needed).
- Runtime fetching of upstream repos.
- Auto-vendoring of matched skills.
- New clarify questions (multiToolTargets and optionalTools stay as-is).
- UI grouping of suggestions by stack (flat list, reason string carries context).

## Testing

- **stack-detect:** fixture dirs per manifest type (each DevOps artifact detected independently — Dockerfile alone must NOT suggest kubernetes); multi-stack repos; nextjs-implies-react suppression; empty/no-manifest repo → `[]`.
- **catalog invariants:** STACK_CATALOG ⊆ allowlist; disjoint from baseline (extends the existing subset/disjoint test).
- **suggestion union:** stack matches merge into `tools.suggested` with `source: 'stack-match'`; installed/duplicate/already-vendored names skipped; agent suggestions win collisions.
- **vendorDestinations:** table test over repo footprints (bare, `.cursor/rules`, `.cursorrules`, `AGENTS.md`, copilot-only, all combined).
- **vendor endpoint:** run with Cursor target → skill lands in `.claude/skills/` and `.cursor/skills/`; guard still rejects escape attempts per destination; response lists destinations.
- **mirror hygiene:** every `STACK_CATALOG` name resolves as `bundle` source with a `SKILL.md` + `ATTRIBUTION.md` present.

## Engine impact

Zero orchestrator-engine changes. New pure modules + catalog constants, one prompt update (infra-gen), one endpoint extension, contract-normalization union. Same extension points as the previous plan.
