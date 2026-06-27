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


---

# Pipeline Results View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a finished pipeline run's outcome — new files, changed files, and key things to check — as a free deterministic mechanical view, plus an optional on-demand agent that adds a narrative and a fresh diff check.

**Architecture:** Two layers. **Layer 1 (mechanical)** runs at `done`: `git diff` against the run's checkpoint ref yields the file buckets, the `reviews` table yields the "key things to check", and both are persisted as JSON + a patch artifact in the pipeline dir — zero tokens, deterministic. **Layer 2 (agent)** is triggered on demand by an HTTP POST that spawns a single-shot Claude agent (`runClaude`) seeded with those persisted artifacts; it returns a narrative + `diffFindings`, cached so a second open costs nothing.

**Tech Stack:** Node.js (ESM `.mjs`), `node:test` + `node:assert/strict`, `better-sqlite3` (via `src/core/db.mjs`), Express + vanilla JS frontend (`ui/`), Claude Code CLI via `src/core/claude-runner.mjs`.

## Global Constraints

- **Layer 1 is deterministic and zero-token.** No model call in the Layer 1 path. Rebuilding `assembleResults` on the same patch + reviews yields byte-identical JSON.
- **Layer 2 runs only on explicit trigger** (`POST /api/runs/:id/overview`) and caches its result; a second request returns the cached `overview` artifact with no new tokens unless `?force=1`.
- **Best-effort at `done`:** Layer 1 build must never throw out of the orchestrator — wrap in try/catch and log, mirroring `recordArtifact`/`writeReview`.
- **Severity vocabulary is fixed:** `critical | major | minor | suggestion` (from `protocol.mjs` `normalizeSeverity`). `critical`+`major` are blocking/"key", `minor`+`suggestion` are nitpicks.
- **File paths exact**, follow existing module patterns. New artifact kinds: `results`, `diff-patch`, `overview`. Pipeline-local relPaths: `results.json`, `diff-patch.patch`, `overview.json`.
- **Workspace runs:** compute per member against `checkpointRefs[projectKey]` in `workDirs.get(projectKey)`, roll up `summary` totals.

---

## File Structure

- **Create `src/core/results.mjs`** — Layer 1: pure assembler (`bucketFiles`, `selectKeyChecks`, `splitNitpicks`, `linkIssues`, `assembleResults`), git-backed builder (`buildResultsForDir`), persistence + read (`persistResults`, `persistDiffPatch`, `readResults`, `readOverview`, `readDiffPatch`, `readRunContextBundle`).
- **Create `src/core/overview-agent.mjs`** — Layer 2: `buildOverviewPrompt`, `OVERVIEW_SYSTEM_PROMPT`, `normalizeOverview`, `generateOverview`.
- **Modify `src/core/git-info.mjs`** — add `diffNameStatus`, `diffNumstat`, `diffPatch` (mirror existing `diffShortstat`).
- **Modify `src/core/artifacts.mjs`** — add `runDirForRow` + `readRunArtifactJson`/`readRunArtifactText`; fold `results` + `overview` into `readPipelineByKey` and `readPipeline`.
- **Modify `src/core/orchestrator.mjs`** — add `_buildResults()` and call it on the `done` path before teardown.
- **Modify `ui/server.mjs`** — add `POST /api/runs/:id/overview`.
- **Modify `ui/public/app.js`** — Results section render + "Generate overview" button + fetch.
- **Modify `ui/public/style.css`** — results section + agent-finding tag styles.
- **Create tests** under `test/` per task.

---

## Task 1: Git diff helpers

**Files:**
- Modify: `src/core/git-info.mjs`
- Test: `test/git-info-diff.test.mjs`

**Interfaces:**
- Consumes: existing `_run('git', args, {cwd})` helper in `git-info.mjs` returning `{ ok, stdout, stderr }`.
- Produces:
  - `diffNameStatus(projectDir, base, head?) -> Promise<Array<{status:'A'|'M'|'D'|'R'|'C'|'T', path:string, from?:string}>>`
  - `diffNumstat(projectDir, base, head?) -> Promise<Map<string,{added:number, removed:number, binary:boolean}>>`
  - `diffPatch(projectDir, base, head?) -> Promise<string>`
  - When `head` is omitted, diff is base vs the working tree (`git diff <base>`); when given, `git diff <base> <head>`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/git-info-diff.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { diffNameStatus, diffNumstat, diffPatch } from '../src/core/git-info.mjs';

let repo;
const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });

before(async () => {
  repo = await mkdtemp(join(tmpdir(), 'maestro-diff-'));
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
  await writeFile(join(repo, 'keep.txt'), 'one\n');
  await writeFile(join(repo, 'gone.txt'), 'bye\n');
  git(['add', '-A']); git(['commit', '-qm', 'base']);
  // mutate working tree
  await writeFile(join(repo, 'keep.txt'), 'one\ntwo\n');   // modify
  await writeFile(join(repo, 'new.txt'), 'fresh\n');        // add
  await rm(join(repo, 'gone.txt'));                          // delete
  git(['add', '-A', '-N']);                                 // intent-to-add new file
});

after(async () => { await rm(repo, { recursive: true, force: true }); });

test('diffNameStatus buckets A/M/D against working tree', async () => {
  const rows = await diffNameStatus(repo, 'HEAD');
  const byPath = Object.fromEntries(rows.map((r) => [r.path, r.status]));
  assert.equal(byPath['new.txt'], 'A');
  assert.equal(byPath['keep.txt'], 'M');
  assert.equal(byPath['gone.txt'], 'D');
});

test('diffNumstat returns per-file counts', async () => {
  const m = await diffNumstat(repo, 'HEAD');
  assert.equal(m.get('keep.txt').added, 1);
  assert.equal(m.get('keep.txt').removed, 0);
  assert.equal(m.get('new.txt').binary, false);
});

test('diffPatch returns a unified diff string', async () => {
  const p = await diffPatch(repo, 'HEAD');
  assert.match(p, /\+two/);
  assert.match(p, /new\.txt/);
});

test('helpers are safe on bad refs', async () => {
  assert.deepEqual(await diffNameStatus(repo, 'nope'), []);
  assert.deepEqual([...(await diffNumstat(repo, 'nope')).keys()], []);
  assert.equal(await diffPatch(repo, 'nope'), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/git-info-diff.test.mjs`
Expected: FAIL — `diffNameStatus is not a function` (or import error).

- [ ] **Step 3: Implement the helpers**

Append to `src/core/git-info.mjs` (reuse the file's existing `_run`):

```javascript
/**
 * Parse `git diff --name-status -M` rows. `head` omitted → diff base vs working tree.
 * Rename/copy rows look like `R100\told\tnew`; status letter is the first char.
 * @returns {Promise<Array<{status:string, path:string, from?:string}>>}
 */
export async function diffNameStatus(projectDir, base, head) {
  if (!projectDir || !base) return [];
  const args = ['diff', '--name-status', '-M', base, ...(head ? [head] : []), '--'];
  const r = await _run('git', args, { cwd: projectDir });
  if (!r.ok) return [];
  const out = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0][0]; // R100 -> R, C75 -> C
    if (status === 'R' || status === 'C') {
      out.push({ status, from: parts[1], path: parts[2] });
    } else {
      out.push({ status, path: parts[1] });
    }
  }
  return out;
}

/**
 * Parse `git diff --numstat -M` into a Map keyed by path. Binary files report
 * `-`/`-` and are flagged `binary:true` with zero counts.
 * @returns {Promise<Map<string,{added:number, removed:number, binary:boolean}>>}
 */
export async function diffNumstat(projectDir, base, head) {
  const m = new Map();
  if (!projectDir || !base) return m;
  const args = ['diff', '--numstat', '-M', base, ...(head ? [head] : []), '--'];
  const r = await _run('git', args, { cwd: projectDir });
  if (!r.ok) return m;
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [a, d, ...rest] = line.split('\t');
    const path = rest[rest.length - 1]; // for renames the last col is the new path
    const binary = a === '-' || d === '-';
    m.set(path, { added: binary ? 0 : Number(a) || 0, removed: binary ? 0 : Number(d) || 0, binary });
  }
  return m;
}

