# Spec: Pipeline Results View

**Status:** Approved design
**Goal:** Show the outcome of a finished pipeline run in a way a human can scan in seconds. A free, deterministic mechanical base, plus an optional on-demand agent that adds narrative + a fresh diff check.

---

## 1. Problem

When a pipeline reaches `done`, the user wants three answers fast:

1. **What files changed?**
2. **What files are new?**
3. **What should I check before I trust this?**

Today the detail view shows the audit timeline, stepper, and sub-agent telemetry, but there is **no consolidated results view**. Verdicts live in the `reviews` table but are not surfaced as an at-a-glance summary, and the changed/new file split is only available as raw diff shortstat in history.

## 2. Architecture: two layers

```
pipeline reaches `done`
  │
  ├─ LAYER 1 — MECHANICAL  (always runs · free · deterministic)
  │    ├─ git diff --name-status -M <checkpoint>   → new / changed / deleted buckets
  │    ├─ git diff --numstat   -M <checkpoint>     → ±lines per file
  │    ├─ persist full patch                       → artifact kind='diff-patch'
  │    ├─ reviews table → latest-cycle critical/major  → "key things to check"
  │    └─ persist assembled summary                → artifact kind='results'
  │
  └─ LAYER 2 — OVERVIEW AGENT  (on-demand · costs tokens · cached)
       trigger : "Generate overview" button
       reads   : diff-patch + results + review issues   (persisted artifacts, NOT live files)
       emits   : { narrative, diffFindings[] }          → artifact kind='overview'
```

**Layer 1 is the original deterministic, zero-token contract** and is the default view. **Layer 2 is opt-in** — the user pays tokens only for runs they choose to deep-dive.

### Why this split

The two valuable judgments — a plain-English narrative and a fresh read of the diff — are **inherently model work**; no mechanical parsing can produce them. But a model on **every** run wastes tokens, because maestro runs many unattended/scheduled pipelines that are never human-reviewed. On-demand makes the model cost an explicit per-run choice while keeping the structured base free and instant.

## 3. Hard constraints

| Constraint | Applies to | Consequence |
|---|---|---|
| **Deterministic** | Layer 1 | Same run → byte-identical results JSON every rebuild. No model in the path. |
| **Non-token-burning by default** | Layer 1 | Rendering a run costs zero tokens. Layer 2 only on explicit click. |
| **Bounded agent cost** | Layer 2 | Input is the persisted patch + verdicts, size-capped — never the full repo. |

The pipeline **already pays for** Layer 1's inputs:

- `git diff <checkpoint>` runs per run (single project + per-member) — `src/core/orchestrator.mjs:438`.
- Review issues (critical/major/minor/suggestion) are stored per cycle in the `reviews` table — `src/core/db.mjs` schema, normalized in `src/core/protocol.mjs`.
- Diff baseline (`checkpoint` / per-member `checkpointRefs`) and branch are already persisted.

---

## 4. Layer 1 — Mechanical assembler

### 4.1 Changed / new files — from git

Run once at `done`, per project (per member for workspaces):

```
git diff --name-status -M <checkpoint> -- .
```

`--name-status` yields one status letter per path. `-M` enables rename detection. New files appear because the orchestrator already does `git add -A -N` (intent-to-add) before diffing.

| Letter | Meaning | Bucket |
|---|---|---|
| `A` | Added | **New files** |
| `M` | Modified | **Changed files** |
| `D` | Deleted | **Changed files** (marked deleted) |
| `R###` | Renamed (with similarity %) | **Changed files** (`old → new`) |
| `C###` | Copied | **New files** |
| `T` | Type change | **Changed files** |

Per-file ±line counts from a parallel `git diff --numstat -M <checkpoint> -- .`, joined on path. Binary files report `-`/`-` → show "binary". **No file contents are read** — name + status + counts only.

### 4.2 Persist the patch

Also at `done`, store the full unified diff as an artifact:

```
git diff -M <checkpoint> -- .   → artifact kind='diff-patch'
```

This is the input substrate for Layer 2 (and future Q&A) after the worktree is torn down. Without it, the diff baseline may not be reproducible later — the worktree is cleaned up on `done/error` (`src/core/orchestrator.mjs:522`).

### 4.3 Key things to check — from the reviews table

```sql
SELECT kind, cycle, verdict FROM reviews WHERE pipeline_id = ?
```

Each `verdict` normalizes (via `protocol.mjs:normalizeReview`) to `{ issues:[{severity,title,detail,location}], summary }`.

