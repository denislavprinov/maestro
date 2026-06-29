# Enable — design spec

**Date:** 2026-06-30
**Branch:** `enable-app` (off `ai-enablement-onboarding`)
**Status:** approved design, pre-plan

## 1. What Enable is

A focused, single-purpose app inside the maestro repo as a new workspace package
`apps/enable/`. One feature: point at a local project, run the AI-Enablement
onboarding pipeline, and show before → after readiness in plain language.

It does **not** fork the existing general UI (`ui/`) or modify the engine
(`src/core/`) logic. It adds a thin, onboarding-only programmatic entrypoint over
the existing orchestrator and a custom workflow, then wraps both in a small local
server + renderer.

Non-goals for v1: post-analysis approval gates, mid-run recovery UI, history
persistence beyond what the engine already stores, multi-project workspaces,
redesigning the provided UI.

## 2. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Platform | **Both, one codebase.** Renderer is a plain web app served by a local Node server that embeds the Phase-1 API. Web mode = localhost + browser. Desktop mode = Electron main boots the *same* server + opens a window at the same URL. One renderer, two launchers. Electron is a thin Phase-2 add, not a v1 blocker. |
| 2 | Gates scope | **Up-front only for v1.** Fixed set-up screen before the run. Post-analysis approval gates ("approve these planned skills/agents") are a fast-follow needing a small additive engine primitive — out of scope now. |
| 3 | Questions model | **Fixed screen, deterministic pipeline.** Enable owns a hand-authored set-up screen; the engine side uses a custom workflow whose clarifier emits exactly those questions with fixed ids. |
| 4 | Pipeline | **Build our own `wf_enable`** rather than bend `wf_onboarding`. Reuses the existing onboarding agents; swaps the LLM clarifier for a deterministic one. Zero engine-logic changes. |
| 5 | Score streaming | **Event-driven.** Derived from canonical readiness files read on `phase` done events. |

## 3. Engine surface being reused (Phase-0 findings)

The orchestrator is the single brain; the existing UI is a thin shell over it.

- `createOrchestrator(opts)` → `Orchestrator extends EventEmitter`
  ([src/core/orchestrator.mjs:138](../../../src/core/orchestrator.mjs)).
  Key opts: `projectDir`, `workflowId`, `prompt`, `title`, `auto`, `branch`,
  `claude:{permissionMode,model,mock}`, `agentsDir`.
- `orch.run()` → resolves `{ status, pipelineDir }`.
- Events (EventEmitter): `state`, `phase` `{phase,cycle,status,nodeId}`,
  `question` `{id,kind,questions,issues,recovery}`, `artifact` `{kind,path}`,
  `log`, `done` `{status,pipelineDir}`, `error`.
- Clarify gate: run blocks at `_ask()`; unblock via
  `orch.answer(id, { answers:[{id,choice}] })`. Loop gate kind `gate`
  (`{decision:'continue'|'another'}`), error kind `recovery`
  (`{decision:'retry'|'abort'}`).
- Result branch: generic `maestro/<slug>-<shortId>` from `suggestBranchName(...)`
  ([src/core/worktree.mjs:89](../../../src/core/worktree.mjs)); pass
  `title:"Enable project for AI"` → `maestro/enable-project-for-ai-<hash>`.
  Live value at `orch.getState().branch.feature`. User's real project untouched;
  work lands in the worktree on that branch.

The existing `ui/server.mjs` is the bridge template: `POST /api/run` →
`createOrchestrator(...)`, events forwarded over WebSocket `/ws`, answers via
`POST /api/answer`. Enable mirrors this pattern with a minimal, onboarding-only
server — it does **not** fork `ui/server.mjs`.

**Score data is NOT exposed by the engine over events or HTTP today** — only
phase/cycle/cost. Streaming readiness is the core new work (see §6).

## 4. The custom pipeline: `wf_enable`

Workflow template, persisted to the sqlite `workflows` table at Enable startup via
`writeWorkflow(tpl)` ([src/core/workflows.mjs:162](../../../src/core/workflows.mjs)).
Seeding is idempotent and additive — `builtin-workflows.mjs` is **not** edited.

```js
{
  id: 'wf_enable',
  name: 'Enable project for AI',
  domain: 'coding',
  steps: [
    [{ id: 's_clarify', key: 'enableClarifier' }],     // NEW deterministic clarifier
    [{ id: 's_analyze', key: 'onboardingAnalyzer' }],  // existing agent, reused
    [{ id: 's_infra',   key: 'projectOnboarding' }],   // existing agent, reused
    [{ id: 's_tests',   key: 'onboardingTests' }],     // existing agent, reused
    [{ id: 's_eval',    key: 'onboardingEvaluator' }], // existing agent, reused
    [{ id: 's_canary',  key: 'onboardingCanary' }],    // existing agent, reused
  ],
  feedbacks: [{ id: 'fb_eval', from: 's_eval', to: 's_infra' }], // eval → infra loop
}
```

