# Maestro UI Redesign — v2 (Refined Implementation Plan)

> **Supersedes `UI_REDESIGN_PLAN.md`.** This v2 was produced by a 4-agent parallel review of v1 (codebase-fidelity, design-system-fidelity, multi-run-architecture, and execution-sequencing lenses). Every correction below is backed by a verbatim quote + line number from the live source. v1's design intent is sound and most of its values are exact; v2 fixes the **factual gaps in the multi-run protocol**, the **broken extraction recipe**, the **`<ul>/<li>` history hooks**, the **broken-on-`main` task sequencing**, and adds the **ground-truth contracts** v1 left unpinned.
>
> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:executing-plans` or `superpowers:subagent-driven-development`. Steps use checkbox (`- [ ]`) syntax. Attach this file + the five mockups + the source HTML to the implementation session.

**Goal (unchanged from v1):** Migrate the Maestro web UI from its current two-column cool-grey theme to the "Refined" mockup — warm off-white, left sidebar, three routed views (New / Running / History), concurrent multi-pipeline Running view, Poppins + JetBrains Mono, large rounded white cards, black pill buttons, pastel status families, iOS toggles.

**Architecture (unchanged):** No build step, no framework. Vanilla ESM in `ui/public/` (`index.html`, `style.css`, `app.js`) served statically by `ui/server.mjs`. The migration is (1) full `style.css` rewrite, (2) `index.html` restructure into a sidebar shell + three `.view` sections, (3) `app.js` refactor adding client-side routing + a **multi-run state model**, (4) self-hosted woff2 fonts.

---

## A. What changed from v1 (read this first)

| # | v1 said | Reality (source) | v2 fix | Sev |
|---|---|---|---|---|
| A1 | RunModel reads `startedAt` from `hello.runs[i]`; "Server needs **no** change" | `summarizeRuns()` (`server.mjs:114-122`) emits **only** `{runId, projectDir, title, status, pendingQuestion}` — **no `startedAt`**, and the `entry` (`server.mjs:241-249`) stores no timestamp | **One-field server change**: add `startedAt` to `entry` + `summarizeRuns()`; AND backfill from the replayed `state` event in `onState`. v1's "no server change" claim is **retracted** for this single field. | **CRIT** |
| A2 | `hello` handler upserts `{runId,title,projectDir,status,startedAt}` | `hello.runs[i]` **already includes `pendingQuestion`** (`server.mjs:120`), which v1 drops | Seed `r.pendingQuestion` from hello and render the panel from it. Otherwise a **reload during a paused run deadlocks** the UI (no question shown, run un-answerable). | **CRIT** |
| A3 | `liveRuns()` filters `status ∈ {starting,running,waiting}`; Task 7 sets `status:'waiting'` | The **server never emits `'waiting'`** — on a question it only stores `pendingQuestion`, status stays `'running'` (`server.mjs:154-156`) | Treat `pendingQuestion != null` (not the status string) as the authority for "paused/waiting". | **CRIT** |
| A4 | `#history` is a list; Task 8 rewrites it to `.hist-card`s | `#history` is a `<ul>` (`index.html:143`); `renderHistory` emits `<li>` (`app.js:1124-1147`), **and so do `renderHistoryError` and the project-delete reset** (`app.js:920`) | Task "History" must rewrite **every** `#history` writer (incl. error + delete paths) to `.hist-card`/`.hist-empty` divs. Add a grep gate. | **CRIT** |
| A5 | Commit per task on `main`; theme test stays red until Task 11A | Two **non-bootable** windows (CSS-without-markup; markup-without-JS → boot `TypeError`) + `npm test` red for ~6 commits | **Resequence** (§E): merge 1+11A (CSS+test, green), merge 2+3+4 (shell+router+form), merge 5+6 (state+cards). Recommend a `ui-redesign` branch; if staying on `main`, the squashes are **mandatory**. | **CRIT** |
| A6 | §0 Node decode one-liner + class grep extract the mockup CSS | The Node one-liner matches the **wrong `<!DOCTYPE`** (478 bytes); the `class=\\\\"` grep returns **0 matches** | Use the **corrected recipe** in §C (tested: yields 56 597 chars / 1085 lines). | **CRIT** |
| A7 | Stepper: "`.n-green` solid" | `.n-green/.n-peach/...` are **tints**; the solid disc comes from state overrides `.stage.s-done .num{background:var(--green);color:#fff}` (`s-now`→peach, `s-stop`→red) | Add the three state-override rules. `.s-pause` relies on `.n-amber` being self-solid (correct). | **CRIT** |
| A8 | Task 4: retarget "the `$$('.step', el.steps)` lookups used by config" | Config fns (`renderStepConfigs/saveStep/addModelFlow`) use **document-scoped** `document.querySelector('.step-model[data-role=…]')` and need no change. **Only** the delegated `el.steps.addEventListener('change')` at `app.js:387` must be retargeted. `$$('.step', el.steps)` belongs to the **stepper** funcs, unrelated to config. | Narrow the retarget to one listener. | HIGH |
| A9 | Remove the single-run filter at `app.js:160` | There's a **coupled line at `app.js:161`**: `if (!state.runId && msg.runId) state.runId = msg.runId;` — equally single-run | Remove **both 160 and 161**. | HIGH |
| A10 | Task 1 Step 10: "style `.q-submit-row` button as `.btn-go`" | The submit/gate buttons are emitted with `class="btn btn-primary"` / `class="btn"` (`app.js:562,635,641`), **not** `btn-go` | Either restyle `.btn`/`.btn-primary` to the black-pill look, or change the JS class. Commit to: **restyle `.btn`/`.btn-primary`** (zero JS churn). | HIGH |
| A11 | History chips "Refine ×N / Review ×N"; "omit if not in record" | The cycle-count data source is **unverified** — it's the only feed for a whole mockup feature | Add a **recon step on `src/core/artifacts.mjs`** (`listPipelines`/`readPipeline`) before building the chips. | HIGH |
| A12 | Stepper sublabel "Opus 4.8 · xhigh" derived from `state.config` | A run's real model/effort is **never broadcast**; `state.config` is *this tab's* selection for *its* project | Show the sublabel **only for runs this tab started** (`local:true` flag); omit for foreign/restored runs. | HIGH |
| A13 | Per-card `#autoscroll`/`#clear-log`/`#log` | Cloning these **ids** into every card → duplicate ids; `$('#autoscroll')`/`el.autoscroll` break | Make per-card controls **class-based** (`.run-log .autoscroll`), scoped via `closest('.run-card')`; keep a **single** global autoscroll toggle in the Running header. Remove boot-time `el.autoscroll/el.clearLog/el.log` global caches. | HIGH |
| A14 | `renderStepConfigs` "unchanged in behavior" | Its lock predicate reads `state.status ∈ {running,starting,waiting}` (`app.js:303`) — a scalar removed by the multi-run refactor | **Drop the lock** (New-form config always applies to the *next* run). Ensure no dangling `state.status` read throws. | HIGH |
| A15 | Subscribe-all on open **and** in the hello handler | `subscribe` is **not idempotent** — it re-replays the whole buffer each time (`server.mjs:83-86`). Double-subscribe on reconnect duplicates every log line + re-fires `done` | **Subscribe exactly once** — only from the `hello` handler, only for **non-terminal** runs. Delete the `onopen` re-subscribe loop. Make `onDone/onError` idempotent. | HIGH |
| A16 | Terminal runs "drop out of Running into History" | Server **never evicts** runs (no `runs.delete` in `server.mjs`); `hello` lists every run since process start, forever | Skip subscribe for terminal `hello` runs; render them straight to History. **Client-side evict** terminal RunModels' `logLines`/`el` after rendering. | MED |
| A17 | `grep -c 'data-view'` expecting 3 | `grep -c` counts **lines**, not occurrences | Use `grep -o 'data-view' \| wc -l`, or assert in a content test. Other command fixes in §E. | MED |
| A18 | (no a11y / reduced-motion / empty-state / responsive-switcher coverage) | New `@keyframes pulse/blink` + hover transforms have no reduced-motion guard; below 1080px the sidebar hides leaving **no view switcher** (users stranded) | Add §F coverage tasks. | MED |