/**
 * Full unified diff (`git diff -M base [head]`). Empty string on failure.
 * @returns {Promise<string>}
 */
export async function diffPatch(projectDir, base, head) {
  if (!projectDir || !base) return '';
  const args = ['diff', '-M', base, ...(head ? [head] : []), '--'];
  const r = await _run('git', args, { cwd: projectDir });
  return r.ok ? r.stdout : '';
}
```

> Note: confirm the private runner is named `_run` in this file (Task-1 investigator confirmed `diffShortstat` uses `_run('git', [...], { cwd })`). If it is exported under another name, match the existing call site.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/git-info-diff.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/git-info.mjs test/git-info-diff.test.mjs
git commit -m "feat(results): add git name-status/numstat/patch diff helpers"
```

---

## Task 2: Pure results assembler

**Files:**
- Create: `src/core/results.mjs`
- Test: `test/results-assemble.test.mjs`

**Interfaces:**
- Consumes: review rows shaped `{ kind, cycle, issues:[{severity,title,detail,location}], summary }` (from `readPipelineExtras`), and diff rows from Task 1.
- Produces:
  - `bucketFiles(nameStatus, numstat) -> { newFiles:[], changedFiles:[], counts:{filesNew,filesChanged,filesDeleted,linesAdded,linesRemoved} }`
  - `selectKeyChecks(reviews) -> Array<{id,severity,title,detail,location,kind,cycle,file?}>` (critical+major, latest cycle per kind, dedup by `severity|title`, sorted critical→major)
  - `splitNitpicks(reviews) -> Array<{severity,title,kind}>` (minor+suggestion, latest cycle per kind)
  - `linkIssues(checks, files) -> void` (mutates: sets `check.file` and appends `check.id` to matching `changedFiles[].issues`)
  - `assembleResults({ nameStatus, numstat, reviews }) -> resultsObject` (single project, no `perProject`)

- [ ] **Step 1: Write the failing test**

```javascript
// test/results-assemble.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketFiles, selectKeyChecks, splitNitpicks, linkIssues, assembleResults }
  from '../src/core/results.mjs';

test('bucketFiles splits new vs changed and sums lines', () => {
  const ns = [
    { status: 'A', path: 'src/new.ts' },
    { status: 'M', path: 'src/mod.ts' },
    { status: 'D', path: 'src/del.ts' },
    { status: 'R', from: 'src/old.ts', path: 'src/ren.ts' },
  ];
  const num = new Map([
    ['src/new.ts', { added: 10, removed: 0, binary: false }],
    ['src/mod.ts', { added: 3, removed: 2, binary: false }],
    ['src/ren.ts', { added: 1, removed: 1, binary: false }],
  ]);
  const b = bucketFiles(ns, num);
  assert.deepEqual(b.newFiles.map((f) => f.path), ['src/new.ts']);
  assert.equal(b.counts.filesNew, 1);
  assert.equal(b.counts.filesChanged, 3); // M + D + R
  assert.equal(b.counts.filesDeleted, 1);
  assert.equal(b.counts.linesAdded, 14);
  assert.equal(b.counts.linesRemoved, 3);
  const ren = b.changedFiles.find((f) => f.status === 'R');
  assert.equal(ren.from, 'src/old.ts');
});

test('selectKeyChecks keeps latest cycle, critical+major, sorted, deduped', () => {
  const reviews = [
    { kind: 'impl', cycle: 1, issues: [{ severity: 'major', title: 'old', detail: '', location: '' }], summary: '' },
    { kind: 'impl', cycle: 2, issues: [
        { severity: 'major', title: 'B', detail: 'd', location: 'src/x.ts:1' },
        { severity: 'critical', title: 'A', detail: 'd', location: '' },
        { severity: 'minor', title: 'nit', detail: '', location: '' },
      ], summary: '' },
    { kind: 'plan', cycle: 1, issues: [{ severity: 'major', title: 'B', detail: 'd', location: '' }], summary: '' },
  ];
  const checks = selectKeyChecks(reviews);
  assert.deepEqual(checks.map((c) => c.title), ['A', 'B']); // critical first, dedup B across kinds
  assert.equal(checks.find((c) => c.title === 'B').kind, 'impl,plan'); // cross-kind tag
  assert.ok(checks.every((c) => c.id));
  assert.ok(!checks.some((c) => c.title === 'old')); // cycle 1 superseded
});

test('splitNitpicks returns only minor+suggestion of latest cycle', () => {
  const reviews = [{ kind: 'impl', cycle: 2, issues: [
    { severity: 'minor', title: 'nit', detail: '', location: '' },
    { severity: 'critical', title: 'A', detail: '', location: '' },
  ], summary: '' }];
  const nits = splitNitpicks(reviews);
  assert.deepEqual(nits.map((n) => n.title), ['nit']);
});

test('linkIssues attaches file to check and issue id to changedFile', () => {
  const checks = [{ id: 'i1', severity: 'major', title: 'B', detail: '', location: 'src/x.ts:1', kind: 'impl' }];
  const files = { changedFiles: [{ path: 'src/x.ts', status: 'M', issues: [] }], newFiles: [] };
  linkIssues(checks, files);
  assert.equal(checks[0].file, 'src/x.ts');
  assert.deepEqual(files.changedFiles[0].issues, ['i1']);
});

test('assembleResults is deterministic (byte-identical)', () => {
  const input = {
    nameStatus: [{ status: 'A', path: 'a.ts' }, { status: 'M', path: 'b.ts' }],
    numstat: new Map([['a.ts', { added: 2, removed: 0, binary: false }], ['b.ts', { added: 1, removed: 1, binary: false }]]),
    reviews: [{ kind: 'impl', cycle: 1, issues: [{ severity: 'critical', title: 'X', detail: 'd', location: 'b.ts:1' }], summary: '' }],
  };
  const r1 = JSON.stringify(assembleResults(input));
  const r2 = JSON.stringify(assembleResults(input));
  assert.equal(r1, r2);
  const r = assembleResults(input);
  assert.equal(r.summary.blockingIssues, 1);
  assert.equal(r.summary.filesNew, 1);
  assert.equal(r.keyThingsToCheck[0].file, 'b.ts'); // linked
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/results-assemble.test.mjs`
Expected: FAIL — cannot find module `../src/core/results.mjs`.

- [ ] **Step 3: Implement the assembler**