Deterministic selection rule:

1. Take issues from the **last cycle of each `kind`** (latest impl review, latest plan review). Earlier cycles are superseded.
2. `critical` + `major` → primary list. `minor` + `suggestion` → collapsed "Nitpicks".
3. De-duplicate by `(severity, normalized title)`; on cross-kind title collision keep one, tag both kinds.
4. Sort: `critical` before `major`; stable by first appearance within a severity.

This **re-presents verdicts already generated** during the review loop — re-review, not re-analysis. Zero new tokens.

### 4.4 File ↔ issue linking (deterministic, best-effort)

`location` is free text. Link an issue to a changed-file row when the file's path (or basename) is a substring of `location`. Pure string match. Unmatched issues show under "General" — never dropped.

### 4.5 Layer 1 output (artifact `kind='results'`)

```json
{
  "summary": {
    "filesNew": 3, "filesChanged": 7, "filesDeleted": 1,
    "linesAdded": 412, "linesRemoved": 88,
    "blockingIssues": 2, "nitpicks": 5
  },
  "newFiles":    [ { "path": "src/foo.ts", "added": 120, "removed": 0 } ],
  "changedFiles":[
    { "path": "src/bar.ts", "status": "M", "added": 30, "removed": 12, "issues": ["issue-id"] },
    { "path": "src/old.ts", "status": "D" },
    { "path": "src/a.ts",   "status": "R", "from": "src/b.ts", "added": 4, "removed": 4 }
  ],
  "keyThingsToCheck": [
    { "id": "issue-id", "severity": "critical", "title": "…", "detail": "…",
      "location": "src/bar.ts:42", "kind": "impl", "cycle": 2, "file": "src/bar.ts" }
  ],
  "nitpicks": [ { "severity": "minor", "title": "…", "kind": "impl" } ],
  "perProject": { "<projectKey>": { /* same shape for workspace members */ } }
}
```

Workspace runs compute per member against `checkpointRefs[projectKey]`, then roll up `summary` totals.

---

## 5. Layer 2 — Overview agent (on-demand)

### 5.1 Form

A **real maestro sub-agent node**, not a UI-server LLM call. It is recorded in `sub_agents` so it inherits the existing token/cost telemetry, and it slots into the existing agent infrastructure.

### 5.2 Trigger

```
POST /api/runs/:id/overview
```

From the "Generate overview" button. **Idempotent** — returns the cached `overview` artifact if one exists; "Regenerate" forces a rebuild.

### 5.3 Input — bounded, persisted artifacts only (no live files)

- `diff-patch` artifact (the hunks — exactly what a diff checker needs)
- `results` JSON (file buckets + counts)
- review `issues` (so the agent knows what was already flagged and only reports *new* findings)

**Size cap:** if the patch exceeds the cap, the agent receives the file list + hunk headers instead of full hunks. Narrative still works; the diff check degrades gracefully and sets `diffCheckTruncated: true` in its output. The cap is logged, never silent.

The agent reads the **persisted patch, not live files** — the worktree is gone by click time. A diff checker wants the hunks anyway, so full-file context is rarely needed; when it is, that limitation is surfaced via the truncation flag.

### 5.4 Output (artifact `kind='overview'`)

```json
{
  "narrative": "2–4 sentences: what this run did and why it matters.",
  "diffFindings": [
    { "severity": "warn|note", "file": "src/x.ts", "line": 42,
      "title": "…", "detail": "…", "newVsReview": true }
  ],
  "diffCheckTruncated": false
}
```

`newVsReview: true` marks a finding the review loop did **not** surface — the core value of the fresh diff read. `diffFindings` are **additive** and never overwrite Layer 1's review issues; they render separately, tagged `agent`.

---

## 6. Persistence as a shared context API (enables future Q&A)

The artifacts persisted at `done` — `diff-patch`, `results`, plus the existing `reviews` and audit markdown — form a **stable, bounded context bundle for a finished run**. Expose a single internal accessor that returns this bundle for a pipeline id.

This is deliberately the same substrate a future **per-run Q&A agent** would consume ("how does X work?", "how do I use Y?"). That feature is **out of scope here** but explicitly enabled: a cold, per-question agent seeded with this bundle is bounded and cheap, and strictly cheaper than keeping a warm session whose context grows every turn. Design the accessor cleanly now; build Q&A in its own spec later.

---

## 7. Serving & rendering