`resolveWorkflow` adds `gate:'hasBlocking'` to the feedback automatically. The
workflow must pass `validateWorkflow`
([src/core/workflow-validator.mjs](../../../src/core/workflow-validator.mjs)):
unique node ids, every `key` present in the agent registry, feedback `to` index <
`from` index. All satisfied.

### New agent: `enableClarifier`

Two new files (additive; existing agents untouched):

- `enableClarifier.meta.json` — `runnerType:'clarifier'`, `color:'red'`,
  `produces:['clarify']`, `consumes:['userPrompt']`, points at the prompt below.
- `maestro-enable-clarifier.md` — prompt instructs the agent to **always** emit
  exactly the 5 fixed questions with fixed ids, defaults pre-picked, free text
  allowed. Because clarify behavior is keyed on `runnerType:'clarifier'`
  (handled uniformly by `_runClarifyNode`, [orchestrator.mjs:1646](../../../src/core/orchestrator.mjs)),
  no engine change is needed.

**Placement (decide in plan, leaning isolated):** ship the 2 files in
`apps/enable/agents/` and point the registry's `userAgentsDir` there, keeping
Enable's custom agent inside its own package; the repo `agents/` dir continues to
supply the reused onboarding agents. (Fallback: drop both files in the repo
`agents/` dir — simpler, still additive.)

### The 5 set-up questions (ids → friendly labels)

| id | Friendly label | Default | Input |
|----|----------------|---------|-------|
| `testTier` | How much testing should we set up? | `scaffold` | single + free text |
| `vendoringDepth` | Bundle reusable AI skills? | `full` | single + free text |
| `multiToolTargets` | Which other AI tools? | Claude (locked) + Cursor + Copilot | multi + free text |
| `canary` | Quick test-drive at the end? | `yes` | single + free text |
| `scopeConstraints` | Folders to focus on / avoid? | — | free text, optional |

`multiToolTargets` is multi-select in the UI but the engine clarify answer is a
single `choice` string; since the gate allows free text, selections are joined
(e.g. `"AGENTS.md, .cursor/rules"`). The `enableClarifier` prompt and the
downstream `projectOnboarding`/`onboardingTests` agents must agree on how the
joined value maps to emitted assistant-config files — confirm in plan.

## 5. Architecture

```
src/core/onboarding.mjs        NEW. Phase-1 API — the only src/core addition.
  runOnboarding({projectDir, answers, title?, mock?})
    → { runId, events /* EventEmitter */, done /* Promise */ }
  - ensures wf_enable is seeded (idempotent writeWorkflow)
  - createOrchestrator({ workflowId:'wf_enable', title:'Enable project for AI', ... })
  - on clarify gate: auto-answers from `answers` mapped by question.id
  - derives + emits `readiness` events (engine does not)
  - done → { status, branch, readiness }

apps/enable/                   NEW workspace package ("workspaces":["apps/*"] in root)
  package.json
  server.mjs                   thin express+ws embedding onboarding.mjs.
                               Routes: POST /api/enable/run, POST /api/enable/answer,
                               GET /api/enable/projects ; WS /ws (events + readiness).
                               NOT a fork of ui/server.mjs — onboarding-only, minimal.
  public/                      adapted renderer (vanilla HTML/CSS/JS from design export)
  agents/                      enableClarifier.meta.json + maestro-enable-clarifier.md
  electron/main.mjs            Phase-2 thin wrapper: boots server.mjs, opens BrowserWindow

docs/superpowers/specs/        this spec
```

Boundaries:
- `onboarding.mjs` knows the orchestrator + readiness files. It exposes a tiny
  surface and hides all orchestration detail. Testable headless with `mock:true`.
- `server.mjs` knows HTTP/WS only; it delegates everything to `onboarding.mjs`.
- renderer knows the WS envelope only; never touches the engine.
- Renderer always talks WebSocket to a local server → "both, one codebase".

## 6. Data flow & readiness derivation

Happy path:
```
Home (pick project dir)
  → Set-up screen (5 fixed Qs, defaults pre-picked, "something else" free text)
  → POST /api/enable/run { projectDir, answers }
       server: runOnboarding(...) → { runId }; subscribe + broadcast over WS
  → Live progress (5-stage journey, score ring + ghost baseline, dimension bars, plain feed)
  → Results card (hero "28 → 93 (+65)", 9 bars, what-we-added, gaps, actions)
```

Engine events carry phase/cycle/cost, never score. `onboarding.mjs` holds the
`orch` instance, so it knows `pipeline.dir` and reads the canonical files on the
right event, then emits a synthetic `readiness` event:

| Trigger | Read | Emit |
|---------|------|------|
| `phase` done, `s_analyze` (Understand) | `graph-summary.json` → `graph.baselineReadiness` | `{kind:'baseline', score, dimensions}` — reveal starting score |
| `phase` done, `s_eval` cycle N (Review) | `onboardingEvaluator-review-cycleN.json` → `.score` | `{kind:'cycle', cycle:N, score}` — "Refining… (pass N)", ring climbs |
| run `done` | `readiness.json` (canonical latest) | `{kind:'final', score, baselineScore, delta, dimensions, gaps}` |