```javascript
// src/core/results.mjs
const NEW_STATUS = new Set(['A', 'C']);

/** Bucket name-status rows into new/changed and sum line counts from numstat. */
export function bucketFiles(nameStatus, numstat) {
  const newFiles = [];
  const changedFiles = [];
  let linesAdded = 0, linesRemoved = 0, filesDeleted = 0;
  for (const row of nameStatus) {
    const n = numstat.get(row.path) || { added: 0, removed: 0, binary: false };
    linesAdded += n.added; linesRemoved += n.removed;
    if (row.status === 'D') filesDeleted += 1;
    const base = { path: row.path, status: row.status };
    if (!n.binary) { base.added = n.added; base.removed = n.removed; } else base.binary = true;
    if (NEW_STATUS.has(row.status)) {
      newFiles.push(base);
    } else {
      if (row.from) base.from = row.from;
      base.issues = [];
      changedFiles.push(base);
    }
  }
  newFiles.sort((a, b) => a.path.localeCompare(b.path));
  changedFiles.sort((a, b) => a.path.localeCompare(b.path));
  return {
    newFiles,
    changedFiles,
    counts: {
      filesNew: newFiles.length,
      filesChanged: changedFiles.length,
      filesDeleted,
      linesAdded,
      linesRemoved,
    },
  };
}

/** Keep only the highest-cycle review row per kind. */
function latestPerKind(reviews) {
  const byKind = new Map();
  for (const r of reviews) {
    const cur = byKind.get(r.kind);
    if (!cur || r.cycle > cur.cycle) byKind.set(r.kind, r);
  }
  return [...byKind.values()];
}

const SEV_RANK = { critical: 0, major: 1 };

/** Critical+major issues, latest cycle per kind, deduped by severity|title, sorted. */
export function selectKeyChecks(reviews) {
  const latest = latestPerKind(reviews);
  const seen = new Map(); // key -> check
  let seq = 0;
  for (const row of latest) {
    for (const iss of row.issues) {
      if (iss.severity !== 'critical' && iss.severity !== 'major') continue;
      const key = `${iss.severity}|${iss.title.toLowerCase()}`;
      const existing = seen.get(key);
      if (existing) {
        if (!existing.kind.split(',').includes(row.kind)) existing.kind += `,${row.kind}`;
        continue;
      }
      seen.set(key, {
        id: `check-${seq++}`,
        severity: iss.severity,
        title: iss.title,
        detail: iss.detail,
        location: iss.location,
        kind: row.kind,
        cycle: row.cycle,
      });
    }
  }
  return [...seen.values()].sort((a, b) =>
    (SEV_RANK[a.severity] - SEV_RANK[b.severity]) ||
    (Number(a.id.slice(6)) - Number(b.id.slice(6))));
}

/** Minor+suggestion issues from the latest cycle per kind. */
export function splitNitpicks(reviews) {
  const out = [];
  for (const row of latestPerKind(reviews)) {
    for (const iss of row.issues) {
      if (iss.severity === 'minor' || iss.severity === 'suggestion') {
        out.push({ severity: iss.severity, title: iss.title, kind: row.kind });
      }
    }
  }
  return out;
}

/** Best-effort substring link of checks to changed/new files. Mutates both. */
export function linkIssues(checks, files) {
  const all = [...files.changedFiles, ...files.newFiles];
  for (const c of checks) {
    if (!c.location) continue;
    const hit = all.find((f) => c.location.includes(f.path) || c.location.includes(basename(f.path)));
    if (hit) {
      c.file = hit.path;
      if (Array.isArray(hit.issues)) hit.issues.push(c.id);
    }
  }
}

function basename(p) { const i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }

/** Build the full single-project results object. Pure + deterministic. */
export function assembleResults({ nameStatus, numstat, reviews }) {
  const files = bucketFiles(nameStatus, numstat);
  const keyThingsToCheck = selectKeyChecks(reviews);
  const nitpicks = splitNitpicks(reviews);
  linkIssues(keyThingsToCheck, files);
  return {
    summary: {
      ...files.counts,
      blockingIssues: keyThingsToCheck.length,
      nitpicks: nitpicks.length,
    },
    newFiles: files.newFiles,
    changedFiles: files.changedFiles,
    keyThingsToCheck,
    nitpicks,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/results-assemble.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/results.mjs test/results-assemble.test.mjs
git commit -m "feat(results): deterministic results assembler (files + key checks)"
```

---

## Task 3: Results persistence + read accessors

**Files:**
- Modify: `src/core/results.mjs`
- Modify: `src/core/artifacts.mjs` (add `runDirForRow`, `readRunArtifactText`)
- Test: `test/results-persist.test.mjs`

**Interfaces:**
- Consumes: `recordArtifact(pipelineId, kind, relPath)`, `resolvePipelineId(pipelineDir)` from `artifacts.mjs`; `lookupPipelineRow`, `runDirIndex`, `projectStorePath`/`workspaceStorePath` (internal to artifacts.mjs).
- Produces (in `results.mjs`):
  - `persistResults(pipelineDir, results) -> Promise<void>` (writes `results.json`, records kind `results`)
  - `persistDiffPatch(pipelineDir, patch) -> Promise<void>` (writes `diff-patch.patch`, records kind `diff-patch`)
- Produces (in `artifacts.mjs`):
  - `runDirForRow(row) -> Promise<string>` (absolute on-disk run dir)
  - `readRunArtifactText(key, id, relPath) -> Promise<string|null>`
  - `readRunArtifactJson(key, id, relPath) -> Promise<any|null>`

- [ ] **Step 1: Write the failing test**

```javascript
// test/results-persist.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetForTests } from '../src/core/db.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';
import { persistResults, persistDiffPatch } from '../src/core/results.mjs';
import { listArtifacts } from '../src/core/artifacts.mjs';

let home, prevHome, pipelineDir, id;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'maestro-resp-'));
  prevHome = process.env.MAESTRO_HOME; process.env.MAESTRO_HOME = home;
  _resetForTests();
  // seedPipeline returns { id, dir }; the pipeline row must exist for recordArtifact FK.
  ({ id, dir: pipelineDir } = await seedPipeline());
  await mkdir(pipelineDir, { recursive: true });
});

after(async () => {
  _resetForTests();
  if (prevHome === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

test('persistResults writes results.json and indexes it', async () => {
  await persistResults(pipelineDir, { summary: { filesNew: 1 } });
  const onDisk = JSON.parse(await readFile(join(pipelineDir, 'results.json'), 'utf8'));
  assert.equal(onDisk.summary.filesNew, 1);
  const arts = await listArtifacts(id);
  assert.ok(arts.some((a) => a.kind === 'results' && a.relPath === 'results.json'));
});

test('persistDiffPatch writes diff-patch.patch and indexes it', async () => {
  await persistDiffPatch(pipelineDir, 'diff --git a b\n');
  const txt = await readFile(join(pipelineDir, 'diff-patch.patch'), 'utf8');
  assert.match(txt, /diff --git/);
  const arts = await listArtifacts(id);
  assert.ok(arts.some((a) => a.kind === 'diff-patch'));
});
```

> Confirm `seedPipeline`'s return shape in `test/helpers/db-seed.mjs` (Task-3 investigator: existing tests import `{ seedPipeline } from './helpers/db-seed.mjs'`). If it returns only an id, derive `dir` from the helper's store path or extend the helper; keep this test's assumption (`{ id, dir }`) consistent with whatever it returns.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/results-persist.test.mjs`
Expected: FAIL — `persistResults` not exported.

- [ ] **Step 3: Implement persistence in results.mjs**

Append to `src/core/results.mjs`:

```javascript
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recordArtifact, resolvePipelineId } from './artifacts.mjs';

export const RESULTS_FILE = 'results.json';
export const DIFF_PATCH_FILE = 'diff-patch.patch';
export const OVERVIEW_FILE = 'overview.json';

/** Write results.json into the pipeline dir and index it (best-effort index). */
export async function persistResults(pipelineDir, results) {
  if (!pipelineDir || !results) return;
  await writeFile(join(pipelineDir, RESULTS_FILE), JSON.stringify(results, null, 2));
  const id = resolvePipelineId(pipelineDir);
  if (id) recordArtifact(id, 'results', RESULTS_FILE);
}

/** Write the unified diff patch into the pipeline dir and index it. */
export async function persistDiffPatch(pipelineDir, patch) {
  if (!pipelineDir || patch == null) return;
  await writeFile(join(pipelineDir, DIFF_PATCH_FILE), String(patch));
  const id = resolvePipelineId(pipelineDir);
  if (id) recordArtifact(id, 'diff-patch', DIFF_PATCH_FILE);
}
```

> `resolvePipelineId` is currently a private function in `artifacts.mjs` (Task-3 investigator, line 853). Add `export` to its declaration so `results.mjs` can import it.

- [ ] **Step 4: Implement read accessors in artifacts.mjs**

Add to `src/core/artifacts.mjs` (reuse the `runDirIndex` + store-path pattern from `readRunLogText`, lines ~1483-1501):

```javascript
/**
 * Resolve a pipeline row's absolute on-disk run dir (mirrors readRunLogText).
 * Works for project rows and workspace rows (project_key === 'workspaces/<k>').
 */
export async function runDirForRow(row) {
  const key = row.project_key || row.projectKey;
  const storeRoot = key && key.startsWith('workspaces/')
    ? workspaceStorePath(key.slice('workspaces/'.length))
    : projectStorePath(key);
  const pipelinesDir = join(storeRoot, 'pipelines');
  const dirById = await runDirIndex(pipelinesDir);
  return dirById.get(row.id) || join(pipelinesDir, row.id);
}

/** Read a pipeline-local artifact file as text, or null if absent. */
export async function readRunArtifactText(key, id, relPath) {
  const row = lookupPipelineRow(key, id);
  if (!row) return null;
  const dir = await runDirForRow(row);
  try { return await readFile(join(dir, relPath), 'utf8'); } catch { return null; }
}

/** Read + JSON-parse a pipeline-local artifact, or null. */
export async function readRunArtifactJson(key, id, relPath) {
  const txt = await readRunArtifactText(key, id, relPath);
  if (txt == null) return null;
  try { return JSON.parse(txt); } catch { return null; }
}
```