- **Build Layer 1:** in the `done` transition (`src/core/orchestrator.mjs`), right after the final diff, while refs are live. Persist `diff-patch` + `results`.
- **Serve:** extend `readPipelineByKey` (`src/core/artifacts.mjs:1471`) to include `results` and (if present) `overview`. Exposed on existing `GET /api/runs/:id` and `GET /api/history/:key/:id`. New endpoint only for the agent trigger: `POST /api/runs/:id/overview`.
- **Render:** new "Results" section/tab in `ui/public/app.js`. Reuse the existing severity CSS classes (`sev-critical`, `sev-major`, …) from gate cards (`app.js:2737+`).

### 7.1 UI layout

```
┌─ Results ────────────────────────────────┐
│ 3 new · 7 changed · 1 deleted            │  ← summary chips (Layer 1, instant)
│ +412 / −88 · 2 to check                  │
│                       [ Generate overview ] ← Layer 2 trigger
├──────────────────────────────────────────┤
│ ✦ Overview (after click)                 │  ← narrative; "Regenerate" once cached
│   "This run wires the results assembler…"│
├──────────────────────────────────────────┤
│ ⚠ Key things to check (2 review · +N agent)│ ← review issues first; agent findings tagged
│   • [critical · review] … → src/bar.ts:42│
│   • [warn · agent · new] … → src/x.ts:42 │
├──────────────────────────────────────────┤
│ ✦ New files (3)   src/foo.ts        +120 │
├──────────────────────────────────────────┤
│ ✎ Changed files (7)                      │
│   src/bar.ts  M  +30 −12  ⚠2             │
│   src/old.ts  D                          │
│   src/b.ts → src/a.ts  R  +4 −4          │
├──────────────────────────────────────────┤
│ ▸ Nitpicks (5)                           │  ← collapsed
└──────────────────────────────────────────┘
```

Rules:
- Layer 1 renders first and instantly; "Generate overview" is the only token-spending action.
- "Key things to check" renders before files — it's the decision-driver. Empty + no agent run → green "Clean — no blocking issues flagged."
- Agent findings merge into the checks list, tagged `agent` and (if applicable) `new`, never replacing review issues.
- File paths and `location` links are clickable, per existing app conventions.

---

## 8. Edge cases

| Case | Behavior |
|---|---|
| No diff (plan-only / aborted pre-impl) | Show checks + "No file changes." Overview button disabled. |
| Checkpoint ref gone at build time | Fall back to `diffShortstat` totals; flag file list unavailable. |
| `diff-patch` missing (run predates feature) | Overview button disabled; Layer 1 still renders. |
| Binary file | Show "binary", omit counts. |
| Huge diff | Layer 1 lists mechanically (paginate/virtualize in UI, never truncate data — log if display caps). Layer 2 patch over cap → hunk-headers mode + `diffCheckTruncated`. |
| Rename + edit | `R` status with `from`, plus line counts. |
| Issue with empty/garbage `location` | Lands under "General"; never dropped. |
| Workspace member with no changes | Omit from per-project unless it has issues. |
| Overview agent fails / times out | Layer 1 view intact; button shows retry. Never blocks the run or the `done` transition. |

---

## 9. Out of scope

- **Auto-running the agent on every run.** On-demand only (cost control).
- **Q&A / chat over a finished run.** Enabled by §6 persistence; its own spec.
- LLM-generated prose in Layer 1 (violates the deterministic, zero-token contract).
- Semantic risk scoring beyond severities the review loop already assigned and the agent's own `diffFindings`.
- Reading repo file contents in Layer 1 (status + numstat only).

---

## 10. Acceptance criteria

1. Opening a finished run renders Layer 1 with new/changed/deleted counts matching `git diff --name-status` exactly — zero tokens.
2. Rebuilding Layer 1 for the same run yields byte-identical `results` JSON.
3. "Key things to check" lists every critical/major issue from the latest cycle of each review kind — none invented, none dropped.
4. The overview agent runs **only** on explicit trigger, is recorded in `sub_agents` with cost, and caches its `overview` artifact (second open = no new tokens).
5. Agent `diffFindings` render additively, tagged `agent`/`new`, and never overwrite review issues.
6. Agent failure leaves Layer 1 fully functional and never blocks the `done` transition.
7. Works for single-project and workspace runs (per-project breakdown + rolled-up totals), and still renders after worktree cleanup (artifacts persisted at `done`).
8. The §6 context-bundle accessor returns `{ diffPatch, results, reviews, audit }` for a pipeline id in one call.