Readiness JSON shape (exact dimension keys → friendly labels):

```
{ score, baselineScore, delta,
  dimensions: {
    docs                  → Documentation
    skillsAgents          → Custom skills
    rules                 → Guardrails
    tests                 → Test setup
    featureSkillCoverage  → Key-workflow coverage
    realTests             → Working tests
    vendoring             → Bundled skills
    multiTool             → Cross-tool support
    codeHealth            → Code health
  },
  gaps: [ ... ] }
```

Bars 0–100, green/amber/red vs the 80 "ready" line. The eval→infra loop never
renders as a "loop": each cycle score event bumps the ring + "pass N" label.
`baselineReadiness` can be null (analyzer best-effort) — renderer must handle
"baseline unknown" gracefully (no ghost ring).

### Screens (from the provided design, adapted — not redesigned)

Home/projects · Set-up questions (the gate) · Live progress (5-stage journey,
active stage pulses its color, starting-score reveal, animating score ring with
ghost baseline, friendly dimension bars, plain-English activity feed, raw logs
behind a "details" toggle) · Results card (hero delta, 9 bars, "what we added",
optional next steps = gaps, actions: Review changes / Keep it / Re-run / Discard)
· History (before → after timeline). Result branch shown only behind a secondary
"for developers" detail.

Stage label ← engine key (agent color): Set up ← `s_clarify` (red) · Understand ←
`s_analyze` (blue) · Build ← `s_infra` (green) · Add tests ← `s_tests` (peach) ·
Review ← `s_eval` (amber) · Test-drive ← `s_canary`.

## 7. Errors / gates (v1 = one happy path)

- `recovery` (network/timeout/session cap): engine auto-retries 3× then asks;
  `onboarding.mjs` lets it run and, on terminal failure, emits `error` to the
  renderer (plain "something went wrong, re-run?"). No mid-run recovery UI.
- `gate` (eval blocking-loop decision): auto-`continue` so refining proceeds
  unattended.
- Clarify id mismatch (our own prompt drifts): fall back to engine default for the
  missing id and log; the drift-guard test (below) catches it in CI.

## 8. Testing (TDD)

Runner unchanged: `node --test test/*.mjs`, `MAESTRO_HOME=.maestro-test`,
`MAESTRO_MOCK=1`. New file `test/onboarding-api.mjs`. The existing suite must stay
green (regression bar).

Phase-1 tests (red → green):
1. `runOnboarding` starts a run pinned to `wf_enable` with title "Enable project
   for AI"; `wf_enable` is seeded idempotently.
2. Clarify gate auto-answered from supplied answers; emitted question ids ==
   the expected 5 (drift guard on the `enableClarifier` prompt).
3. `multiToolTargets` multi-select → joined free-text choice reaches the engine.
4. `readiness` events fire: baseline after analyze, one per eval cycle, final on
   done — correct shape, 9 dimension keys.
5. `done` resolves `{ status, branch, readiness }`; branch matches
   `maestro/enable-project-for-ai-<hash>`.
6. Unknown clarify id → falls back to engine default, does not throw.

Server gets route smoke tests; renderer is vanilla and verified by a `/run`
against the mock engine.

**Open verification for the plan (load-bearing):**
- Does the engine fire a distinct `phase`/`done` per eval loop iteration so
  per-cycle scores stream? Fallback: watch `onboardingEvaluator-review-cycleN.json`
  writes via `artifact` events.
- Exact path of `graph.baselineReadiness` inside the analyzer output file.
- Does `MAESTRO_MOCK=1` produce onboarding readiness artifacts? If not, tests need
  a fixture `pipelineDir`. Verify early in P1.

## 9. Phasing

- **P1 — engine entrypoint (TDD).** `src/core/onboarding.mjs`, `wf_enable` seed,
  `enableClarifier` agent files, `test/onboarding-api.mjs`. No UI. Ends green;
  existing suite green.
- **P2 — shell + bridge.** `apps/enable/server.mjs` embedding the P1 API + root
  workspace wiring. Headless run-via-localhost works. Electron wrapper at the end
  of P2 (thin, optional).
- **P3 — adapt the provided UI.** Bind the design export in `apps/enable/public/`
  to real WS events + readiness data. No redesign; swap generic data for real
  flows. Light + dark.

## 10. Risks

1. **`enableClarifier` prompt drift** — minor now (our prompt, drift-guard test
   fixes it). If flaky, escalate to pre-seeding answers (a small additive engine
   hook) — not v1.
2. **Per-cycle `phase` granularity** — confirm in plan; artifact-watch fallback.
3. **Null baseline** — renderer degrades gracefully.
4. **Mock fidelity** — verify mock emits readiness artifacts; else add a fixture.

## 11. Principles

Plain language everywhere (jargon/filenames behind "details"); honesty about
refining passes and gaps; safe-by-default (separate reviewable copy on a branch,
real project untouched until "Keep it"); one happy path.