**Confirmed exact — port v1 verbatim, no change:** all `:root` tokens (§1.1), full typography scale (§1.2), all icon `d` paths + brand mark (§1.4), and the bulk of the §3.1 component table (radii, shadows, sidebar 248px, `.run-card.attention` ring, `.seg`, inputs, `.switch` 44×26, `.stages.compact`, `.stage-cfg` accent order violet/green/peach/blue, `.log` `#FBFBF9`, `.qpanel` `#FFFDF8`, `.qopt.sel`, badges, chips). The design-fidelity review found **zero value mismatches** in these — only the additions in A7 and §1.5 below.

---

## B. Ground truth — pinned contracts (embed these; do not re-derive)

These are the authoritative server/client facts the implementation depends on. All verified against the live source.

### B1. `hello` greeting — exact shape
`server.mjs:66` → `send(ws, { type:'hello', runs: summarizeRuns() })`. Each run object (`summarizeRuns()`, `server.mjs:114-122`) is **exactly**:
```js
{ runId, projectDir, title, status, pendingQuestion }   // runId === entry.id (randomUUID)
```
- **No `startedAt`, no `phase`, no `cycle`, no `maxStepIdx`, no model/effort.**
- `status` ∈ `starting | running | done | error | stopped`. **`waiting` is never sent** — a paused run is `status:'running'` with `pendingQuestion != null`.
- `pendingQuestion` is the **full question event** when paused (`entry.pendingQuestion = event`, `server.mjs:155`): `{type:'question', runId, id, kind, questions, issues}` — enough to render the panel directly.

### B2. Inbound WS protocol — exact
The server understands **one** client→server message (`server.mjs:75-87`):
```js
{ type:'subscribe', runId }   // → replays that run's buffered events to THIS socket
```
- Replay = `for (const ev of entry.events) send(ws, ev)` (`server.mjs:83-86`). **Not idempotent** — each subscribe re-sends the whole buffer.
- Buffer is a per-run ring capped at `MAX_BUFFER = 5000` (`server.mjs:42,145`); oldest events are spliced out on overflow → **long runs lose their earliest log lines and possibly their first `state` (→ `startedAt`) on replay.**
- A connect-time `ws://host/ws?runId=<id>` query also triggers one replay (`server.mjs:68-71`); the client uses bare `/ws` so this path is unused — keep it that way.
- Any other inbound message type is parsed and **silently ignored**.