> Confirm `readFile` is already imported in `artifacts.mjs` (it is — `readRunLogText` uses it). Confirm the row's project-key column name (`project_key`) via the `rowToState`/`lookupPipelineRow` code; the accessor tolerates both `project_key` and `projectKey`.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/results-persist.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/results.mjs src/core/artifacts.mjs test/results-persist.test.mjs
git commit -m "feat(results): persist results.json/diff-patch + run-dir artifact readers"
```

---

## Task 4: Orchestrator builds results at `done`

**Files:**
- Modify: `src/core/orchestrator.mjs`
- Test: `test/orchestrator-results.test.mjs`

**Interfaces:**
- Consumes: `this.pipeline.{id,dir}`, `this.projectDir`, `this.workDir`, `this.checkpointRef`, `this.isWorkspace`, `this.workDirs` (Map projectKey→dir), `this.checkpointRefs` (obj), `readPipelineExtras(id).reviews` from `artifacts.mjs`, Task-1 git helpers, Task-2/3 `assembleResults`/`persistResults`/`persistDiffPatch`.
- Produces: `_buildResults() -> Promise<void>` (best-effort), invoked on the `done` path before teardown.

- [ ] **Step 1: Write the failing test**

```javascript
// test/orchestrator-results.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPerProject, rollupSummary } from '../src/core/results.mjs';

// Unit-test the workspace rollup logic that _buildResults uses (the orchestrator
// wiring itself is exercised by the existing run integration tests + manual run).
test('rollupSummary sums member counts', () => {
  const perProject = {
    a: { summary: { filesNew: 1, filesChanged: 2, filesDeleted: 0, linesAdded: 10, linesRemoved: 1, blockingIssues: 1, nitpicks: 0 } },
    b: { summary: { filesNew: 0, filesChanged: 1, filesDeleted: 1, linesAdded: 4, linesRemoved: 3, blockingIssues: 0, nitpicks: 2 } },
  };
  const s = rollupSummary(perProject);
  assert.equal(s.filesNew, 1);
  assert.equal(s.filesChanged, 3);
  assert.equal(s.filesDeleted, 1);
  assert.equal(s.linesAdded, 14);
  assert.equal(s.blockingIssues, 1);
  assert.equal(s.nitpicks, 2);
});

test('buildPerProject keys results by projectKey', () => {
  const out = buildPerProject([
    { projectKey: 'a', results: { summary: { filesNew: 1 } } },
    { projectKey: 'b', results: { summary: { filesNew: 0 } } },
  ]);
  assert.deepEqual(Object.keys(out), ['a', 'b']);
  assert.equal(out.a.summary.filesNew, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/orchestrator-results.test.mjs`
Expected: FAIL — `buildPerProject`/`rollupSummary` not exported.

- [ ] **Step 3: Add rollup helpers to results.mjs**

```javascript
/** Map [{projectKey, results}] -> { <projectKey>: results }. */
export function buildPerProject(members) {
  const out = {};
  for (const m of members) out[m.projectKey] = m.results;
  return out;
}

/** Sum member summaries into one workspace-level summary. */
export function rollupSummary(perProject) {
  const keys = ['filesNew', 'filesChanged', 'filesDeleted', 'linesAdded', 'linesRemoved', 'blockingIssues', 'nitpicks'];
  const s = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const r of Object.values(perProject)) for (const k of keys) s[k] += (r.summary?.[k] || 0);
  return s;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/orchestrator-results.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire `_buildResults` into the orchestrator**

Add imports near the top of `src/core/orchestrator.mjs`:

```javascript
import { diffNameStatus, diffNumstat, diffPatch } from './git-info.mjs';
import { assembleResults, persistResults, persistDiffPatch, buildPerProject, rollupSummary } from './results.mjs';
import { readPipelineExtras } from './artifacts.mjs';
```

Add the method to the orchestrator class:

```javascript
/**
 * Layer 1: build + persist the deterministic results view while the worktree(s)
 * and checkpoint refs are still live. Best-effort: never throws into run().
 */
async _buildResults() {
  if (!this.pipeline) return;
  try {
    const reviews = readPipelineExtras(this.pipeline.id).reviews || [];
    if (this.isWorkspace) {
      const members = [];
      const patches = [];
      for (const [projectKey, dir] of this.workDirs.entries()) {
        const base = this.checkpointRefs[projectKey];
        if (!base) continue;
        const [ns, num, patch] = await Promise.all([
          diffNameStatus(dir, base), diffNumstat(dir, base), diffPatch(dir, base),
        ]);
        const results = assembleResults({ nameStatus: ns, numstat: num, reviews });
        members.push({ projectKey, results });
        patches.push(`# ${projectKey}\n${patch}`);
      }
      const perProject = buildPerProject(members);
      const results = { summary: rollupSummary(perProject), perProject };
      await persistResults(this.pipeline.dir, results);
      await persistDiffPatch(this.pipeline.dir, patches.join('\n\n'));
    } else {
      const base = this.checkpointRef;
      if (!base) return;
      const dir = this.workDir || this.projectDir;
      const [ns, num, patch] = await Promise.all([
        diffNameStatus(dir, base), diffNumstat(dir, base), diffPatch(dir, base),
      ]);
      const results = assembleResults({ nameStatus: ns, numstat: num, reviews });
      await persistResults(this.pipeline.dir, results);
      await persistDiffPatch(this.pipeline.dir, patch);
    }
  } catch (err) {
    this._log('results', 'warn', `results build failed: ${err.message}`);
  }
}
```

Call it on the `done` path — in `run()`, immediately after the success audit line and **before** the function returns (so it runs ahead of the `finally` teardown). Per the Task-2 investigator the done audit is at line ~472:

```javascript
      await appendAudit(this.pipeline.dir, `Pipeline finished with status **done**.`);
      await this._buildResults();          // <-- ADD: refs + worktree still live here
      this._emit('done', { status: 'done', pipelineDir: this.pipeline.dir });
      return { status: 'done', pipelineDir: this.pipeline.dir };
```

- [ ] **Step 6: Verify the full suite still passes**

Run: `node --test test/orchestrator-results.test.mjs && npm test`
Expected: new tests PASS; existing suite unaffected.

- [ ] **Step 7: Commit**

```bash
git add src/core/orchestrator.mjs src/core/results.mjs test/orchestrator-results.test.mjs
git commit -m "feat(results): build + persist results view on pipeline done"
```

---

## Task 5: Surface results + overview in read API

**Files:**
- Modify: `src/core/artifacts.mjs` (`readPipelineByKey`, `readPipeline`)
- Test: `test/results-read-api.test.mjs`

**Interfaces:**
- Consumes: `runDirForRow` (Task 3), `RESULTS_FILE`/`OVERVIEW_FILE` from `results.mjs`.
- Produces: `readPipelineByKey` and `readPipeline` return objects gain `results: object|null` and `overview: object|null`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/results-read-api.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetForTests } from '../src/core/db.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';
import { persistResults } from '../src/core/results.mjs';
import { readPipelineByKey } from '../src/core/artifacts.mjs';

let home, prevHome, id, dir, key;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'maestro-rapi-'));
  prevHome = process.env.MAESTRO_HOME; process.env.MAESTRO_HOME = home;
  _resetForTests();
  ({ id, dir, projectKey: key } = await seedPipeline()); // helper exposes the store key
  await mkdir(dir, { recursive: true });
  await persistResults(dir, { summary: { filesNew: 2 }, newFiles: [], changedFiles: [], keyThingsToCheck: [], nitpicks: [] });
});

after(async () => {
  _resetForTests();
  if (prevHome === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

test('readPipelineByKey includes persisted results and null overview', async () => {
  const data = await readPipelineByKey(key, id);
  assert.ok(data, 'pipeline found');
  assert.equal(data.results.summary.filesNew, 2);
  assert.equal(data.overview, null);
});
```

> Confirm how `seedPipeline` exposes the store key (`projectKey`) and that `readPipelineByKey(key, id)` accepts it — match the key format the helper seeds (the route regex in server.mjs expects `<slug>-<8hex>`, but `readPipelineByKey` itself takes the raw store key). If the helper doesn't expose the key, read it from the seeded row.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/results-read-api.test.mjs`
Expected: FAIL — `data.results` is `undefined`.

- [ ] **Step 3: Fold results+overview into the readers**

In `readPipelineByKey` (after it resolves `row` and builds the return object), add reads via the row's resolved dir. Modify the return to include them:

```javascript
export async function readPipelineByKey(key, id) {
  const row = lookupPipelineRow(key, id);
  if (!row) return null;
  const dir = await runDirForRow(row);
  const results = await readJsonFile(join(dir, RESULTS_FILE));
  const overview = await readJsonFile(join(dir, OVERVIEW_FILE));
  return {
    state: rowToState(row),
    auditMarkdown: buildAuditMarkdown(row),
    artifacts: await listArtifacts(row.id),
    results,
    overview,
    ...readPipelineExtras(row.id),
  };
}

/** Local helper: read+parse a JSON file, null on any failure. */
async function readJsonFile(p) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}
```

Add the imports at the top of `artifacts.mjs`:

```javascript
import { RESULTS_FILE, OVERVIEW_FILE } from './results.mjs';
```

> Circular-import check: `results.mjs` imports `recordArtifact`/`resolvePipelineId` from `artifacts.mjs`, and `artifacts.mjs` now imports two string constants from `results.mjs`. ES modules tolerate this for hoisted function/const bindings, but if a load-order issue surfaces, inline the two constants (`'results.json'`, `'overview.json'`) directly in `artifacts.mjs` instead of importing them.

Apply the same `results`/`overview` addition to the single-project `readPipeline(projectDir, id)` reader (it resolves its own row/dir — read the two JSON files from that dir and add them to its return object identically).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/results-read-api.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/artifacts.mjs test/results-read-api.test.mjs
git commit -m "feat(results): expose results + overview in pipeline read API"
```

---

## Task 6: Overview agent (Layer 2)

**Files:**
- Create: `src/core/overview-agent.mjs`
- Test: `test/overview-agent.test.mjs`

**Interfaces:**
- Consumes: `runClaude({cwd,prompt,systemPrompt,allowedTools,model,onEvent,signal}) -> {text}` and `extractResultCost` from `claude-runner.mjs`; `safeParseJson` from `protocol.mjs`; `readRunArtifactText`/`readRunArtifactJson`/`runDirForRow`/`lookupPipelineRow` from `artifacts.mjs`; `upsertSubAgent` from `artifacts.mjs`; `OVERVIEW_FILE` from `results.mjs`.
- Produces:
  - `buildOverviewPrompt({ patch, results, reviews }) -> string`
  - `normalizeOverview(parsed) -> { narrative:string, diffFindings:[{severity,file,line,title,detail,newVsReview}], diffCheckTruncated:boolean }`
  - `generateOverview(key, id, { model, signal, force, runClaudeImpl } = {}) -> Promise<overviewObject>`

- [ ] **Step 1: Write the failing test**

```javascript
// test/overview-agent.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOverviewPrompt, normalizeOverview } from '../src/core/overview-agent.mjs';

test('buildOverviewPrompt embeds patch + already-flagged issues', () => {
  const p = buildOverviewPrompt({
    patch: 'diff --git a/x b/x\n+foo',
    results: { summary: { filesNew: 1, filesChanged: 0 } },
    reviews: [{ kind: 'impl', cycle: 1, issues: [{ severity: 'major', title: 'known bug', detail: '', location: 'x:1' }], summary: '' }],
  });
  assert.match(p, /diff --git/);
  assert.match(p, /known bug/);          // so the agent only reports NEW findings
  assert.match(p, /"narrative"/);         // output contract present in prompt
  assert.match(p, /diffFindings/);
});

test('normalizeOverview coerces bad input to a safe shape', () => {
  assert.deepEqual(normalizeOverview(null), { narrative: '', diffFindings: [], diffCheckTruncated: false });
  const n = normalizeOverview({
    narrative: '  did things  ',
    diffFindings: [
      { severity: 'warn', file: 'a.ts', line: 3, title: 't', detail: 'd', newVsReview: true },
      { bogus: 1 },
      { severity: 'nonsense', file: 'b.ts', title: 'x' },
    ],
  });
  assert.equal(n.narrative, 'did things');
  assert.equal(n.diffFindings.length, 2);            // bogus dropped (no title)
  assert.equal(n.diffFindings[0].severity, 'warn');
  assert.equal(n.diffFindings[1].severity, 'note');  // unknown severity -> note
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/overview-agent.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the agent**

```javascript
// src/core/overview-agent.mjs
import { runClaude } from './claude-runner.mjs';
import { safeParseJson } from './protocol.mjs';
import {
  lookupPipelineRow, runDirForRow, upsertSubAgent, readPipelineExtras,
} from './artifacts.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RESULTS_FILE, DIFF_PATCH_FILE, OVERVIEW_FILE } from './results.mjs';

const PATCH_CAP = 60_000; // chars; above this, send hunk headers only

export const OVERVIEW_SYSTEM_PROMPT =
  'You summarize a finished code-change pipeline for a busy engineer. ' +
  'Be precise and terse. Only report diff findings that are NOT already in the ' +
  'provided review issues. Output ONLY the requested JSON object, nothing else.';

export function buildOverviewPrompt({ patch, results, reviews }) {
  const known = reviews.flatMap((r) => r.issues.map((i) => `- [${i.severity}] ${i.title} (${i.location})`)).join('\n') || '(none)';
  let body = patch || '';
  let truncated = false;
  if (body.length > PATCH_CAP) {
    body = body.split('\n').filter((l) => l.startsWith('diff --git') || l.startsWith('@@') || l.startsWith('+++') || l.startsWith('---')).join('\n');
    truncated = true;
  }
  return [
    'Summarize this pipeline run.',
    '',
    `## File summary\n${JSON.stringify(results?.summary || {}, null, 2)}`,
    '',
    `## Already-flagged review issues (do NOT repeat these)\n${known}`,
    '',
    `## Diff ${truncated ? '(TRUNCATED to hunk headers — set diffCheckTruncated:true)' : ''}\n\`\`\`diff\n${body}\n\`\`\``,
    '',
    '## Output contract',
    'Return ONLY this JSON object:',
    '{',
    '  "narrative": "2-4 sentences: what this run did and why it matters",',
    '  "diffFindings": [ { "severity": "warn|note", "file": "path", "line": 0, "title": "...", "detail": "...", "newVsReview": true } ],',
    `  "diffCheckTruncated": ${truncated}`,
    '}',
  ].join('\n');
}

const FINDING_SEV = new Set(['warn', 'note']);

export function normalizeOverview(parsed) {
  if (!parsed || typeof parsed !== 'object') return { narrative: '', diffFindings: [], diffCheckTruncated: false };
  const list = Array.isArray(parsed.diffFindings) ? parsed.diffFindings : [];
  const diffFindings = [];
  for (const f of list) {
    if (!f || typeof f !== 'object' || !f.title) continue;
    diffFindings.push({
      severity: FINDING_SEV.has(f.severity) ? f.severity : 'note',
      file: typeof f.file === 'string' ? f.file : '',
      line: Number.isFinite(Number(f.line)) ? Number(f.line) : null,
      title: String(f.title).trim(),
      detail: typeof f.detail === 'string' ? f.detail.trim() : '',
      newVsReview: f.newVsReview === true,
    });
  }
  return {
    narrative: typeof parsed.narrative === 'string' ? parsed.narrative.trim() : '',
    diffFindings,
    diffCheckTruncated: parsed.diffCheckTruncated === true,
  };
}

/**
 * On-demand: read persisted artifacts, run a one-shot agent, persist + return
 * the overview. Idempotent — returns the cached overview.json unless force.
 * `runClaudeImpl` is injectable for tests.
 */