### B3. REST contracts
| Endpoint | Request | Response / behavior | Source |
|---|---|---|---|
| `POST /api/run` | `{projectDir, title, prompt\|promptMarkdown, maxRefine, maxReview, mock, extras}` | `{ runId }`; 400 if no projectDir / no prompt. Every subsequent event is tagged with this same `runId`. | `server.mjs:198-267` |
| `POST /api/stop` | `{ runId }` | 400 if `!runId \|\| !runs.has(runId)`; calls `orch.stop()`, sets `entry.status='stopped'`, clears `pendingQuestion`, `{ok:true}`. Emits a `state(stopped)` then a **`done` with `status:'stopped'`**. | `server.mjs:291-303` |
| `POST /api/answer` | `{ runId, id, payload }` | 400 if `!runId\|\|!runs.has(runId)` or `!id`. **A stale `id` (after done/stop) returns silently false — NOT an HTTP error.** Do not treat HTTP 200 as proof the answer landed; confirm via the next `phase`/`state` event. | `server.mjs:273-285`, `orchestrator.mjs:131-138` |
| `GET /api/runs?projectDir` | — | `{ pipelines, live }`. `pipelines[]` = disk records `{id,dir,title,status,startedAt,mtime}` (`artifacts.mjs`). `live[]` = `{id,runId,title,status,live:true}` (**no startedAt/cycle**). | `server.mjs:308-322` |
| `GET /api/runs/:id` | — | `{ auditMarkdown, … }` (used by `viewPipeline`). | — |

### B4. Event sequences (for correct card transitions)
- **Each phase:** a `phase` event, then a `state` snapshot immediately after (`orchestrator.mjs:679-680`). `state` carries `status`, `phase`, `cycle`, **and `startedAt`** (`getState()` → `this.state`, set at `orchestrator.mjs:168`). → `onState` is the place to backfill `startedAt`, status, and cycle.
- **Stop:** `state(stopped)` → `done {status:'stopped', pipelineDir}` (`orchestrator.mjs:142-158, 271`).
- **Error:** `error` event → **`done {status:'error'}`** (`orchestrator.mjs:279,284`). Both fire — `onError` and `onDone` must converge (idempotent).
- **Done (success):** `_persist()` (writes `state.json`) completes **before** the `done` emit (`orchestrator.mjs:260-262`), so a subsequent `GET /api/runs` will see the persisted record. `_persist()` is best-effort and swallows errors (`orchestrator.mjs:726-733`) — a failed write means the run never reaches disk-backed History.

### B5. `appendLog` shape — keep verbatim
`appendLog({ source, level, text, ts })` (`app.js:406-431`): builds `<div class="log-line lvl-<level||'info'>">` with children `<span class="log-ts">`(HH:MM:SS) / `<span class="log-src">`(`[source]`) / `<span class="log-msg">`(text); skips when `text==null`; caps DOM at 4000 lines; autoscrolls if the toggle is checked. Levels in use: `info`(default), `phase`, `error`, `system`, `artifact` (`warn` is styled but never emitted — harmless). The multi-run version scopes the container to `r.el .log`.

### B6. Data-availability UNKNOWN (resolve before building)
History "Refine ×N / Review ×N" chips and the per-step model·effort sublabels have **no confirmed source**:
- Cycle counts: only available if persisted in the `state.json` read by `listPipelines` (`src/core/artifacts.mjs`) — **unverified**. Recon required.
- Model/effort per run: **not in any event, not in `hello`, not in `live[]`** — the orchestrator resolves it internally and never broadcasts it. Trustworthy only for runs this tab started.

---

## C. Corrected source-extraction recipe (replaces v1 §0)

The source of truth for every pixel value is `/Users/denislavprinov/Downloads/Maestro Refined (standalone) (1).html` (441 KB). The inner app document is a JSON-escaped string on **line 182**; do not `Read` the whole file. These commands are **tested**:

```bash
FILE="/Users/denislavprinov/Downloads/Maestro Refined (standalone) (1).html"

# CSS custom properties — WORKS AS WRITTEN (all 27 tokens):
grep -o -- '--[a-zA-Z-]*:[^;]*;' "$FILE" | sort -u

# Classes used in markup — FIXED (single-backslash escaping inside the JSON string):
grep -o 'class=\\"[^\\]*\\"' "$FILE" | sort -u

# Decode the inner app doc — FIXED (target line 182 + JSON.parse the whole string):
node -e 'const fs=require("fs");const L=fs.readFileSync(process.argv[1],"utf8").split("\n");let raw=L[181].trim().replace(/[,)\]]+\s*$/,"");const inner=JSON.parse(raw);fs.writeFileSync("/tmp/maestro_inner.html",inner);console.log("wrote",inner.length,"chars")' "$FILE"
# verify: wc -l /tmp/maestro_inner.html  → 1085 ; grep -n ':root' /tmp/maestro_inner.html → 226
```

Inside `/tmp/maestro_inner.html`: `:root` is L226-247, the full `<style>` is L220-585, body markup L587-995. **Rule: when a value here differs from §1/§3, this file wins.** (v1's recipe targeted the wrong `<!DOCTYPE` and used triple-backslash class grep — both dead.)

---

## 1. Design system

### 1.1 Color tokens — **use v1 §1.1 verbatim** (confirmed exact against source; zero mismatches)
All surfaces, the six status-family triples, `--r-card:24px`, `--r-ctrl:14px`, both shadows, `--sans`/`--mono`. (The `--sans`/`--mono` tokens don't exist in the source — they're a fine additive tokenization; the source uses literal font stacks.)

### 1.2 Typography — **use v1 §1.2 verbatim** (confirmed exact). Note: compact-stepper sublabel is `10.5px` (correct as written).

### 1.3 Self-hosted fonts
Poppins 400/500/600/700 + JetBrains Mono 400, via `@fontsource`, copied into `ui/public/fonts/` and loaded by `@font-face` at the top of `style.css` (v1 §1.3 block is correct).
- **Decision (mono 500):** the source declares JetBrains Mono **500**, used only by `.run-title .hash`. The mockups show **no hash** next to run titles, so **drop the hash element** and ship mono-400 only. (If any mono text ends up bolded, either add `jetbrains-mono-latin-500-normal.woff2` or accept faux-bold.)

### 1.4 Icons — **use v1 §1.4 verbatim** (every `d` path + the brand "o" mark confirmed exact). The source's `.track`/`.tnode` connector-stepper is **dead CSS** (never in markup) — skip it; port only `.stages.compact`.

### 1.5 Component-CSS corrections (apply on top of v1 §3.1)
1. **Stepper solid fill (A7) — REQUIRED.** Add state overrides (the `.n-*` utilities alone are pale tints):
   ```css
   .stage.s-done .num { background:var(--green); color:#fff; }
   .stage.s-now  .num { background:var(--peach); color:#fff; }
   .stage.s-stop .num { background:var(--red);  color:#fff; }
   /* .s-pause uses .n-amber, which is solid by itself — no override */
   ```
2. **Active nav-count (A, omitted in v1):** `.nav a.active .nav-count{ background:rgba(255,255,255,.18); color:#fff; }`.
3. **`.icon-btn`** is `width:48px;flex:0 0 48px` (width-only; height stretches to the row). Not a `48×48` square.
4. **`.pill-run`** source has only `.peach/.blue/.amber/.violet` — **no `.green`/`.red`**. Done runs leave Running, so a green running-pill is never shown; author `.green`/`.red` variants only if you render a terminal pill in-card.
5. **`.qcount`** is a child of `.qpanel-head` (`amber-bg/amber-ink`), **not** a `.chip` modifier.
6. **`.btn`/`.btn-primary` (A10):** restyle these to the black-pill `.btn-go` look (the question/gate JS emits `btn`/`btn btn-primary`, not `btn-go`).
7. **Reduced motion (A18) — REQUIRED:**
   ```css
   @media (prefers-reduced-motion: reduce){ .pdot,.cur{animation:none} *{transition:none!important} }
   ```
8. **Focus visibility (A18):** add `:focus-visible` rings to `.nav a`, `.seg button`, `.switch`, `.qopt`, `.hist-head`, `.btn-go`, inputs — the reset removes default outlines.

---

## 2. Information architecture & multi-run state model

### 2.1 Shell + three views (v1 §2.1, with one IA fix)
```
.app (flex) ├─ .sidebar (248px) [.brand · .nav(New|Running[amber]|History[grey]) · .side-foot(Install agents + .conn ws-dot)]
            └─ .main [.topbar(H1+sub, right status/refresh) · 3× .view(new|running|history)]
```
Exactly one `.view` visible (toggle `.hidden`). **Responsive fix (A18):** below `max-width:1080px` the sidebar hides — v1 leaves **no view switcher**, stranding the user. Provide a compact top nav (or a hamburger) that appears when the sidebar is hidden, wired to the same `showView`. Add a 1000px screenshot to the visual pass.

### 2.2 Multi-run state model (rewritten with B1–B4 corrections)

```js
const runs = new Map(); // runId -> RunModel
// RunModel { runId, title, projectDir, status,   // starting|running|done|error|stopped (NO 'waiting' from server)
//   startedAt,                                    // from hello (after A1 server change) or backfilled in onState
//   local,                                        // true iff this tab started the run (gates the model·effort sublabel — A12)
//   maxStepIdx, phaseKey, cycle, phaseStatus,     // stepper state; reconstructed by replaying events
//   pendingQuestion,                              // the full question event or null (seeded from hello — A2)
//   logLines: [],                                 // capped ring (4000); dropped when terminal+rendered (A16)
//   el: null }                                    // cached .run-card; null until built
```

**Routing rules (corrected):**
- **On `hello`** → for each `r0` in `msg.runs`: upsert `{runId, title, projectDir, status, pendingQuestion: r0.pendingQuestion, startedAt: r0.startedAt}` (A1/A2). **If `r0.status` is non-terminal, send one `subscribe`** to backfill; **if terminal, do NOT subscribe** — route to History (A15/A16). Then `updateNavCounts()` + re-render current view.
- **Do NOT re-subscribe in `onopen`** (A15) — a reconnect always yields a fresh `hello`. Delete that loop.
- **On any tagged event** (`phase|log|question|state|artifact|done|error`) → `const r = upsertRun({runId: msg.runId})` (create-if-missing with defaults; self-heals title/projectDir/startedAt from the next `state`, B4). Remove the **single-run drop filter at `app.js:160` AND the adopt line at `app.js:161`** (A9). Update the model, repaint only that run's card.
- **`onState`** (do not leave it a no-op): map `msg.status`→`r.status`, `msg.phase/msg.cycle`→stepper, and **`msg.startedAt`→`r.startedAt`** (the only post-hello source). Mirror current `app.js:453-460`.
- **Paused = `pendingQuestion != null`**, not a status string (A3). `liveRuns()` = `status ∈ {starting,running}` OR `pendingQuestion != null` (terminal statuses are never "live").
- **Idempotent terminal handlers (A15):** `onDone`/`onError` no-op if `r.status` already terminal; clear `r.pendingQuestion` + remove its qpanel before re-render. On error the server sends **both** `error` and `done` — converge them.
- **State reconstruction (B2):** stepper/cycle/log are rebuilt by feeding the **replayed** `phase`/`state`/`log` events through `onPhase/onState/onLog` — **not** from `hello`. `hello` seeds only identity + status + `pendingQuestion`. Accept lossy scrollback on runs longer than the 5000 buffer.
- **History feed (B4):** render History as `pipelines ∪ live` deduped by id (consume the `live[]` array v1 ignores) to close the persist-timing / persist-failure window. Refresh History on a `done`/stop transition (guarded to the run's `projectDir`).
- **Counts:** Running header = `${live} pipelines executing · ${needsInput} needs your input` where `needsInput` = count of `pendingQuestion != null`. Sidebar Running badge = live count; History badge = pipelines count.

### 2.3 Per-step config moves to the New form (corrected)
Relocate the four model/effort rows from inside `#steps` into a New-form `<div id="pipeline-config">` with four `.stage-cfg` rows (Plan/Refine/Implement/Review, each `data-role` + accent `.acc` + `.step-model` + `.step-effort` + `.step-current`).
- **Retarget scope (A8):** only the **one** delegated listener `el.steps.addEventListener('change', …)` at `app.js:387` repoints to `#pipeline-config`. `renderStepConfigs/saveStep/addModelFlow` use **document-scoped** `document.querySelector('.step-model[data-role=…]')` and are untouched. Do **not** touch `$$('.step', el.steps)` — that's the stepper, not config.
- **Drop the config lock (A14):** `renderStepConfigs`'s `locked` predicate reads the removed scalar `state.status`. New-form config always applies to the next run — delete the lock; ensure no dangling `state.status` read throws.
- **Sublabels (A12):** the Running/History stepper sublabel "Opus 4.8 · xhigh" is shown **only for `r.local === true`** runs (config known); **omit** for foreign/restored runs.

---

## 3. DOM contract & tests

### 3.1 Component → CSS map
Port v1 §3.1 as written, **plus the §1.5 corrections** (stepper overrides, `.btn`/`.btn-primary`, nav-count active, etc.). Keep the dual-class trick where JS sets `className` (e.g. `class="run-status badge"`).

### 3.2 JS DOM contract — corrections to v1 §3.2
All §3.2 ids/classes **exist today** (audited — every form/project/question/log/viewer/ws hook present). Corrections:
- **Remove BOTH `app.js:160` and `:161`** (the filter and the auto-adopt-first-runId line) (A9).
- **History is `<ul>`/`<li>` (A4):** the History task must rewrite `renderHistory`, `renderHistoryError`, **and** the project-delete reset (`app.js:920`) — all three inject `<li>` into `#history`. New markup = `.hist-card` / `.hist-empty` divs. Grep gate: `grep -n "el.history.innerHTML\|'<li" ui/public/app.js`.
- **Per-card control collisions (A13):** `#log`, `#autoscroll`, `#clear-log`, `#stop-btn`, `#run-status`, `#question-card`, `#steps` become **class-based per-card** hooks scoped via `closest('.run-card')`. Keep a single global `#autoscroll` in the Running header (don't clone the id). Remove their boot-time `el.*` global caches.
- **Question/gate buttons** are `btn`/`btn btn-primary` (A10) — restyle, don't rename.
- **`#projectDir` must NOT be reintroduced** and the literal string `$('#projectDir')` must not appear in `app.js` (the projects-ui test bans both).
- WS dot/label move from the old `topbar` (`index.html:15-24`) to `.side-foot .conn`.

### 3.3 Test contract
- **`test/ui-theme.test.mjs` WILL FAIL after the palette change.** Exact current assertions (so the rewrite is validated): requires `--accent:#4f9cf9`, `--accent-dim:#2b6fd1`, `--good:#3fb950`, `--warn:#d29922`, `--bad:#f85149`, `--critical:#f85149`, `--major:#db6d28`, `--minor:#d29922`, `--suggestion:#58a6ff`, `--bg-elev:#ffffff`; `--bg !== #0e1116` and matches `/^#(fff(fff)?|f[0-9a-f]{5})$/i`; `--bg-code !== #ffffff`; `.log{…background:var(--bg-code)}` and `.viewer{…background:var(--bg-code)}`; `.step.done .num{…color:X}` with `X !== #fff`; bans literals `#0a0d12`, `#232c38`. The OLD test **requires** `#4f9cf9` (it does **not** ban it — v1 §3.3 mis-stated this; the **new** test bans it). **Rewrite per Task §E (merged with the CSS task so the suite stays green).**
- **`test/projects-ui.test.mjs`** — keep `id="projectSelect"`, `id="add-project"`, `id="project-delete"`; in `app.js`: `fetch('/api/projects')`, `selectedProjectPath`, `loadProjects`. Bans `id="projectDir"` (html) and `$('#projectDir')` (js). **Preserve.**
- **`test/config-ui.test.mjs`** — keep `data-role="planner|refiner|implementer|reviewer"`, `step-model`, `step-effort` (html); `/api/config`, `renderStepConfigs`, `addModelFlow` (js). **Preserve.** *Strengthen:* also assert `app.js` contains `#pipeline-config` and **not** `el.steps.addEventListener` (proves the retarget; catches the boot null-deref).
- **`test/agent-log.test.mjs`** is a **core/orchestrator** test (not markup) — it pins the `{source,level,text}` event shape the orchestrator emits. Unaffected by the redesign; **no change**. It documents the shape `appendLog` consumes.
- **NEW `test/ui-shell.test.mjs`** (the de-risker v1 lacks; gate after the shell task): assert exactly 3 `data-view` occurrences; `data-nav="new|running|history"`; `id="run-card-tpl"`, `id="hist-card-tpl"`, `id="run-list"`, `id="nav-running-count"`, `id="nav-history-count"`, `id="ws-dot"`; the run-card template has 6 `data-step="preflight|plan|refine|implement|review|done"` + a `.qpanel` slot + `.btn-stop`; **negative guards** `!html.includes('class="layout"')` and `!html.includes('<ol id="steps"')` (proves the old shell is gone).
- **NEW minimal jsdom boot smoke** (~30 lines, the highest-value test): load `index.html`, stub `WebSocket`/`fetch`, import `app.js`, assert **(a) it imports without throwing** and **(b) `document.querySelectorAll('[data-view]').length === 3`**. This catches the Task-shell→state boot `TypeError` — the single most dangerous failure mode. Going beyond boot+structure (simulating clicks) is scope creep — stop here.

---

## 4. File structure

| File | Disposition | Notes |
|---|---|---|
| `ui/public/fonts/*.woff2` | Create (5) | Poppins 400/500/600/700 + JBMono 400 |
| `ui/public/style.css` | Rewrite | Design system + §1.5 corrections; keep `.hidden`, JS class names, restyle `.btn`/`.btn-primary` |
| `ui/public/index.html` | Rewrite structure | `.app` shell + 3 views + `#run-card-tpl`/`#hist-card-tpl`; preserve all §3.2 ids; config rows move to `#pipeline-config` |
| `ui/public/app.js` | Refactor (**keep monolith — committed decision**) | Router + `runs` Map + per-run WS routing + render fns. Do **not** split into modules (the projects-ui/config-ui tests assert identifiers in `app.js`; a half-split strands them). |
| `ui/server.mjs` | **One-field change (A1)** | Add `startedAt` to `entry` (`server.mjs:241`) + to `summarizeRuns()` (`server.mjs:115-121`). v1's "no server change" is retracted for this. Nothing else. |
| `test/ui-theme.test.mjs` | Rewrite | New palette (merged with CSS task) |
| `test/ui-shell.test.mjs`, `test/ui-boot.test.mjs` (jsdom) | Create | §3.3 |
| `package.json` | Modify | `@fontsource/poppins`, `@fontsource/jetbrains-mono` (+ `jsdom` dev dep for the boot smoke) |

---

## 5. Server change (the one deviation from "no server change")

```js
// server.mjs ~L241, when creating the run entry:
const entry = { id: runId, orch, projectDir, title, status:'starting',
                startedAt: new Date().toISOString(),   // ADD
                events: [], pendingQuestion: null };
// server.mjs ~L115, in summarizeRuns():
.map((r) => ({ runId:r.id, projectDir:r.projectDir, title:r.title,
               status:r.status, startedAt:r.startedAt,   // ADD
               pendingQuestion:r.pendingQuestion||null }))
```
Belt-and-braces: `onState` also sets `r.startedAt = msg.startedAt || r.startedAt` (recovers the real time from the replayed `state` if the first one is still in the buffer). Run the server tests after this change (none assert `summarizeRuns` shape, but confirm).

---

## E. Resequenced tasks (every commit boots + `npm test` green)

**Branch decision (A5):** Recommend a short-lived `ui-redesign` branch, per-task commits, fast-forward merge at the end — v1's "main, no-PR" leaves `main` non-bootable for several commits and red for ~6. **If the user keeps `main`, the merges/squashes below are mandatory** (not optional) so every commit boots and is green. The plan is structured to satisfy either choice.

> Verification-command fixes applied throughout: replace `sleep 1` with a readiness poll `for i in $(seq 1 20); do curl -sf http://localhost:4317/ >/dev/null && break; sleep 0.25; done` and reap with `kill $SRV 2>/dev/null; wait $SRV 2>/dev/null`; use `grep -o 'data-view' | wc -l` (not `grep -c`); server port is **4317**.

### Task 0 — Self-host fonts (independent, safe)
As v1 Task 0. Verify 5 woff2 files + that `/fonts/*.woff2` serves 200. Add a content assertion that `style.css` will reference all 5 `@font-face src:url('/fonts/…woff2')` (wire-check; rendering is checked in the visual pass). **Commit.** (Green.)

### Task 1 — CSS rewrite **+ theme-test rewrite** (MERGED — A5)
- Rewrite `style.css` to the design system (v1 Task 1 Steps 1-12) **+ §1.5 corrections** (stepper overrides, reduced-motion, focus-visible, `.btn`/`.btn-primary` black-pill, nav-count active).
- **In the same commit**, rewrite `test/ui-theme.test.mjs` to the new tokens (v1 Task 11A test body is a good base; confirm it bans `#4f9cf9` and asserts `--bg:#f1f1ef`, `--panel:#ffffff`, `--ink:#19191b`, the six family mids, `--r-card:24px`, `--r-ctrl:14px`, `@font-face` Poppins+JBMono, and a `.log{…background:` rule).
- Verify `node --test test/ui-theme.test.mjs` PASS and `style 200`. **Commit.** (`npm test` green — eliminates v1's 6-commit red window.)

### Task 2 — index.html shell + router + New-form wiring (MERGED — A5)
*(Merged because the new markup nulls module-top `el.steps`/`el.stopBtn`/`el.log` lookups → app.js throws at load until the JS is repointed. Splitting creates non-bootable commits.)*
- **Markup:** `.app` shell (sidebar/brand/nav/install/`.conn`), 3 `.view` sections, the New form (all §3.2 ids; config rows in `#pipeline-config`; **keep hidden `input[name="source"]` radios** and drive `.seg .on` from them — committed, no `el.sourceRadios` change), `#run-card-tpl` + `#hist-card-tpl` (both mandatory), a **viewer modal overlay** (`.hidden` toggle; Esc + backdrop close), per-card class-based log controls. a11y attrs: `.seg button[aria-pressed]`, `.switch[role=switch][aria-checked]`, `.hist-head[role=button][tabindex=0][aria-expanded]`, `.qopt[aria-pressed]`. Add the compact responsive nav (A18).
- **Router:** `showView` toggling **`.hidden` only** (drop v1's belt+braces `hidden` attribute to avoid specificity surprises); nav + hashchange; boot `showView(location.hash.slice(1)||'new')`. Stub `renderRunningView`/`runs` so this commit boots (real impl in Task 3).
- **Form wiring:** retarget the one `change` listener `app.js:387` → `#pipeline-config` (A8); drop the config lock (A14); wire `.seg`/`.switch`/file `.pick` to the existing hidden inputs.
- **Gate:** new `test/ui-shell.test.mjs` + jsdom boot smoke PASS; `node --test test/projects-ui.test.mjs test/config-ui.test.mjs` PASS; full `npm test` green. **Commit.**

### Task 3 — Multi-run state + run-card + Running view (MERGED — A5)
*(Router from Task 2 forward-references these; one functional unit.)*
- **Land the §5 server `startedAt` change first** (or wire the `onState` backfill).
- `runs` Map + `makeRun`/`upsertRun` (merge via `Object.assign`, never reset `logLines`/`el`); RunModel per §2.2.
- WS routing per §2.2: remove `app.js:160-161`; `hello` seeds identity+status+**pendingQuestion**+startedAt, subscribes **once** for **non-terminal** runs only; delete the `onopen` re-subscribe loop; idempotent `onDone/onError`; `onState` backfills startedAt/status/cycle.
- `renderRunningView` (diff `#run-list` by `data-run-id`), `buildRunCard` (clone tpl; **hydrate `.log` from `r.logLines`** for events replayed before the card existed), `paintStepper` (state matrix; **pause derived from `pendingQuestion`** inside paint, not a separate writer — A18), `paintRunCard`.
- **Status-pill copy map (committed — no `?`):** `starting→peach "Starting"`; `running`+`refine→peach "Refining"`; `+implement→blue "Implementing"`; `+plan→violet "Planning"`; `+review→peach "Reviewing"`; `pendingQuestion→amber "Paused · awaiting answers"`; `done→green "Done"`; `stopped→red "Stopped"`; `error→red "Error"`.
- Per-card Stop → `POST /api/stop {runId}`; re-enable that card's button + log to that card on failure. Sublabels only when `r.local` (A12). Client-evict terminal RunModels' `logLines`/`el` after rendering to History (A16). Empty Running state: "No pipelines running — start one from New."
- Verify with **two concurrent mock runs** (independent cards/logs/steppers). `npm test` green. **Commit.**

### Task 4 — Inline question panel per card
- `onQuestion(r,msg)` stores `pendingQuestion`, paints the card's `.qpanel` via retargeted `renderClarify/renderGate` (write into `r.el .qpanel`); add `.attention` ring.
- **Reload-restores-question (A2):** when `hello` seeded `pendingQuestion`, render the panel directly from it after backfill — do not rely solely on a replayed event (it may be evicted past the 5000 buffer).
- `sendAnswer` posts `{runId: btn.closest('.run-card').dataset.runId, id, payload}`; **no-op if `r.status` terminal**; do not treat HTTP 200 as proof (B3) — confirm resume via the next `phase`/`state`. Clear panel + `.attention` on resume.
- Verify a mock clarify pause renders inline, options/free-text work, submit resumes, **and a mid-pause reload re-renders the panel**. **Commit.**

### Task 5 — History as expandable cards
- **Step 0 (A11):** recon `src/core/artifacts.mjs` `listPipelines`/`readPipeline` to confirm whether cycle counts (Refine×/Review×) are persisted. If absent, omit those chips (don't guess) and note it.
- Rewrite **all** `#history` writers (A4): `renderHistory` → `.hist-card`s (badge DONE/STOPPED, title+timestamp, cycle chips, chevron; expand reveals a tinted `.stages.compact`); `renderHistoryError` and the delete-reset → `.hist-empty` div. Title-click → viewer; chevron-click → expand (distinct targets). History = `pipelines ∪ live` deduped (B4). Set `#nav-history-count`. Grep gate from §3.2.
- Verify rows render/expand/rotate; empty + error states are divs. **Commit.**

### Task 6 — Connection indicator + dead-hook audit
- `setWsStatus` targets the sidebar `.conn` dot/label.
- Audit removed globals — **extended grep** (adds the hooks v1's grep missed): `grep -n "run-status\|stop-btn\|question-card\|'#log'\|'#steps'\|autoscroll\|clear-log\|resetSteps\|beginRun\|state\.status\|state\.runId" ui/public/app.js`. Resolve each to per-card/class equivalents; zero console errors on boot across all three views. **Commit.**

### Task 7 — Offline smoke + full regression
- `npm run smoke` (CLI-only; guards shared `src/` modules — **not** the UI). Then **full `npm test`** (now green throughout; delete v1's hand-listed test subset). **Commit if fixes were needed.**

### Task 8 — Visual verification (Playwright MCP)
- Per v1 Task 11B, screenshot New/Running/History at 1440×900 vs the five mockups; drive 2-3 mock runs (incl. a paused one) for Running. **Add a 1000×900 screenshot** to verify the responsive view-switcher (A18) — confirm you can still change views with the sidebar hidden. Verify woff2 load 200 in Network (not system fallback). Fix CSS/markup to match; commit fixes as `fix(ui): match mockup — <detail>`.

---

## F. Coverage additions (folded into the tasks above)
- **Reduced motion / focus-visible** → Task 1 (§1.5).
- **a11y** (aria-pressed/role=switch/aria-expanded + keyboard Enter/Space for history expand & seg & options) → Tasks 2/3/4/5.
- **Empty states** — Running empty + History empty (`.hist-empty` div) → Tasks 3/5.
- **Error states** — `renderHistoryError` as a div; optional "reconnecting" affordance on live cards when WS drops → Tasks 5/6.
- **Responsive view-switcher** (no stranded nav below 1080px) → Tasks 2/8.
- **Viewer modal** — Esc + backdrop close + `.hidden` toggle → Task 2.
- **Loading flash** — Running header may flash "0 pipelines" before `hello`; accept or one-line skeleton → Task 3 (documented decision, not an omission).

---

## 7. Risks & notes (updated)
- **Biggest risk remains the `app.js` multi-run refactor (Task 3).** Mitigate exactly as v1: change *where* state lives (per-run model + per-card DOM), keep `STEP_ORDER`/`normalizePhase`/`maxStepIdx` semantics. v2 additionally pins the **protocol contracts (§B)** so the refactor codes against reality, not assumptions.
- **The one genuine `server.mjs` change** is the `startedAt` field (§5) — the rest of v1's "server already does it" is **verified true** (broadcast-all, `subscribe` replay, `/fonts/*` static, `/api/runs`).
- **Subscribe is not idempotent and runs are never evicted server-side** — the client must subscribe once per non-terminal run and tolerate an ever-growing `hello`.
- **Two data-availability unknowns (§B6)** — History cycle chips and per-run model/effort sublabels. Recon `artifacts.mjs`; gate sublabels on `local`.
- **Sequencing is the other big change** — merged units keep every commit bootable + green; prefer a branch.

## 8. Final self-review (run before declaring done)
- [ ] All §B contracts honored (no `startedAt`/`waiting`/sublabel assumptions that the server doesn't back).
- [ ] `app.js:160` **and** `:161` removed; subscribe fires once per non-terminal run; `onDone/onError` idempotent.
- [ ] `hello.pendingQuestion` seeds the panel (reload-during-pause works).
- [ ] Every `#history` writer emits divs (no stray `<li>`); per-card controls are class-based (no duplicate ids).
- [ ] `npm test` green at **every** commit (theme test merged with CSS); `ui-shell` + jsdom boot tests added and passing; `npm run smoke` passes.
- [ ] No `id="projectDir"` / `$('#projectDir')`; config hooks (`data-role`×4, `step-model`, `step-effort`, `renderStepConfigs`, `addModelFlow`, `/api/config`) intact in `app.js`.
- [ ] All five mockup screens reproduced (1440px) + responsive switcher verified (1000px).
- [ ] Reduced-motion + focus-visible + viewer-modal-close present.
- [ ] No placeholders / forks — every "decide per…" resolved (radios kept; monolith kept; viewer = modal; single global autoscroll; status-pill map committed).