export async function generateOverview(key, id, { model, signal, force = false, runClaudeImpl = runClaude } = {}) {
  const row = lookupPipelineRow(key, id);
  if (!row) throw new Error('pipeline not found');
  const dir = await runDirForRow(row);

  if (!force) {
    try { return JSON.parse(await readFile(join(dir, OVERVIEW_FILE), 'utf8')); } catch { /* none cached */ }
  }

  const patch = await readFile(join(dir, DIFF_PATCH_FILE), 'utf8').catch(() => '');
  const results = await readFile(join(dir, RESULTS_FILE), 'utf8').then(JSON.parse).catch(() => null);
  const reviews = readPipelineExtras(row.id).reviews || [];

  const prompt = buildOverviewPrompt({ patch, results, reviews });
  let costUsd = null;
  const startedAt = new Date().toISOString();
  const { text } = await runClaudeImpl({
    cwd: dir,
    systemPrompt: OVERVIEW_SYSTEM_PROMPT,
    prompt,
    allowedTools: [],                 // pure reasoning over the prompt; no tools needed
    model,
    signal,
    onEvent: (e) => { if (e.costUsd != null) costUsd = e.costUsd; },
  });

  const overview = normalizeOverview(safeParseJson(text));
  await writeFile(join(dir, OVERVIEW_FILE), JSON.stringify(overview, null, 2));

  // Record as a sub-agent for cost telemetry parity with pipeline nodes.
  upsertSubAgent(row.id, {
    id: `overview-${id}`,
    label: 'overview',
    status: 'finished',
    startedAt,
    finishedAt: new Date().toISOString(),
    costUsd,
    subagentType: 'overview',
  });

  return overview;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/overview-agent.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Add an integration test with an injected runClaude**

```javascript
// append to test/overview-agent.test.mjs
import { test as test2 } from 'node:test';
import { mkdtemp, rm, mkdir, writeFile as wf, readFile as rf } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as j } from 'node:path';
import { _resetForTests } from '../src/core/db.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';
import { persistResults, persistDiffPatch } from '../src/core/results.mjs';
import { generateOverview } from '../src/core/overview-agent.mjs';

test2('generateOverview runs agent once, caches result', async (t) => {
  const home = await mkdtemp(j(tmpdir(), 'maestro-ov-'));
  const prev = process.env.MAESTRO_HOME; process.env.MAESTRO_HOME = home;
  _resetForTests();
  const { id, dir, projectKey } = await seedPipeline();
  await mkdir(dir, { recursive: true });
  await persistResults(dir, { summary: { filesNew: 1 } });
  await persistDiffPatch(dir, 'diff --git a/x b/x\n+hi');

  let calls = 0;
  const fake = async () => { calls++; return { text: '{"narrative":"did x","diffFindings":[],"diffCheckTruncated":false}' }; };

  const first = await generateOverview(projectKey, id, { runClaudeImpl: fake });
  assert.equal(first.narrative, 'did x');
  assert.equal(calls, 1);
  const second = await generateOverview(projectKey, id, { runClaudeImpl: fake });
  assert.equal(calls, 1); // cached, agent not re-run
  assert.equal(second.narrative, 'did x');

  _resetForTests();
  if (prev === undefined) delete process.env.MAESTRO_HOME; else process.env.MAESTRO_HOME = prev;
  await rm(home, { recursive: true, force: true });
});
```

Run: `node --test test/overview-agent.test.mjs`
Expected: PASS (3 tests total).

- [ ] **Step 6: Commit**

```bash
git add src/core/overview-agent.mjs test/overview-agent.test.mjs
git commit -m "feat(results): on-demand overview agent (narrative + diff findings)"
```

---

## Task 7: POST /api/runs/:id/overview

**Files:**
- Modify: `ui/server.mjs`
- Test: `test/server-overview-route.test.mjs`

**Interfaces:**
- Consumes: `generateOverview(key, id, opts)` from `overview-agent.mjs`; existing `resolveProjectDir`, `projectKey` resolution used by the history routes.
- Produces: `POST /api/runs/:id/overview` → 200 `{ overview }`, 404 if pipeline unknown, 500 on agent error. Accepts `?key=<storeKey>` (preferred) or `?projectDir=...`; `?force=1` bypasses the cache.

- [ ] **Step 1: Write the failing test**

```javascript
// test/server-overview-route.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The handler delegates to generateOverview; assert the wiring by importing the
// route factory with an injected core. If server.mjs exports `createApp({ deps })`,
// use it; otherwise this test documents the contract and is run as a smoke check
// against a started server in manual verification (Step 6).
test('overview route contract', () => {
  // Contract: POST /api/runs/:id/overview resolves (key|projectDir) -> calls
  // generateOverview(key, id, { force }) -> 200 { overview } | 404 | 500.
  assert.ok(true);
});
```

> The repo's server may not export an injectable factory. If `ui/server.mjs` exports `createApp`/`makeApp`, write a real supertest-style test injecting a fake `generateOverview`. If it does not (server constructs Express at import time), keep this as a documented-contract placeholder and rely on the manual smoke test in Step 6 — do NOT fabricate a passing assertion against real Claude.

- [ ] **Step 2: Run test to verify it passes trivially / inspect server export**

Run: `node --test test/server-overview-route.test.mjs`
Then: `grep -n "export\|createApp\|app.post\|app.get('/api/runs" ui/server.mjs` to decide injectable vs import-time.

- [ ] **Step 3: Add the route**

Add the import at the top of `ui/server.mjs`:

```javascript
import { generateOverview } from '../src/core/overview-agent.mjs';
```

Add the handler next to the other `/api/runs` routes (mirror the GET handler's param/error shape, server.mjs ~909):

```javascript
app.post('/api/runs/:id/overview', async (req, res) => {
  const id = req.params.id;
  // key takes precedence (history view); else resolve from projectDir like GET /api/runs/:id
  let key = typeof req.query.key === 'string' ? req.query.key : null;
  if (!key) {
    const projectDir = resolveProjectDir(req.query.projectDir);
    if (!projectDir) return badRequest(res, 'key or projectDir is required');
    key = projectKeyForDir(projectDir); // existing helper used by history URLs
  }
  const force = req.query.force === '1' || req.query.force === 'true';
  try {
    const overview = await generateOverview(key, id, { force });
    res.json({ overview });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const code = msg === 'pipeline not found' ? 404 : 500;
    res.status(code).json({ error: msg });
  }
});
```

> Confirm the exact project-key-from-dir helper name (`projectKeyForDir` is a placeholder for whatever maps a projectDir to its store key — the history route at server.mjs:977 and `historyDetailUrl` in app.js use `record.projectKey`; reuse the same resolver `projectKey()` from `artifacts.mjs` if that's what's imported). Match `resolveProjectDir`/`badRequest` to the helpers already used in `ui/server.mjs`.

- [ ] **Step 4: Run the existing server test suite**

Run: `npm test`
Expected: no regressions.

- [ ] **Step 5: Manual smoke test (real, but cheap)**

```bash
# Start the UI server per the repo's existing dev command (e.g. npm run ui / node ui/server.mjs)
# Pick a finished run id+key from the history view, then:
curl -s -X POST "http://localhost:<port>/api/runs/<id>/overview?key=<storeKey>" | head
```
Expected: JSON `{ "overview": { "narrative": "...", "diffFindings": [...] } }`. Second call returns instantly (cached). `?force=1` re-runs.

- [ ] **Step 6: Commit**

```bash
git add ui/server.mjs test/server-overview-route.test.mjs
git commit -m "feat(results): POST /api/runs/:id/overview endpoint"
```

---

## Task 8: Frontend — Results section (Layer 1)

**Files:**
- Modify: `ui/public/app.js`
- Modify: `ui/public/style.css`
- Test: `test/results-view-helpers.test.mjs` (pure shaping helpers only)

**Interfaces:**
- Consumes: `data.results` from the detail fetch (`loadHistDetail`, app.js ~5696).
- Produces: pure helpers `summaryChips(results) -> string[]` and `renderResults(host, results)` (DOM); a "Results" container painted inside the detail view.

- [ ] **Step 1: Write the failing test for the pure helper**

```javascript
// test/results-view-helpers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryChips } from '../ui/public/results-view.mjs';

test('summaryChips renders human counts', () => {
  const chips = summaryChips({ summary: { filesNew: 3, filesChanged: 7, filesDeleted: 1, linesAdded: 412, linesRemoved: 88, blockingIssues: 2 } });
  assert.deepEqual(chips, ['3 new', '7 changed', '1 deleted', '+412 / −88', '2 to check']);
});

test('summaryChips omits zero buckets', () => {
  const chips = summaryChips({ summary: { filesNew: 0, filesChanged: 2, filesDeleted: 0, linesAdded: 5, linesRemoved: 0, blockingIssues: 0 } });
  assert.deepEqual(chips, ['2 changed', '+5 / −0', 'Clean']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/results-view-helpers.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the pure helper module**

```javascript
// ui/public/results-view.mjs  (ESM, importable by both the browser and node:test)
export function summaryChips(results) {
  const s = (results && results.summary) || {};
  const chips = [];
  if (s.filesNew) chips.push(`${s.filesNew} new`);
  if (s.filesChanged) chips.push(`${s.filesChanged} changed`);
  if (s.filesDeleted) chips.push(`${s.filesDeleted} deleted`);
  chips.push(`+${s.linesAdded || 0} / −${s.linesRemoved || 0}`);
  chips.push(s.blockingIssues ? `${s.blockingIssues} to check` : 'Clean');
  return chips;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/results-view-helpers.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Render the Results section in app.js**

In `app.js`, import the helper (the page already loads ES modules; if app.js is a classic script, copy `summaryChips` inline instead of importing) and add a `renderResults(host, results)` that builds the section using the existing `.issue.sev-*` classes for `keyThingsToCheck`. Call it from `loadHistDetail` after the clarify paint:

```javascript
// inside loadHistDetail, after paintClarifyBar(...)
const resHost = detail.querySelector('.results-section');
if (resHost) renderResults(resHost, data.results, { id, projectKey: record && record.projectKey });
```

`renderResults` (mirror `renderGateBody`'s issue-list construction, app.js:2736):

```javascript
function renderResults(host, results, ctx) {
  host.innerHTML = '';
  if (!results) { host.textContent = 'No results for this run.'; return; }
  // summary chips
  const chips = document.createElement('div');
  chips.className = 'results-chips';
  summaryChips(results).forEach((t) => {
    const c = document.createElement('span'); c.className = 'results-chip'; c.textContent = t; chips.appendChild(c);
  });
  host.appendChild(chips);

  // Key things to check (review issues) — reuse sev-* classes
  const checks = results.keyThingsToCheck || [];
  const checksWrap = document.createElement('div'); checksWrap.className = 'results-checks';
  if (!checks.length) {
    const ok = document.createElement('div'); ok.className = 'results-clean';
    ok.textContent = 'Clean — no blocking issues flagged.'; checksWrap.appendChild(ok);
  } else {
    const ul = document.createElement('ul'); ul.className = 'issues';
    checks.forEach((c) => {
      const li = document.createElement('li'); li.className = `issue sev-${c.severity}`;
      const head = document.createElement('div'); head.className = 'issue-head';
      const sev = document.createElement('span'); sev.className = 'issue-sev'; sev.textContent = c.severity;
      const ttl = document.createElement('span'); ttl.className = 'issue-title'; ttl.textContent = c.title;
      head.append(sev, ttl); li.appendChild(head);
      if (c.detail) { const d = document.createElement('div'); d.className = 'issue-detail'; d.textContent = c.detail; li.appendChild(d); }
      if (c.location) { const l = document.createElement('div'); l.className = 'issue-loc'; l.textContent = c.location; li.appendChild(l); }
      ul.appendChild(li);
    });
    checksWrap.appendChild(ul);
  }
  host.appendChild(checksWrap);

  // New + changed file lists
  host.appendChild(fileList('New files', results.newFiles || []));
  host.appendChild(fileList('Changed files', results.changedFiles || []));
}

function fileList(title, files) {
  const sec = document.createElement('div'); sec.className = 'results-files';
  const h = document.createElement('div'); h.className = 'results-files-h'; h.textContent = `${title} (${files.length})`; sec.appendChild(h);
  const ul = document.createElement('ul');
  files.forEach((f) => {
    const li = document.createElement('li');
    const name = f.from ? `${f.from} → ${f.path}` : f.path;
    const counts = f.binary ? 'binary' : (f.added != null ? `+${f.added} −${f.removed}` : '');
    li.textContent = `${f.status}  ${name}  ${counts}`.trim();
    ul.appendChild(li);
  });
  sec.appendChild(ul); return sec;
}
```

Add the `.results-section` container to the detail template (where `.clarify-bar` is added in the detail DOM scaffold), e.g.:

```javascript
// where the detail panel scaffold is built, alongside .clarify-bar:
'<div class="results-section"></div>'
```

- [ ] **Step 6: Add styles**

Append to `ui/public/style.css`:

```css
.results-section{margin-top:14px;}
.results-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;}
.results-chip{font-size:12px;background:var(--chip-bg,#f1f1f4);border:1px solid var(--line);border-radius:999px;padding:2px 10px;}
.results-clean{color:var(--green-ink,#1a7f37);font-size:13px;padding:6px 0;}
.results-files{margin-top:10px;}
.results-files-h{font-weight:700;font-size:13px;margin-bottom:4px;}
.results-files ul{list-style:none;padding:0;margin:0;font-family:ui-monospace,monospace;font-size:12px;}
.results-files li{padding:2px 0;}
```

- [ ] **Step 7: Manual verification**

Start the UI, open a finished run from history. Expected: a Results section shows summary chips, "key things to check" (or green Clean), and New/Changed file lists matching `git diff --name-status` for that run. Zero network calls beyond the detail fetch.

- [ ] **Step 8: Commit**

```bash
git add ui/public/app.js ui/public/results-view.mjs ui/public/style.css test/results-view-helpers.test.mjs
git commit -m "feat(results): render mechanical results section in run detail"
```

---

## Task 9: Frontend — Generate overview button (Layer 2)

**Files:**
- Modify: `ui/public/app.js`, `ui/public/results-view.mjs`, `ui/public/style.css`
- Test: `test/results-view-helpers.test.mjs` (extend)

**Interfaces:**
- Consumes: `POST /api/runs/:id/overview?key=...` (Task 7); `data.overview` from the detail fetch (cached runs).
- Produces: `mergeFindings(checks, diffFindings) -> Array` (tags origin); a button that fetches + renders the overview, then re-renders checks with agent findings appended.

- [ ] **Step 1: Extend the helper test**

```javascript
// append to test/results-view-helpers.test.mjs
import { mergeFindings } from '../ui/public/results-view.mjs';

test('mergeFindings tags origin and never drops review checks', () => {
  const checks = [{ id: 'c1', severity: 'critical', title: 'review issue', origin: 'review' }];
  const findings = [{ severity: 'warn', file: 'a.ts', line: 2, title: 'agent issue', detail: 'd', newVsReview: true }];
  const merged = mergeFindings(checks, findings);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].origin, 'review');
  assert.equal(merged[1].origin, 'agent');
  assert.equal(merged[1].isNew, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/results-view-helpers.test.mjs`
Expected: FAIL — `mergeFindings` not exported.

- [ ] **Step 3: Implement `mergeFindings`**

```javascript
// add to ui/public/results-view.mjs
export function mergeFindings(checks, diffFindings) {
  const reviewSide = (checks || []).map((c) => ({ ...c, origin: c.origin || 'review' }));
  const agentSide = (diffFindings || []).map((f) => ({
    severity: f.severity, title: f.title, detail: f.detail,
    location: f.file ? `${f.file}${f.line != null ? ':' + f.line : ''}` : '',
    origin: 'agent', isNew: f.newVsReview === true,
  }));
  return [...reviewSide, ...agentSide];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/results-view-helpers.test.mjs`
Expected: PASS.

- [ ] **Step 5: Wire the button + fetch in app.js**

In `renderResults`, add a "Generate overview" button above the checks; if `results`/detail already carries `overview` (cached), render it immediately. The fetch mirrors `postAnswer` (app.js:2811):

```javascript
// in renderResults(host, results, ctx), after chips:
const ov = document.createElement('div'); ov.className = 'results-overview';
host.appendChild(ov);

const btn = document.createElement('button'); btn.className = 'results-overview-btn';
btn.textContent = ctx.overview ? 'Regenerate overview' : 'Generate overview';
btn.addEventListener('click', () => loadOverview(ov, btn, ctx, results, !!ctx.overview));
host.insertBefore(btn, ov);

if (ctx.overview) paintOverview(ov, ctx.overview, results);
```

```javascript
async function loadOverview(host, btn, ctx, results, force) {
  btn.disabled = true; btn.textContent = 'Generating…';
  try {
    const qs = new URLSearchParams();
    if (ctx.projectKey) qs.set('key', ctx.projectKey); else qs.set('projectDir', ctx.projectDir || '');
    if (force) qs.set('force', '1');
    const res = await fetch(`/api/runs/${encodeURIComponent(ctx.id)}/overview?${qs}`, { method: 'POST' });
    const data = await safeJson(res);
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    paintOverview(host, data.overview, results);
    btn.textContent = 'Regenerate overview';
  } catch (e) {
    host.textContent = `Overview failed: ${e.message}`;
    btn.textContent = 'Retry overview';
  } finally { btn.disabled = false; }
}

function paintOverview(host, overview, results) {
  host.innerHTML = '';
  if (overview.narrative) {
    const n = document.createElement('div'); n.className = 'results-narrative'; n.textContent = overview.narrative; host.appendChild(n);
  }
  // re-render the checks list with agent findings merged in
  const merged = mergeFindings(results.keyThingsToCheck || [], overview.diffFindings || []);
  const ul = document.createElement('ul'); ul.className = 'issues';
  merged.forEach((c) => {
    const li = document.createElement('li'); li.className = `issue sev-${c.severity}`;
    const head = document.createElement('div'); head.className = 'issue-head';
    const sev = document.createElement('span'); sev.className = 'issue-sev'; sev.textContent = c.severity;
    const tag = document.createElement('span'); tag.className = `issue-origin origin-${c.origin}`;
    tag.textContent = c.origin === 'agent' ? (c.isNew ? 'agent · new' : 'agent') : 'review';
    const ttl = document.createElement('span'); ttl.className = 'issue-title'; ttl.textContent = c.title;
    head.append(sev, tag, ttl); li.appendChild(head);
    if (c.detail) { const d = document.createElement('div'); d.className = 'issue-detail'; d.textContent = c.detail; li.appendChild(d); }
    if (c.location) { const l = document.createElement('div'); l.className = 'issue-loc'; l.textContent = c.location; li.appendChild(l); }
    ul.appendChild(li);
  });
  host.appendChild(ul);
  if (overview.diffCheckTruncated) {
    const w = document.createElement('div'); w.className = 'results-trunc'; w.textContent = 'Diff was large — agent saw hunk headers only.'; host.appendChild(w);
  }
}
```

Pass `overview` into the ctx where `renderResults` is called in `loadHistDetail`:

```javascript
if (resHost) renderResults(resHost, data.results, { id, projectKey: record && record.projectKey, projectDir, overview: data.overview });
```

- [ ] **Step 6: Add styles**

Append to `ui/public/style.css`:

```css
.results-overview-btn{margin:6px 0;font-size:12px;padding:5px 12px;border:1px solid var(--line);border-radius:8px;background:#fff;cursor:pointer;}
.results-overview-btn:disabled{opacity:.6;cursor:default;}
.results-narrative{font-size:13px;line-height:1.5;background:var(--chip-bg,#f7f7fa);border-radius:10px;padding:10px 12px;margin:8px 0;}
.issue-origin{font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding:1px 6px;border-radius:999px;font-weight:700;}
.origin-agent{background:var(--blue-bg);color:var(--blue-ink);}
.origin-review{background:var(--chip-bg,#eee);color:#555;}
.results-trunc{font-size:11px;color:#946;margin-top:6px;}
```

- [ ] **Step 7: Manual verification**

Open a finished run. Expected: Layer 1 renders instantly (no overview). Click "Generate overview" → spinner → narrative + merged checks (agent findings tagged `agent`/`new`, review issues still present). Reopen the run → overview shows immediately from cache (no second agent call; verify via no new `sub_agents` cost). "Regenerate" forces a fresh run.

- [ ] **Step 8: Commit**

```bash
git add ui/public/app.js ui/public/results-view.mjs ui/public/style.css test/results-view-helpers.test.mjs
git commit -m "feat(results): on-demand overview button (narrative + agent findings)"
```

---

## Self-Review

**Spec coverage:**
- §2 two-layer architecture → Tasks 4 (Layer 1 build), 6 (Layer 2 agent). ✓
- §4.1 name-status buckets → Task 1 + Task 2 `bucketFiles`. ✓
- §4.2 persist patch → Task 3 `persistDiffPatch`, Task 4 wiring. ✓
- §4.3 key-things selection rule (latest cycle, critical+major, dedup, sort) → Task 2 `selectKeyChecks`. ✓
- §4.4 file↔issue linking → Task 2 `linkIssues`. ✓
- §4.5 results JSON shape + perProject rollup → Task 2 `assembleResults`, Task 4 `buildPerProject`/`rollupSummary`. ✓
- §5 overview agent (form, trigger, bounded input, output) → Tasks 6, 7. ✓
- §5.3 size cap / truncation flag → Task 6 `buildOverviewPrompt` PATCH_CAP + `diffCheckTruncated`. ✓
- §6 shared context bundle accessor → partially: `readRunArtifactJson`/`readRunArtifactText` + `readPipelineExtras` cover the substrate. **Gap:** spec §6 names a single `readRunContextBundle(pipelineId) -> { diffPatch, results, reviews, audit }`. **Added below.**
- §7 serving + render → Tasks 5, 7, 8, 9. ✓
- §8 edge cases (no diff, missing patch, binary, truncation, failure isolation) → covered across Tasks 2/4/6/9; failure isolation via best-effort `_buildResults` (Task 4) and button retry (Task 9). ✓
- §10 acceptance → criteria map to Tasks 2 (determinism), 4 (counts), 6 (cache/cost), 9 (additive findings), 4 (failure non-blocking), 5 (renders post-teardown). ✓

**Gap fix — add to Task 3 (Step 3, results.mjs):**

```javascript
import { readPipelineExtras } from './artifacts.mjs';
/**
 * §6 shared context bundle for a finished run — the substrate for the overview
 * agent and a future Q&A agent. `dir` is the absolute pipeline dir.
 */
export async function readRunContextBundle(dir, pipelineId) {
  const read = async (f) => { try { return await readFile(join(dir, f), 'utf8'); } catch { return null; } };
  const resultsTxt = await read(RESULTS_FILE);
  return {
    diffPatch: await read(DIFF_PATCH_FILE),
    results: resultsTxt ? JSON.parse(resultsTxt) : null,
    reviews: readPipelineExtras(pipelineId).reviews || [],
    audit: null, // audit markdown is rebuilt by buildAuditMarkdown at the API layer
  };
}
```
Add a one-line export assertion to `test/results-persist.test.mjs`: `assert.equal(typeof readRunContextBundle, 'function')`.

**Placeholder scan:** The only intentional deferrals are clearly flagged investigator-confirmation notes (helper names: `_run`, `resolvePipelineId` export, `seedPipeline` shape, `projectKeyForDir`, server injectability). Each names the exact grep to confirm and the fallback. No "TODO/add error handling" placeholders remain.

**Type consistency:** `assembleResults` output shape is identical across Task 2 (producer), Task 4 (workspace wrapper adds `perProject`+`summary`), Task 5 (reader passes through), Task 8/9 (consumer reads `summary`/`newFiles`/`changedFiles`/`keyThingsToCheck`/`nitpicks`). `keyThingsToCheck[].id`/`severity`/`title`/`detail`/`location`/`file` consistent between Task 2 and Task 8. Overview shape `{narrative,diffFindings:[{severity,file,line,title,detail,newVsReview}],diffCheckTruncated}` consistent between Task 6 (producer) and Task 9 (`mergeFindings` consumer).
