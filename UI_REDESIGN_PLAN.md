# Maestro UI Redesign — "Refined" Visual + IA Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the Maestro web UI from its current single-page, two-column, cool-grey/blue theme to the "Refined" mockup: a warm off-white design with a left sidebar, three routed views (New pipeline / Running / History), a concurrent multi-pipeline Running view, Poppins + JetBrains Mono typography, large rounded white cards, black pill buttons, pastel status families, and iOS-style toggles.

**Architecture:** No build step, no framework. Vanilla ESM in `ui/public/` (`index.html`, `style.css`, `app.js`) served statically by `ui/server.mjs`. The migration is (1) a full `style.css` rewrite to the new design system, (2) an `index.html` restructure into a sidebar shell + three `.view` sections, (3) an `app.js` refactor introducing client-side view routing and a **multi-run state model** (the server already broadcasts every run's events and exposes `hello.runs` + `/api/runs.live[]` — the current client just ignores them), and (4) self-hosted webfonts. All JS DOM hooks and test-asserted markup substrings are preserved; the one palette test is rewritten for the new tokens.

**Tech Stack:** HTML5, CSS custom properties, vanilla ES modules, WebSocket, Express static server (`ui/server.mjs`), Node test runner (`node --test`), self-hosted woff2 (Poppins + JetBrains Mono), Playwright MCP for visual verification.

---

## 0. Source-of-truth & reference material

These files are the canonical inputs. **Attach them to the implementation session.**

| Reference | Path | Use |
|---|---|---|
| Mockup — New pipeline (top) | `./ui-redesign-mockups/01-new-pipeline-top.png` | Sidebar, project select + ✕, title, Prompt/Markdown segmented toggle, prompt textarea, centered card, breadcrumb subtitle |
| Mockup — New pipeline (config) | `./ui-redesign-mockups/02-new-pipeline-config.png` | File input, refine/review cycles, **Pipeline configuration** rows (Plan/Refine/Implement/Review w/ colored accent bars + model + effort selects), Mock-mode iOS toggle, black ▶ Start run, Install agents pill |
| Mockup — Running (needs input) | `./ui-redesign-mockups/03-running-needs-input.png` | Running header w/ live counts + "1 needs input" pill, a run card with **amber attention ring**, status pill, stepper, "Plan paused · 3 questions" chip, red Stop, live log, inline question panel |
| Mockup — Running (list) | `./ui-redesign-mockups/04-running-list.png` | Two more run cards (Refining / Implementing), stepper color states, cycle chips |
| Mockup — History | `./ui-redesign-mockups/05-history.png` | History header + Refresh, expandable rows w/ DONE/STOPPED badge + title + timestamp + Refine×N/Review×N chips + chevron + expanded stepper |
| **Authoritative HTML/CSS** | `/Users/denislavprinov/Downloads/Maestro Refined (standalone) (1).html` | The exact CSS + markup. **This is the source of truth for every pixel value.** |

### How to extract the authoritative CSS from the mockup HTML

The mockup file is 431 KB across 184 lines because **line 182 is a JSON-escaped inner HTML document** (the real app) and line 174 is a base64 font blob. Do **not** `Read` the whole file. Extract the readable inner document like Agent B did:

```bash
FILE="/Users/denislavprinov/Downloads/Maestro Refined (standalone) (1).html"
# Pull CSS custom properties:
grep -o -- '--[a-zA-Z-]*:[^;]*;' "$FILE" | sort -u
# Pull the font-family declarations:
grep -o "font-family:[^;}]*" "$FILE" | sort -u
# Pull every class used in the markup:
grep -o 'class=\\\\"[^"]*\\\\"' "$FILE" | sort -u   # (escaping varies; also try class=\" )
```

To read the inner CSS/markup in chunks, the inner doc is JSON-escaped on line 182. Decode it to a temp file first (Node one-liner), then read it normally:

```bash
node -e 'const fs=require("fs");const s=fs.readFileSync(process.argv[1],"utf8");const m=s.match(/"(<!DOCTYPE[\s\S]*?)"\s*[,)\]]/);if(!m){console.error("inner doc not found");process.exit(1)}let inner;try{inner=JSON.parse(`"${m[1]}"`)}catch(e){inner=m[1].replace(/\\n/g,"\n").replace(/\\"/g,"\"").replace(/\\\\/g,"\\")}fs.writeFileSync("/tmp/maestro_inner.html",inner);console.log("wrote /tmp/maestro_inner.html",inner.length)' "/Users/denislavprinov/Downloads/Maestro Refined (standalone) (1).html"
# Then: the <style> block and <body> markup are now readable in /tmp/maestro_inner.html
grep -n '<style' /tmp/maestro_inner.html
grep -n ':root\|@font-face\|\.stage\|\.qpanel\|\.run-card\|\.nav ' /tmp/maestro_inner.html
```

**Rule of thumb:** when a concrete value below conflicts with the source HTML, the source HTML wins — re-extract and use that value. The values in §1–§3 were extracted from this file and cross-checked against the screenshots, but the impl agent should verify against the source while porting.

---

## 1. Design system (the new visual language)

### 1.1 Color tokens (`:root`) — use verbatim

```css
:root {
  /* surfaces */
  --bg:        #F1F1EF;   /* app canvas (warm off-white) */
  --panel:     #FFFFFF;   /* cards, sidebar, status pills */
  --ink:       #19191B;   /* primary text; black fills (active nav, primary btn, selected option/chip, q-bullets) */
  --ink-2:     #5C5C63;   /* secondary text (nav default, subtitle, body, log default, ghost-btn + pill text) */
  --ink-3:     #9A9AA1;   /* tertiary/dim text (hints, captions, placeholders, sublabels, timestamps, pending stepper) */
  --line:      #ECECEA;   /* hairline borders (sidebar divider, card border, separators) */
  --line-2:    #E3E3E0;   /* stronger border (ghost btn, file dash, icon-btn, qopt, config selects, pending stepper dot) */
  --field:     #F6F6F4;   /* input/select/textarea fill; segmented track; chips; file bg; history-row bg; grey stepper number */

  /* status families — each: -bg (tint), mid (dot/number/accent), -ink (readable text on tint) */
  --green-bg:  #E2F3DF;  --green:  #5BAE5B;  --green-ink:  #2F7A38;  /* done / success / connected */
  --peach-bg:  #FCEEDA;  --peach:  #EFA63C;  --peach-ink:  #B5751A;  /* active / in-progress (Refining) */
  --red-bg:    #FBE3E0;  --red:    #E76A5A;  --red-ink:    #C5483A;  /* stop / error / stopped */
  --blue-bg:   #DEEFF7;  --blue:   #5BA6CC;  --blue-ink:   #3782A8;  /* implement / info */
  --violet-bg: #EAE6F8;  --violet: #8C7FD6;  --violet-ink: #6353B8;  /* plan */
  --amber-bg:  #FCE8C8;  --amber:  #E6962A;  --amber-ink:  #A66510;  /* needs-input / paused / attention */

  /* shape + elevation */
  --r-card:    24px;   /* card corner radius */
  --r-ctrl:    14px;   /* control radius (inputs, textarea, select, icon-btn, file) */
  --shadow:      0 6px 28px rgba(25,25,27,.05), 0 1px 2px rgba(25,25,27,.04);
  --shadow-soft: 0 2px 12px rgba(25,25,27,.04);

  /* type */
  --sans: 'Poppins', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
}
```

**Status semantics:** green=done/success/connected · peach=running (active step `s-now`, "Refining") · amber=needs-input/paused/attention (focus ring, "Paused", paused step `s-pause`, Running nav badge) · blue=Implement + info logs · violet=Plan · red=stop/error/stopped.

### 1.2 Typography

- Body + headings: **Poppins** (400/500/600/700). Base `font-size:14px`, `-webkit-font-smoothing:antialiased`.
- Monospace (live log, timestamps, hashes): **JetBrains Mono** (400).

**Type scale (px / weight / color):** sidebar wordmark 19/700/ink (`-.02em`); nav item 14/500/ink-2 (active #fff); nav count 11.5/700; sidebar section label 11/600/ink-3 (`.08em` UPPERCASE); page H1 26/700/ink (`-.025em`); page subtitle 13.5/400/ink-2; card title 17/700/ink (`-.015em`); field label 13/600/ink; hint 12/400/ink-3 (`lh 1.45`); body/inputs 14/400/ink; segmented btn 13/600; status pill 12.5/600/family-ink; run-card title 16/700/ink; run-card meta 12.5/400/ink-3; stepper label `b` 13/600 (compact), sublabel `small` 10.5/500/ink-3; chip 12/600/ink-2; history badge 10.5/700 (`.06em`); history title 14.5/600/ink; history timestamp 12/400/ink-3; log 12.5/400/ink-2 (`lh 1.85`, mono); "Live log" label 13/700/ink; question head 15/700/ink; question text 14/600/ink; q-number bullet 11.5/700/#fff on ink; option row 13/600; free-answer input 13.5/400.

### 1.3 Self-hosted fonts (decision: self-host woff2)

Fonts live in `ui/public/fonts/` and are loaded via `@font-face` in `style.css` so the UI matches the mockup **fully offline** (important: `npm run smoke` is an offline dry run).

Acquire the woff2 files deterministically via `@fontsource` (ships pre-subset woff2), then copy them in — no CDN dependency at runtime:

```bash
cd /Users/denislavprinov/Develop/orchestrator
npm install --save-dev @fontsource/poppins @fontsource/jetbrains-mono
mkdir -p ui/public/fonts
cp node_modules/@fontsource/poppins/files/poppins-latin-400-normal.woff2 ui/public/fonts/
cp node_modules/@fontsource/poppins/files/poppins-latin-500-normal.woff2 ui/public/fonts/
cp node_modules/@fontsource/poppins/files/poppins-latin-600-normal.woff2 ui/public/fonts/
cp node_modules/@fontsource/poppins/files/poppins-latin-700-normal.woff2 ui/public/fonts/
cp node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2 ui/public/fonts/
ls -1 ui/public/fonts/   # expect 5 woff2 files
```

> If `@fontsource` file names differ in the installed version, list `node_modules/@fontsource/poppins/files/ | grep latin.*normal.woff2` and copy the 400/500/600/700 `latin-*-normal.woff2` (avoid `-italic`). The `.woff2` binaries are committed into `ui/public/fonts/`; the `@fontsource` packages are dev-only acquisition tooling.

`@font-face` block to place at the **top of `style.css`** (before `:root`):

```css
@font-face { font-family:'Poppins'; font-style:normal; font-weight:400; font-display:swap; src:url('/fonts/poppins-latin-400-normal.woff2') format('woff2'); }
@font-face { font-family:'Poppins'; font-style:normal; font-weight:500; font-display:swap; src:url('/fonts/poppins-latin-500-normal.woff2') format('woff2'); }
@font-face { font-family:'Poppins'; font-style:normal; font-weight:600; font-display:swap; src:url('/fonts/poppins-latin-600-normal.woff2') format('woff2'); }
@font-face { font-family:'Poppins'; font-style:normal; font-weight:700; font-display:swap; src:url('/fonts/poppins-latin-700-normal.woff2') format('woff2'); }
@font-face { font-family:'JetBrains Mono'; font-style:normal; font-weight:400; font-display:swap; src:url('/fonts/jetbrains-mono-latin-400-normal.woff2') format('woff2'); }
```

`ui/server.mjs` serves `ui/public/` statically (`express.static`), so `/fonts/*.woff2` resolves with no server change.

### 1.4 Icons (inline SVG, thin-line, `fill:none;stroke:currentColor`, `viewBox="0 0 24 24"`, round caps)

| Icon | Where | Path `d` (stroke unless noted) | sw |
|---|---|---|---|
| Plus | nav New | `M12 5v14M5 12h14` | 1.9 |
| Clock | nav Running | `<circle cx=12 cy=12 r=8/>` + `M12 8v4l3 2` | 1.9 |
| History arrow | nav History | `M3 12a9 9 0 1 0 3-6.7` + `M3 4v4h4` | 1.9 |
| Download | Install agents | `M12 3v12M8 11l4 4 4-4` + `M5 21h14` | 1.9 |
| Play ▶ | Start / Submit / log markers | `M6 4l14 8-14 8V4Z` **fill:currentColor** | — |
| Stop ■ | Stop button | `<rect x=6 y=6 width=12 height=12 rx=2/>` **fill:currentColor** | — |
| Question ? | q-panel head | `M9.1 9a3 3 0 1 1 4.6 2.5c-.9.6-1.7 1.2-1.7 2.3` + `<circle cx=12 cy=17.5 r=.5/>` | 2 |
| Chevron | history expand | `M6 9l6 6 6-6` (rotates 180° when expanded) | 2.4 |

Brand "o" mark is **not** SVG: a 38×38 `--ink` rounded square (`border-radius:12px`) centering a 13×13 circle with `border:3px solid #fff;border-radius:50%`.

---

## 2. Information architecture & client state model

### 2.1 The shell + three views

```
.app (flex, min-height:100vh)
├── .sidebar (248px, white, border-right --line)
│     .brand (mark + "maestro")
│     .nav  → New pipeline | Running [count amber] | History [count grey]   (active = solid black pill)
│     .side-foot (margin-top:auto) → Install agents (ghost pill, download icon)
└── .main (flex:1; padding:26px 32px 40px)
      .topbar (page H1 + subtitle; right-aligned status/refresh)  [New view: centered]
      .view[data-view="new"]      → single centered ≤720px card (the form)
      .view[data-view="running"]  → .run-list of N .run-card
      .view[data-view="history"]  → .run-list of .hist-card
```

Exactly one `.view` is visible at a time (toggle a class, e.g. `.view.active` / `hidden`). Nav clicks switch views and set the active nav item. Below `max-width:1080px` hide the sidebar and let views stack (port the mockup's responsive rule).

### 2.2 Multi-run state model (the core functional change)

**Current client:** single scalar `state.runId`; the WS router drops events whose `runId` ≠ the tracked one; `beginRun` resets one shared canvas. **Server already supports concurrency:** it broadcasts *every* run's events to *every* socket (`server.mjs:101-112`), greets with `{type:'hello', runs:[…]}` (`server.mjs:66`), and `/api/runs` returns `{pipelines, live}` (`server.mjs:308-322`). The client currently ignores `hello.runs` and `data.live`.

**New client model:**

```js
// Replaces the scalar state.runId.
const runs = new Map(); // runId -> RunModel
// RunModel:
// {
//   runId, title, projectDir, status,        // status: starting|running|waiting|done|error|stopped
//   startedAt,                                // ISO/HH:MM:SS for "started 19:21:08"
//   maxStepIdx, phaseKey, cycle, phaseStatus, // stepper state (same semantics as today)
//   pendingQuestion,                          // {kind:'clarify'|'gate', ...} or null
//   logLines: [],                             // capped ring (e.g. 4000) of {ts, source, level, text}
//   el: null                                  // cached .run-card DOM node (built lazily)
// }
```

Routing rules:
- On `hello` → for each `msg.runs[i]`, upsert a RunModel and send `{type:'subscribe', runId}` to backfill its buffered events.
- On any tagged event (`phase|log|question|artifact|state|done|error`) → `const r = runs.get(msg.runId)` (create if missing), update the model, then update **only that run's card** (find by `data-run-id`). **Remove** the single-run drop filter (`app.js:160`).
- Starting a run from the New view: `POST /api/run` → `{runId}`; create RunModel(status:'starting'); switch to Running view; the card appears and live events flow.
- "Live" runs (status ∈ starting|running|waiting) render in the Running view; terminal runs (done|error|stopped) drop out of Running and appear in History (already disk-backed via `/api/runs.pipelines`).
- Running-view header counts: `N pipelines executing · M needs your input` where M = count of runs with `pendingQuestion`. Sidebar Running badge = count of live runs; History badge = count of saved pipelines.

### 2.3 Per-step model/effort config MOVES from the tracker to the New form

In today's UI the model/effort `<select>`s live **inside** the steps tracker (`.step .step-config[data-role]`). In the mockup they live in the New-pipeline **"Pipeline configuration"** section as four `.stage-cfg` rows (Plan/Refine/Implement/Review, each with a colored accent bar + model select + effort select). The Running/History steppers show the chosen config as a **static sublabel** ("Opus 4.8 · xhigh").

→ Relocate the config selects into the New form's `.stage-cfg` rows but **keep the test/JS hooks**: each row carries `data-role="planner|refiner|implementer|reviewer"` and contains `<select class="step-model" data-role=…>` + `<select class="step-effort" data-role=…>` + a `.step-current` caption. `renderStepConfigs()`, `addModelFlow()`, `saveStep()`, `loadConfig()` and the delegated change handler are retargeted from `#steps` to the new config container but otherwise unchanged in behavior. Stepper sublabels are derived from each RunModel's config at card-build time.

---

## 3. Class/selector mapping (mockup → our markup) and what MUST be preserved

Port the mockup's CSS, but our markup keeps the IDs/classes that JS and tests depend on. Where the mockup class and our hook differ, **apply both** (e.g. `class="run-status badge"` so JS that sets `className='badge …'` still works — see notes).

### 3.1 Mockup component → CSS values (port these classes into `style.css`)

| Mockup class | Spec (port verbatim from source HTML; key values) |
|---|---|
| `.sidebar` | 248px; `flex:0 0 248px`; bg `--panel`; `border-right:1px solid --line`; padding `26px 18px 22px`; flex column |
| `.brand .mark` | 38×38; `border-radius:12px`; bg `--ink`; centers 13×13 white-ringed circle |
| `.nav a` | flex; gap 13px; padding `11px 13px`; `border-radius:13px`; 14/500; color `--ink-2`. hover: bg `--field`, color `--ink`. **active**: bg `--ink`, color `#fff`, icon stroke `#fff` |
| `.nav-count` | min-w 22 / h 22; `border-radius:999px`; 11.5/700. `.n-amber`→bg `--amber`/#fff; `.n-grey`→bg `--field`/`--ink-3` |
| `.btn-ghost` | bg #fff; `border:1.5px solid --line-2`; color `--ink`; 13.5/600; padding `13px 20px`; `border-radius:999px`. hover bg `--field` |
| `.card` | bg `--panel`; `border:1px solid --line`; `border-radius:24px`; `box-shadow:--shadow`; padding 24px |
| `.run-card` | `.card` w/ padding `22px 24px`. `.run-card.attention`: `border:1.5px solid --amber` + `box-shadow:0 0 0 4px --amber-bg, var(--shadow)` |
| `.hist-card` | `.card` w/ padding `18px 22px` |
| `.btn-go` (primary) | bg `--ink`; color #fff; no border; 14/600; padding `14px 28px`; `border-radius:999px`. hover `translateY(-1px) brightness(1.08)` |
| `.btn-stop` | bg `--red-bg`; color `--red-ink`; padding `11px 19px`; `border-radius:999px`; 13/600. `.sm`: `margin-left:auto;padding:8px 15px;font-size:12px` |
| `.btn-clear` / `.btn-expand` | bg `--field`; 12.5/600; `--ink-2`; clear `border-radius:10px`, expand `border-radius:999px` + chevron rotate |
| `.seg` | inline-flex; bg `--field`; `border-radius:12px`; padding 4px; gap 4px. `button` 13/600 `--ink-2` padding `8px 20px` radius 9px. `.on`: bg #fff, color `--ink`, `box-shadow:--shadow-soft` |
| `.input/.select/.textarea` | width 100%; 14px; color `--ink`; bg `--field`; `border:1.5px solid transparent`; `border-radius:14px`; padding `13px 15px`. placeholder `--ink-3`. **focus**: bg #fff, `border-color:--ink`. textarea `min-height:120px;resize:vertical;lh:1.5` |
| `.select-wrap::after` | CSS caret: 9×9; `border-right/bottom:2px solid --ink-2`; rotate 45°; right 15px |
| `.icon-btn` (project ✕) | 48×48; `border-radius:14px`; `border:1.5px solid --line-2`; bg `--field`; 18px. hover bg #fff |
| `.switch` (iOS toggle) | 44×26; `border-radius:999px`; bg `--line-2`. knob `::after` 20×20 #fff `box-shadow`. `.on`: bg `--green`, knob `left:21px` |
| `.file` | flex; bg `--field`; `border:1.5px dashed --line-2`; `border-radius:14px`; padding `13px 15px`. `.pick` button bg #fff border `--line-2` radius 9px |
| `.stages.compact .stage` | flex:1; min-w 118; gap 12px; bg `--panel`; `border:1px solid --line`; padding `11px 13px`; `border-radius:15px`; `box-shadow:--shadow-soft`. `.num` 26×26 circle 13/700. label `b` 13/600 + `small` 10.5/`--ink-3` |
| stepper states | `.s-done`→bg `--green-bg`, num `.n-green` solid; `.s-now`→`--peach-bg`, `.n-peach`; `.s-pause`→`--amber-bg`, `.n-amber`; `.s-stop`→`--red-bg`, `.n-red`; pending→white + `.n-grey` (`--field`/`--ink-3`). **No checkmark glyph** — green fill = done |
| `.stage-cfg .acc` | 10×38 bar `border-radius:6px`: `.violet`=Plan, `.green`=Refine, `.peach`=Implement, `.blue`=Review |
| `.pill-run` (status) | inline-flex; gap 8px; padding `8px 14px`; `border-radius:999px`; 12.5/600; leading `.pdot` 7×7 pulsing. variants `.peach/.blue/.amber/.violet/.green` set bg family-bg, color family-ink, dot family-mid |
| `.pill-status` | idle: white bg, `border:1px solid --line-2`, `--ink-2`, grey dot |
| `.badge` (history) | 10.5/700 `.06em`; padding `5px 10px`; `border-radius:8px`. `.green`=DONE, `.red`=STOPPED |
| `.chip` | bg `--field`; `--ink-2`; 12/600; padding `7px 13px`; `border-radius:999px`. `.qcount` amber variant |
| `.log` | bg `#FBFBF9`; `border:1px solid --line`; `border-radius:16px`; min-h 260 (in card 210, max 320 scroll); mono 12.5; `lh 1.85`; color `--ink-2`. tokens: `.ok`→`--green-ink`, `.run`→`--peach-ink`, `.info`→`--blue-ink`, `.t`(timestamp)→`--ink-3` |
| `.qpanel` | `margin-top:18px`; `border:1.5px solid --amber-bg`; bg `#FFFDF8`; `border-radius:18px`; padding `20px 22px`. head: ? icon + 15/700 title + amber `.qcount` |
| `.qblock`/`.qtext`/`.qn` | block `padding:18px 0;border-top:1px solid --line` (first none). `.qn` 22×22 black circle, white 11.5/700. `.qtext` 14/600 |
| `.qopt` | bg #fff; `border:1.5px solid --line-2`; `border-radius:11px`; padding `12px 16px`; 13/600. hover `border-color:--ink-3`. **`.sel`**: bg `--ink`, color #fff |
| `.qfree` | bg `--field`; `border:1.5px solid transparent`; `border-radius:11px`; padding `11px 14px`. focus bg #fff border `--ink` |
| `.hist-head` / `.hist-detail` | head: flex gap 13; cursor pointer. detail: `margin-top:16px;padding-top:16px;border-top:1px solid --line` → reveals `.stages.compact` |

### 3.2 JS DOM contract — preserve these IDs/classes (or update `app.js` in lockstep)

These are read/mutated by `app.js`. Keep them on the redesigned elements. (Full inventory: New-form fields, project selector, per-step config, status badge, stop, question panel, live log, history, viewer, ws indicator.)

- **Form:** `#run-form`, `#title`, `input[name="source"]`, `#prompt-pane`, `#markdown-pane` (both also `.source-pane`), `#prompt`, `#promptMarkdown`, `#mdFile`, `#mdFileName`, `#extras`, `#extrasNote`, `#maxRefine`, `#maxReview`, `#mock`, `#install-btn`, `#start-btn`, `#form-msg`. The global **`.hidden`** utility (`display:none !important`) must remain — it toggles `#prompt-pane`/`#markdown-pane`/`#add-project`/views.
- **Project selector:** `#projectSelect` (rebuilt via `renderProjectOptions`; option `value=path`, `dataset.name`), `#project-delete`, `#projectHint`, `#add-project`, `#newProjectName`, `#newProjectPath`, `#addProjectSave`, `#addProjectCancel`, `#addProjectMsg`. **Must NOT reintroduce `id="projectDir"`** (test guards against it).
- **Per-step config (relocated to New form `.stage-cfg` rows):** each row `data-role` ∈ {planner,refiner,implementer,reviewer}; `<select class="step-model" data-role>`, `<select class="step-effort" data-role>`, `.step-current[data-role]`. The change handler currently delegates on `#steps`; **retarget it to the new config container id** (e.g. `#pipeline-config`).
- **Status / stop:** `#run-status` — JS sets `className='badge '+statusClass`. In multi-run, status lives per-card; expose a per-card status element. Keep the `badge` class on whatever element JS writes (or refactor `setRunStatus` to take a runId + element). `#stop-btn` becomes per-card (`.btn-stop`); `stop` handler must target the card's runId.
- **Question panel:** `#question-card`, `#question-title`, `#question-kind` (`badge`), `#question-body`; rebuilt classes `.q-block/.q-question/.q-options/.q-option(.selected)/.q-free/.q-free-label/.q-submit-row`; gate `.gate-intro/.issues/.issue.sev-*/.issue-head/.issue-sev/.issue-title/.issue-detail/.issue-loc/.gate-actions`. (These move **inline into each run card** in the new design — see Task 7; the rebuilt class names can stay and be restyled, or be renamed to the mockup's `.qpanel/.qblock/.qopt` set **if** `app.js` render fns are updated together. Recommended: keep `app.js`'s class names and add the mockup styling to them, to minimize churn.)
- **Live log:** `#log` (per-card in multi-run), `#autoscroll`, `#clear-log`; line classes `.log-line.lvl-{info,error,warn,phase,system,artifact}` with children `.log-ts/.log-src/.log-msg`. Restyle these to the new tokens (map `lvl-phase`→green, `lvl-artifact`→blue, default→ink-2, `lvl-error`→red, `lvl-warn`→amber).
- **History:** `#history`, `#refresh-history`; item classes `.history-item/.h-title/.h-meta/.h-status(.done/.error/.stopped/.running)/.empty`. May be re-rendered as `.hist-card` — update `renderHistory` markup + CSS together.
- **Viewer:** `#viewer-card`, `#viewer-title`, `#viewer`, `#viewer-close`.
- **WS indicator:** `#ws-dot` (`className='dot dot-on|dot-off'`), `#ws-label`.

### 3.3 Test contract (in `test/`) — keep green

- **`test/ui-theme.test.mjs`** — **WILL FAIL** after the palette change (it asserts `--accent:#4f9cf9`, `--good:#3fb950`, `--bad:#f85149`, `--bg-elev:#ffffff`, `.log`/`.viewer` `background:var(--bg-code)`, `.step.done .num` non-white color, bans `#0e1116/#0a0d12/#232c38`). **Rewrite it** for the new tokens (Task 11A).
- **`test/projects-ui.test.mjs`** — requires `index.html` to contain `id="projectSelect"`, `id="add-project"`, `id="project-delete"`, and NOT `id="projectDir"`; `app.js` to contain `fetch('/api/projects')`, `selectedProjectPath`, `loadProjects`. **Preserve.**
- **`test/config-ui.test.mjs`** — requires `index.html` to contain `data-role="planner|refiner|implementer|reviewer"`, `step-model`, `step-effort`; `app.js` to contain `/api/config`, `renderStepConfigs`, `addModelFlow`. **Preserve** (these hooks move to the New-form config rows; substrings remain present).
- **`test/agent-log.test.mjs`** — pins the `{source, level, text}` log-event shape that `appendLog` consumes. Not markup. **Keep `appendLog` consuming `{source, level, text, ts}`.**
- Other tests (`config*.test.mjs`, `projects*.test.mjs`, `runner-args`, `clarify`) are server/core — unaffected, but run the full suite to confirm.

---

## 4. File structure

| File | Disposition | Responsibility after migration |
|---|---|---|
| `ui/public/fonts/*.woff2` | **Create** (5 files) | Self-hosted Poppins 400/500/600/700 + JetBrains Mono 400 |
| `ui/public/style.css` | **Rewrite** | New design system: `@font-face`, tokens, base, sidebar/shell, views, all components per §3.1. Keep `.hidden`, the JS-referenced class names (`.badge`, `.log-line/.log-ts/.log-src/.log-msg + lvl-*`, `.dot/.dot-on/.dot-off`, `.q-*`, `.gate*/.issue*`, `.history-item/.h-*` or their replacements), and the `.log`/`.viewer` `background:var(--bg-code)` rule **only if** the rewritten theme test still asserts it (we change that test — see Task 11A) |
| `ui/public/index.html` | **Rewrite structure** | `.app` shell: sidebar (brand, nav, install) + `.main` (topbar + 3 `.view` sections). New form lives in `.view[data-view="new"]`; Running/History views hold list containers populated by JS. Preserve all form IDs + config hooks + `#question-card`/`#viewer-card` templates (or per-card templates) |
| `ui/public/app.js` | **Refactor** | Add: view router; `runs` Map + RunModel; per-run WS routing (consume `hello.runs`, subscribe-all, drop the single-run filter); `renderRunningView()` + `renderRunCard(run)`; retarget per-step config to `#pipeline-config`; per-card status/stop/log/question. Keep: project registry, config load/save, history load/view, form submit, install, file handling, `appendLog` event shape |
| `ui/server.mjs` | **No change required** | Already multi-run, broadcasts all, serves `/fonts/*` statically. (Optional later: nothing needed for this plan.) |
| `test/ui-theme.test.mjs` | **Rewrite** | Assert the new tokens/rules (Task 11A) |
| `package.json` | **Modify** | Add `@fontsource/poppins`, `@fontsource/jetbrains-mono` to `devDependencies` |

> **Sizing note:** `app.js` is already 1209 lines and this adds multi-run + routing. Consider splitting into ES modules imported by `app.js` (e.g. `ws.js`, `runs.js`, `views.js`, `newForm.js`, `history.js`) since the server serves the whole `ui/public/` dir and the entry is `<script type="module">`. This is optional but recommended to keep files focused; if splitting, update `config-ui`/`projects-ui` test substring expectations only if the asserted identifiers move out of `app.js` (they assert against `app.js` specifically — **keep `renderStepConfigs`, `addModelFlow`, `loadProjects`, `selectedProjectPath`, and the `fetch('/api/projects')`/`/api/config` strings in `app.js`**, or re-point the tests). Simplest: keep everything in `app.js`.

---

## 5. Tasks

> **Testing reality:** this repo has **no DOM/browser test harness** — UI tests are string/CSS assertions over file contents (`test/*-ui.test.mjs`, `ui-theme.test.mjs`) plus orchestrator behavior tests. So: (a) where a test exists or can be written as a content assertion, do it test-first; (b) **visual** correctness is verified by running the server and screenshotting each view with Playwright MCP, comparing to the mockups. Both are required. Commit after each task (work on `main`, no PR).

---

### Task 0: Self-host the fonts

**Files:**
- Create: `ui/public/fonts/poppins-latin-{400,500,600,700}-normal.woff2`, `ui/public/fonts/jetbrains-mono-latin-400-normal.woff2`
- Modify: `package.json` (devDependencies)

- [ ] **Step 1:** Install acquisition packages and copy woff2:

```bash
cd /Users/denislavprinov/Develop/orchestrator
npm install --save-dev @fontsource/poppins @fontsource/jetbrains-mono
mkdir -p ui/public/fonts
cp node_modules/@fontsource/poppins/files/poppins-latin-400-normal.woff2 ui/public/fonts/
cp node_modules/@fontsource/poppins/files/poppins-latin-500-normal.woff2 ui/public/fonts/
cp node_modules/@fontsource/poppins/files/poppins-latin-600-normal.woff2 ui/public/fonts/
cp node_modules/@fontsource/poppins/files/poppins-latin-700-normal.woff2 ui/public/fonts/
cp node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2 ui/public/fonts/
```

- [ ] **Step 2:** Verify 5 files exist:

```bash
ls -1 ui/public/fonts/*.woff2 | wc -l   # expect 5
```
Expected: `5`. If a filename differs, `ls node_modules/@fontsource/poppins/files/ | grep 'latin-[0-9]*-normal.woff2'` and copy the right ones.

- [ ] **Step 3:** Confirm the static server will serve them — start server, curl one font:

```bash
node ui/server.mjs & SRV=$!; sleep 1
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://localhost:4317/fonts/poppins-latin-400-normal.woff2
kill $SRV
```
Expected: `200 font/woff2` (or `200 application/octet-stream`).

- [ ] **Step 4: Commit**
```bash
git add ui/public/fonts package.json package-lock.json
git commit -m "feat(ui): self-host Poppins + JetBrains Mono woff2"
```

---

### Task 1: Rewrite `style.css` to the new design system

This is the largest single task. Port the authoritative CSS from the mockup (see §0 extraction) and adapt selectors to our markup using §3.1 and §3.2. Build it incrementally and verify the page renders without console errors.

**Files:**
- Rewrite: `ui/public/style.css`

- [ ] **Step 1:** At the very top, add the `@font-face` block from §1.3, then the `:root` token block from §1.1 verbatim. Add base reset:

```css
*{box-sizing:border-box}
html,body{margin:0;padding:0;min-height:100%}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
.hidden{display:none !important}   /* preserve the universal show/hide utility */
```

- [ ] **Step 2:** Author the **shell**: `.app`, `.sidebar` (+ `.brand`, `.brand .mark`, `.name`), `.nav` + `.nav a` (default/hover/`.active`) + icon `svg` sizing, `.nav-count` (`.n-amber`/`.n-grey`), `.side-foot`, `.main`, `.topbar` (H1 `.sub`), and the New-view centering rule `.view[data-view="new"] .topbar{justify-content:center;text-align:center}`. Use §3.1 values; cross-check the source HTML.

- [ ] **Step 3:** Author **views + layout containers**: `.view` (hidden by default, `.view.active{display:block}` — or rely on `.hidden`), `.run-list{display:flex;flex-direction:column;gap:18px}`, the New-form `.grid.single{display:grid;grid-template-columns:minmax(0,720px);justify-content:center}`. Add the responsive `@media (max-width:1080px){.sidebar{display:none} …}` from the source.

- [ ] **Step 4:** Author **cards + buttons**: `.card`, `.run-card`(+`.attention`), `.hist-card`, `.card-head`; `.btn-go`, `.btn-ghost`, `.btn-stop`(+`.sm`), `.btn-clear`, `.btn-expand`. Per §3.1.

- [ ] **Step 5:** Author **form controls**: `.field` + label/`.opt`/`.hint`, `.input/.select/.textarea` (+ focus), `.select-wrap::after` caret, `.row-2`, `.seg` + `.seg button.on`, `.switch`(+`.on`), `.file`+`.pick`+`.state`, `.icon-btn`. Preserve our `#prompt-pane`/`#markdown-pane.source-pane` and `.hidden` interplay. Style the project add-form `.add-project`/`.add-project-actions`.

- [ ] **Step 6:** Author **pipeline config rows** `.stage-cfg` (+ `.acc.violet/.green/.peach/.blue`) and the config selects override; keep `.step-model/.step-effort/.step-current` selectors styled.

- [ ] **Step 7:** Author **stepper** `.stages.compact .stage`, `.num`, `.lbl b/small`, and state classes `.s-done/.s-now/.s-pause/.s-stop` + number utilities `.n-grey/.n-green/.n-peach/.n-amber/.n-red/.n-blue/.n-violet`. Per §3.1 state matrix. **No checkmark** content.

- [ ] **Step 8:** Author **status pills + chips + badges**: `.pill-run`(+ family variants + `.pdot` + `@keyframes pulse`), `.pill-status`, `.chip`(+`.qcount`), history `.badge`(+`.green/.red`).

- [ ] **Step 9:** Author **live log**: `.run-log`/`.run-log-head`/`.ll-label`, `.log` (bg `#FBFBF9`, mono, `lh 1.85`), token spans `.log .ok/.run/.info/.t`, and **map our existing line classes** so `appendLog` output is styled: `.log-line{display:flex;gap:10px}`, `.log-ts{color:var(--ink-3)}`, `.log-src{font-weight:600}`, `.log-msg{color:var(--ink-2)}`, and level variants `.lvl-phase .log-msg{color:var(--green-ink)}`, `.lvl-artifact .log-msg{color:var(--blue-ink)}`, `.lvl-error .log-msg{color:var(--red-ink)}`, `.lvl-warn .log-msg{color:var(--amber-ink)}`, `.lvl-system .log-msg{color:var(--ink-3);font-style:italic}`. Add `@keyframes blink` for an optional `.cur` cursor.

- [ ] **Step 10:** Author **question panel** styling on the classes `app.js` emits: style `.q-block` as `.qblock`, `.q-question` as `.qtext` (+ a black-circle `::before` counter or keep JS-numbered), `.q-options/.q-option(.selected)` as `.qopts/.qopt(.sel)`, `.q-free` as `.qfree`, `.q-submit-row` button as `.btn-go`. Also style the container card `#question-card.question-card` as `.qpanel` (amber border, cream bg) and `#question-kind.badge` as `.qcount`. Style gate classes `.gate-intro/.issues/.issue.sev-*/.issue-head/.issue-sev/.issue-title/.issue-detail/.issue-loc/.gate-actions` to match (keep severity left-border accents using status families: critical/major→red/amber, suggestion→blue).

- [ ] **Step 11:** Author **history rows** `.hist-card/.hist-head/.h-meta/.chev/.hist-detail` AND keep the legacy `.history-item/.h-title/.h-meta/.h-status` styled (whichever markup `renderHistory` ends up emitting — see Task 9). Author **viewer** `.viewer` (mono, `--field`/panel bg, rounded). Author **ws indicator** `.dot/.dot-on(green)/.dot-off(grey)` + label.

- [ ] **Step 12:** Author **scrollbars** (`::-webkit-scrollbar*`) using `--line-2` thumb, transparent track.

- [ ] **Step 13:** Verify no CSS parse errors and the page loads. Start server and confirm 200s:

```bash
node ui/server.mjs & SRV=$!; sleep 1
curl -s -o /dev/null -w "style %{http_code}\n" http://localhost:4317/style.css
curl -s -o /dev/null -w "index %{http_code}\n" http://localhost:4317/
kill $SRV
```
Expected: `style 200` / `index 200`. (Full visual check happens after Tasks 2–9 once markup matches.)

- [ ] **Step 14: Commit**
```bash
git add ui/public/style.css
git commit -m "feat(ui): rewrite stylesheet to Refined design system"
```

---

### Task 2: Restructure `index.html` into the sidebar shell + three views

**Files:**
- Rewrite: `ui/public/index.html`

- [ ] **Step 1:** Replace `<header class="topbar">…</header><main class="layout">…</main>` with the `.app` shell. Keep `<head>` (title, `<link rel="stylesheet" href="/style.css">`, `<script src="/app.js" type="module">`). Sidebar markup:

```html
<div class="app">
  <aside class="sidebar">
    <div class="brand"><div class="mark"><span></span></div><div class="name">maestro</div></div>
    <nav class="nav">
      <a href="#new" data-nav="new" class="active"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg><span>New pipeline</span></a>
      <a href="#running" data-nav="running"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg><span>Running</span><span class="nav-count n-amber" id="nav-running-count">0</span></a>
      <a href="#history" data-nav="history"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v4h4"/></svg><span>History</span><span class="nav-count n-grey" id="nav-history-count">0</span></a>
    </nav>
    <div class="side-foot">
      <button type="button" id="install-btn" class="btn-ghost" title="Copy agents + /maestro skill into the project's .claude folder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 3v12M8 11l4 4 4-4"/><path d="M5 21h14"/></svg>
        <span>Install agents</span>
      </button>
      <div class="conn"><span id="ws-dot" class="dot dot-off" title="WebSocket status"></span><span id="ws-label">disconnected</span></div>
    </div>
  </aside>
  <main class="main">
    <!-- views injected below -->
  </main>
</div>
```

- [ ] **Step 2:** Inside `.main`, add the **New view** `<section class="view active" data-view="new">` containing a `.topbar` (H1 "New pipeline" + `.sub` "Plan → Refine → Implement → Review") and the `.grid.single` card holding the **existing form** (`#run-form` with all its current fields/IDs from §3.2), but restyled to the new markup: project `.row-2` (select-wrap + `.icon-btn` ✕), title `.input`, Task source `.seg` (Prompt/Markdown) + textareas, `.file` extras, `.row-2` cycles, then the **Pipeline configuration** block `<div id="pipeline-config">` with four `.stage-cfg` rows (each `data-role`, accent `.acc`, `.step-model`/`.step-effort` selects, `.step-current`), then Mock `.switch` row, then `.actions` → `#start-btn.btn-go` (▶ Start run), then `#form-msg`. Keep `#install-btn` text/behavior (it moved to sidebar; the form's old install button is removed — the sidebar one reuses the same `#install-btn` id).

> Preserve every form ID in §3.2. Convert radios to a `.seg` (two `<button type="button">` toggling `.on`) **only if** you also update `app.js` `syncSourceToggle`/source-read logic; **simplest: keep the `input[name="source"]` radios** visually hidden and drive `.seg` appearance from them, so `el.sourceRadios` logic is untouched. Decide per minimal-churn; document which you chose in the commit.

- [ ] **Step 3:** Add the **Running view** `<section class="view" data-view="running" hidden>`: a `.topbar` with H1 "Running" + `.sub` (JS-updated counts) + right `#running-status-pill`, and `<div class="run-list" id="run-list"></div>` (cards injected by JS). Provide a `<template id="run-card-tpl">` capturing one `.run-card`'s structure (top: title/meta + `.pill-run`; `.stages.compact` with 6 `.stage`; `.run-foot` chip + `.btn-stop.sm`; `.run-log` head + `.log`; an empty `.qpanel` slot) for JS cloning. Keep step elements keyed by `data-step` (preflight/plan/refine/implement/review/done) and cycle holders for refine/review.

- [ ] **Step 4:** Add the **History view** `<section class="view" data-view="history" hidden>`: `.topbar` H1 "History" + `.sub` "Completed and stopped pipelines" + right `#refresh-history.btn-ghost` (Refresh), and `<div class="run-list" id="history"></div>`. Keep `#history` id (JS targets it). Add a `<template id="hist-card-tpl">` if helpful.

- [ ] **Step 5:** Keep a **viewer** element reachable by `#viewer-card/#viewer-title/#viewer/#viewer-close` (can live as a modal/overlay or appended within History). Preserve IDs.

- [ ] **Step 6:** Verify the structural test substrings are present:

```bash
node --test test/projects-ui.test.mjs test/config-ui.test.mjs
```
Expected: PASS (these assert `id="projectSelect"`, `id="add-project"`, `id="project-delete"`, no `id="projectDir"`, `data-role="…"`×4, `step-model`, `step-effort`). If any fail, the corresponding markup hook is missing — add it.

- [ ] **Step 7: Commit**
```bash
git add ui/public/index.html
git commit -m "feat(ui): restructure markup into sidebar shell + 3 views"
```

---

### Task 3: Client-side view router

**Files:**
- Modify: `ui/public/app.js`

- [ ] **Step 1:** Add a router that shows one `.view` at a time and reflects the active nav item. Concrete code:

```js
const views = $$('.view');
const navLinks = $$('.nav a[data-nav]');
function showView(name){
  views.forEach(v => v.classList.toggle('hidden', v.dataset.view !== name));
  views.forEach(v => v.toggleAttribute('hidden', v.dataset.view !== name)); // belt+braces
  navLinks.forEach(a => a.classList.toggle('active', a.dataset.nav === name));
  if (name === 'running') renderRunningView();      // defined in Task 6
  if (name === 'history') loadHistory();             // existing fn
}
navLinks.forEach(a => a.addEventListener('click', e => { e.preventDefault(); showView(a.dataset.nav); location.hash = a.dataset.nav; }));
window.addEventListener('hashchange', () => { const h=location.hash.slice(1); if(['new','running','history'].includes(h)) showView(h); });
```

- [ ] **Step 2:** In the boot sequence (end of `app.js`), call `showView(location.hash.slice(1) || 'new')`.

- [ ] **Step 3:** Add nav-count updaters:

```js
function updateNavCounts(){
  const live = [...runs.values()].filter(r => ['starting','running','waiting'].includes(r.status));
  $('#nav-running-count').textContent = String(live.length);
}
```
(History count set in `renderHistory`: `$('#nav-history-count').textContent = String(pipelines.length)`.)

- [ ] **Step 4:** Manual verify: start server, open `http://localhost:4317`, click each nav item, confirm the correct view shows and the active pill highlights. (Playwright check in Task 11.)

- [ ] **Step 5: Commit**
```bash
git add ui/public/app.js
git commit -m "feat(ui): add client-side view router"
```

---

### Task 4: Wire the New-pipeline form to the new markup

**Files:**
- Modify: `ui/public/app.js`

- [ ] **Step 1:** Retarget the per-step config delegated change handler from `#steps` to `#pipeline-config`. Find the listener (currently `el.steps.addEventListener('change', …)`) and the `$$('.step', el.steps)` lookups used by config; point them at `#pipeline-config`. The `data-role`/`step-model`/`step-effort` logic and `renderStepConfigs/saveStep/addModelFlow/loadConfig` stay identical. Update `el.steps` cache (or add `el.pipelineConfig = $('#pipeline-config')`).

- [ ] **Step 2:** If you kept radios for Task source (recommended), update `.seg` visual sync: in `syncSourceToggle`, also toggle `.on` on the matching `.seg button`. If you replaced radios with `.seg` buttons, rewrite `syncSourceToggle` and the `source` read (`el.sourceRadios.find(...)`) to read a `data-source` state — and ensure the value is still `'prompt'|'markdown'`.

- [ ] **Step 3:** Wire the Mock `.switch`: clicking toggles `.on` and the underlying `#mock` checkbox state (keep `#mock` for `el.mock.checked` read at submit). Wire the file `.pick` to the hidden `#extras`/`#mdFile` inputs; update `.state`/`#mdFileName` text on change (existing handlers; just ensure the new markup wires the click-through).

- [ ] **Step 4:** On successful `POST /api/run` (`beginRun`), instead of resetting one shared canvas: create a RunModel (Task 5), add to `runs`, `updateNavCounts()`, and `showView('running')`. Keep `setFormMsg('Run started.')`.

- [ ] **Step 5:** Verify config still loads/saves: start server, select a project, change a model select in the config rows, confirm a `POST /api/config` fires (watch network / server log) and the `.step-current` caption updates. Run:
```bash
node --test test/config-ui.test.mjs test/projects-ui.test.mjs
```
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add ui/public/app.js
git commit -m "feat(ui): wire New-pipeline form + relocate per-step config to form"
```

---

### Task 5: Multi-run client state model + WebSocket routing

**Files:**
- Modify: `ui/public/app.js`

- [ ] **Step 1:** Replace the scalar `state.runId` with a `runs` Map and a RunModel factory:

```js
const runs = new Map();
function makeRun({ runId, title, projectDir, status='running', startedAt }) {
  return { runId, title: title || '(untitled)', projectDir: projectDir || '',
           status, startedAt: startedAt || nowHMS(),
           maxStepIdx: -1, phaseKey: 'preflight', cycle: 0, phaseStatus: '',
           pendingQuestion: null, logLines: [], el: null };
}
function upsertRun(partial){ let r = runs.get(partial.runId); if(!r){ r = makeRun(partial); runs.set(partial.runId, r);} else Object.assign(r, partial); return r; }
function nowHMS(){ const d=new Date(); return d.toTimeString().slice(0,8); }
```

- [ ] **Step 2:** In `connectWS` `onopen`, after (re)connect, re-subscribe to all known runs:
```js
ws.addEventListener('open', () => { setWsStatus(true); for (const id of runs.keys()) ws.send(JSON.stringify({type:'subscribe', runId:id})); });
```

- [ ] **Step 3:** Rewrite `handleServerMessage` to route by runId instead of dropping foreign runs. **Remove** the filter `if (msg.runId && state.runId && msg.runId !== state.runId) return;`. New shape:
```js
function handleServerMessage(msg){
  if (msg.type === 'hello') {            // server greeting lists all runs
    for (const r of (msg.runs||[])) { upsertRun({ runId:r.runId, title:r.title, projectDir:r.projectDir, status:r.status, startedAt:r.startedAt }); ws.send(JSON.stringify({type:'subscribe', runId:r.runId})); }
    updateNavCounts(); if (currentView()==='running') renderRunningView(); return;
  }
  if (!msg.runId) return;
  const r = upsertRun({ runId: msg.runId });
  switch (msg.type) {
    case 'phase':    onPhase(r, msg); break;
    case 'log':      onLog(r, msg);   break;
    case 'artifact': onArtifact(r, msg); break;
    case 'state':    onState(r, msg); break;
    case 'question': onQuestion(r, msg); break;
    case 'done':     onDone(r, msg);  break;
    case 'error':    onError(r, msg); break;
  }
  updateNavCounts();
}
```
(Confirm the exact field names on `hello.runs[]` by checking `summarizeRuns()` in `ui/server.mjs:114-122` and adapt `r.title/r.status/...` accordingly.)

- [ ] **Step 4:** Convert the step/log/question/done/error handlers to take a RunModel and update **that run's model + card** (not global DOM). Keep the `STEP_ORDER`, `normalizePhase`, `maxStepIdx` logic — but store `maxStepIdx/phaseKey/cycle/phaseStatus` on `r`, and apply to `r.el` (the card) via a `paintStepper(r)` helper (Task 6). `onLog` pushes to `r.logLines` (cap 4000) and appends to the card's `.log` if mounted. `onQuestion` sets `r.pendingQuestion` and renders the inline qpanel (Task 7). `onDone/onError` set terminal status, then `renderRunningView()` (card drops out) and `loadHistory()`.

- [ ] **Step 5:** Verify multi-run smoke. With `mock` mode (no Claude calls), start **two** runs from the New view in quick succession and confirm both appear as separate cards in Running with independent logs/steppers. (Use the app manually + Playwright in Task 11.) Run the suite to ensure nothing server-side broke:
```bash
npm test
```
Expected: all pass **except** `ui-theme.test.mjs` (rewritten in Task 11A). Note that failure is expected at this point.

- [ ] **Step 6: Commit**
```bash
git add ui/public/app.js
git commit -m "feat(ui): multi-run client state + per-run WS routing"
```

---

### Task 6: Run-card component + Running view render

**Files:**
- Modify: `ui/public/app.js`

- [ ] **Step 1:** Implement `renderRunningView()`: build/refresh one `.run-card` per live run, diff against existing `#run-list` children by `data-run-id`, remove cards whose run is terminal/absent. Update the header subtitle: `${live.length} pipelines executing · ${needsInput} needs your input` and toggle the right-side `#running-status-pill` ("N needs input", amber) when `needsInput>0`.

```js
function liveRuns(){ return [...runs.values()].filter(r => ['starting','running','waiting'].includes(r.status)); }
function renderRunningView(){
  const list = $('#run-list'); const live = liveRuns();
  const seen = new Set();
  for (const r of live){ seen.add(r.runId); if(!r.el){ r.el = buildRunCard(r); list.append(r.el);} paintRunCard(r); }
  [...list.children].forEach(c => { if(!seen.has(c.dataset.runId)) c.remove(); });
  const needs = live.filter(r=>r.pendingQuestion).length;
  $('#running-sub').textContent = `${live.length} pipeline${live.length===1?'':'s'} executing · ${needs} need${needs===1?'s':''} your input`;
  // toggle #running-status-pill amber "N needs input"
}
```

- [ ] **Step 2:** Implement `buildRunCard(r)` by cloning `#run-card-tpl`, setting `dataset.runId`, the title/meta ("`<project>` · started `<startedAt>`"), the 6 `.stage` pills (with model·effort sublabels derived from `state.config.steps`), the `.btn-stop.sm` (wired to `POST /api/stop {runId:r.runId}`), the `.log` container, and an empty `.qpanel` slot. Return the node (not yet painted).

- [ ] **Step 3:** Implement `paintStepper(r)` mapping run state → stepper classes per the §3.1 matrix: steps `< maxStepIdx` → `.s-done`+`.n-green`; current step → `.s-now`+`.n-peach` (running) or `.s-pause`+`.n-amber` (status `waiting`/has pendingQuestion) or `.s-done` if phaseStatus∈{done,complete,passed}; stopped → `.s-stop`+`.n-red` on the current step; else pending (`.n-grey`). Write cycle text into refine/review `.cycle`. Implement `paintRunCard(r)` = status pill (family by status: running→peach "Refining"? use phase-appropriate text; waiting→amber "Paused · awaiting answers"; implement phase→blue "Implementing"), foot chip ("`<Phase>` cycle X / N" or "`<phase> paused · K questions`"), stepper, and ensure the `.log` reflects `r.logLines`.

> Status-pill copy mapping (match mockups): running+refine→"Refining" (peach); running+implement→"Implementing" (blue); waiting/has question→"Paused · awaiting answers" (amber); starting→"Starting" (peach); else show the phase. Keep it data-driven from `r.phaseKey`/`r.status`.

- [ ] **Step 4:** Per-card live log: `onLog(r,msg)` appends a `.log-line.lvl-<level>` (ts/src/msg) to `r.el .log` if mounted; honor a per-card or global `#autoscroll`. Reuse the existing `appendLog` DOM-building logic but scope the container to `r.el`.

- [ ] **Step 5:** Verify visually (mock mode, 1–3 runs): start runs, watch steppers advance, status pills change, logs stream, Stop removes a run from Running. Screenshot in Task 11. Quick check:
```bash
node ui/server.mjs & SRV=$!; sleep 1; echo "open http://localhost:4317/#running"; kill $SRV
```

- [ ] **Step 6: Commit**
```bash
git add ui/public/app.js
git commit -m "feat(ui): run-card component + Running view (multi-pipeline)"
```

---

### Task 7: Inline question panel inside the run card

**Files:**
- Modify: `ui/public/app.js`

- [ ] **Step 1:** Move clarify/gate rendering into the run card. `onQuestion(r,msg)` stores `r.pendingQuestion`, sets `r.status='waiting'`, paints the card's `.qpanel` slot via the existing `renderClarify`/`renderGate` (retargeted to write into `r.el .qpanel` instead of the global `#question-body`). Keep the emitted class names (`.q-block/.q-question/.q-options/.q-option/.q-free/.q-submit-row`, gate `.issue*`) so Task 1 Step 10 styles apply; the panel wrapper gets the `.qpanel` look + the `?` head + amber `.qcount` ("K questions").

- [ ] **Step 2:** `sendAnswer` must post `{runId: r.runId, id, payload}` to `/api/answer` for the **specific run** (currently uses the single `state.runId`). Read the runId from the card the submit button lives in (`btn.closest('.run-card').dataset.runId`). On success, clear `r.pendingQuestion`, remove the qpanel, set status back to running, repaint.

- [ ] **Step 3:** Mark the needs-input card: when `r.pendingQuestion`, add `.attention` to `r.el` (amber ring) and set the Plan (or current) step to `.s-pause`. Remove on answer.

- [ ] **Step 4:** Verify with a mock run that pauses for clarification (the mock orchestrator path / `test/clarify.test.mjs` shows the question shape). Confirm the panel renders inside the card, options select (`.sel`), free-text works, and submitting resumes. Screenshot in Task 11.

- [ ] **Step 5: Commit**
```bash
git add ui/public/app.js
git commit -m "feat(ui): inline question/gate panel per run card"
```

---

### Task 8: History view as expandable cards

**Files:**
- Modify: `ui/public/app.js`

- [ ] **Step 1:** Rewrite `renderHistory(pipelines)` to emit `.hist-card`s: collapsed `.hist-head` = `.badge`(DONE green / STOPPED red / etc. via `statusClass`) + `.h-meta`(title `b` + timestamp `small`) + cycle `.chip`s ("Refine ×N", "Review ×N", or "stopped at `<Phase>`") + `.chev`. Click toggles `[aria-expanded]` → reveals `.hist-detail` with a `.stages.compact` stepper tinted by outcome (DONE → all `.s-done`; STOPPED → `.s-done` up to the reached step, `.s-stop` on the stop step, pending after). Keep the click-to-`viewPipeline` affordance (e.g. a "View saved markdown" action inside the expanded detail, or keep title click → viewer). Preserve `#history` container id and set `#nav-history-count`.

> Cycle counts: derive Refine×/Review× from the saved pipeline record (the same data the current `renderHistory` reads). If counts aren't in the record, omit the chips rather than guess — and `log()` nothing (silent omission is fine here, but prefer to surface real data).

- [ ] **Step 2:** Keep `loadHistory` (GET `/api/runs?projectDir`, read `data.pipelines`), `renderHistoryError`, `viewPipeline`, viewer show/hide. Wire `#refresh-history`.

- [ ] **Step 3:** Verify: with a project that has saved pipelines, open History, confirm rows render, expand works, chevron rotates, stepper shows. If none exist, run a quick mock pipeline to completion first. Screenshot in Task 11.

- [ ] **Step 4: Commit**
```bash
git add ui/public/app.js
git commit -m "feat(ui): expandable history cards with steppers + chips"
```

---

### Task 9: Connection indicator + status badge plumbing

**Files:**
- Modify: `ui/public/app.js`

- [ ] **Step 1:** `setWsStatus(connected)` still sets `#ws-dot.className='dot '+(connected?'dot-on':'dot-off')` and `#ws-label.textContent`. The indicator now lives in the sidebar `.side-foot .conn`; confirm the elements exist there.

- [ ] **Step 2:** Audit any remaining references to the **old** global single-run elements that no longer exist (`#run-status`, global `#stop-btn`, global `#question-card`, global `#log`, `#steps`). Either remove the references or repoint them to per-card equivalents. Search:
```bash
grep -n "getElementById\|querySelector\|\$('#" ui/public/app.js | grep -E "run-status|stop-btn|question-card|'#log'|'#steps'|question-body|question-title|question-kind"
```
Resolve each hit (per-card now). Ensure no `ReferenceError`/null-deref at boot — open the app with devtools console open, confirm zero errors.

- [ ] **Step 3:** Verify the full app boots cleanly:
```bash
node ui/server.mjs & SRV=$!; sleep 1
curl -s http://localhost:4317/ | grep -c 'data-view'   # expect >=3 view sections
kill $SRV
```
Expected: `3` (new/running/history). Manually confirm no console errors across all three views.

- [ ] **Step 4: Commit**
```bash
git add ui/public/app.js
git commit -m "fix(ui): repoint connection + status hooks for multi-run shell"
```

---

### Task 10: Smoke + regression of behavior (offline)

**Files:** none (verification task)

- [ ] **Step 1:** Run the offline smoke. Note: `npm run smoke` is a **CLI/core** dry run (`MAESTRO_MOCK=1 node src/cli/maestro.mjs --project examples/sandbox --prompt "demo task" --mock --yes`) — it exercises the orchestrator with no Claude calls and **does not touch the UI**. It is a regression guard that the redesign didn't disturb shared modules (the UI is isolated under `ui/`, so it should pass unchanged):
```bash
npm run smoke
```
Expected: passes (no Claude calls). The UI itself is verified via the running server + content tests + Playwright (Task 11B). The UI's "Mock mode" toggle is a separate path: it POSTs `mock:true` to `/api/run` so you can drive end-to-end mock pipelines in the browser without Claude calls — use that to populate the Running/History views during visual verification.

- [ ] **Step 2:** Run the non-theme test suite:
```bash
node --test test/projects-ui.test.mjs test/config-ui.test.mjs test/agent-log.test.mjs test/clarify.test.mjs test/config.test.mjs test/config-api.test.mjs test/projects.test.mjs test/projects-api.test.mjs test/runner-args.test.mjs
```
Expected: all PASS. Fix any markup-hook regressions before proceeding.

- [ ] **Step 3: Commit** (if any fixes were needed)
```bash
git add -A && git commit -m "test(ui): keep markup/behavior tests green under redesign"
```

---

### Task 11A: Rewrite the theme test for the new palette

**Files:**
- Rewrite: `test/ui-theme.test.mjs`

- [ ] **Step 1:** Replace the old palette assertions with ones for the new tokens. Use the existing `tokenValue(name)` helper pattern (regex `--<name>\s*:\s*([^;]+);`). New test:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../ui/public/style.css'), 'utf8');
const tokenValue = (name) => { const m = css.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`)); return m ? m[1].trim().toLowerCase() : null; };

test('refined palette: warm off-white canvas + white panels', () => {
  assert.equal(tokenValue('bg'), '#f1f1ef');
  assert.equal(tokenValue('panel'), '#ffffff');
  assert.equal(tokenValue('ink'), '#19191b');
});

test('refined palette: status families present', () => {
  for (const [t, v] of Object.entries({
    'green':'#5bae5b','peach':'#efa63c','red':'#e76a5a','blue':'#5ba6cc','violet':'#8c7fd6','amber':'#e6962a',
  })) assert.equal(tokenValue(t), v, `--${t}`);
  for (const fam of ['green','peach','red','blue','violet','amber']) {
    assert.ok(tokenValue(`${fam}-bg`), `--${fam}-bg missing`);
    assert.ok(tokenValue(`${fam}-ink`), `--${fam}-ink missing`);
  }
});

test('refined shape tokens', () => {
  assert.equal(tokenValue('r-card'), '24px');
  assert.equal(tokenValue('r-ctrl'), '14px');
});

test('self-hosted webfonts declared', () => {
  assert.match(css, /@font-face[\s\S]*Poppins[\s\S]*\.woff2/i);
  assert.match(css, /@font-face[\s\S]*JetBrains Mono[\s\S]*\.woff2/i);
});

test('old dark/blue theme fully removed', () => {
  for (const dead of ['#0e1116','#0a0d12','#232c38','#4f9cf9']) assert.ok(!css.includes(dead), `stale color ${dead} still present`);
});

test('log surface styled', () => {
  assert.match(css, /\.log\s*\{[^}]*background:/);
});
```

- [ ] **Step 2:** Run it:
```bash
node --test test/ui-theme.test.mjs
```
Expected: PASS. (If `--bg` etc. differ from the source HTML you ported, align the test to the actual tokens — the source HTML is truth.)

- [ ] **Step 3:** Full suite green:
```bash
npm test
```
Expected: ALL PASS.

- [ ] **Step 4: Commit**
```bash
git add test/ui-theme.test.mjs
git commit -m "test(ui): assert Refined palette + self-hosted fonts"
```

---

### Task 11B: Visual verification against the mockups (Playwright MCP)

**Files:** none (verification task). Uses the Playwright MCP browser tools.

- [ ] **Step 1:** Start the UI server in the background:
```bash
node ui/server.mjs   # serves http://localhost:4317
```

- [ ] **Step 2:** For each view, navigate + screenshot + compare to the mockup. Use `browser_navigate` then `browser_take_screenshot` (full page) at a ~1440px-wide viewport (`browser_resize` 1440×900):
  - `http://localhost:4317/#new` → compare to `ui-redesign-mockups/01-new-pipeline-top.png` + `02-new-pipeline-config.png` (sidebar, centered card, segmented toggle, config rows w/ accent bars, black Start, Install agents pill).
  - Start 2–3 mock runs (set Mock mode on, pick a project, Start, repeat) → `#running` → compare to `03-running-needs-input.png` + `04-running-list.png` (multiple cards, status pills, steppers, chips, per-card logs; if a run pauses, the amber attention ring + inline question panel).
  - `#history` → compare to `05-history.png` (DONE/STOPPED badges, chips, expandable steppers; expand a row and screenshot).

- [ ] **Step 3:** Check each against this acceptance checklist; fix CSS/markup until they match:
  - [ ] Sidebar: 248px, white, brand "o" mark, three nav items, active = solid black pill, Running badge amber, Install agents pinned bottom.
  - [ ] Canvas `#F1F1EF`; cards white, 24px radius, soft shadow.
  - [ ] Poppins everywhere (headings + body); JetBrains Mono in logs (verify fonts actually load — Network shows woff2 200, not a system fallback).
  - [ ] New form: centered ≤720px; segmented Prompt/Markdown; dashed file input; cycle inputs; 4 config rows with violet/green/peach/blue accent bars + model + effort selects; Mock iOS toggle; black ▶ Start run.
  - [ ] Running: header live counts + amber "needs input" pill; each card top→bottom = title/meta + status pill, 6-pill stepper with correct color states, foot chip + red Stop, live log with green Auto-scroll toggle and color-coded source tokens; paused card has amber ring + inline question panel with black numbered bullets, white option rows (selected = black), "Or type your own answer…", black "Submit answers & resume".
  - [ ] History: Refresh ghost button; rows with DONE/STOPPED badge, title, timestamp, Refine×/Review× chips, chevron; expanded shows tinted 6-pill stepper; stopped row shows red Implement pill + "stopped at Implement" chip.
  - [ ] Responsive: below ~1080px sidebar hides and content stacks without breaking.

- [ ] **Step 4:** Stop the server. No commit (verification only); commit any fixes made during this task with `fix(ui): match mockup — <detail>`.

---

## 6. Final self-review (run before declaring done)

- [ ] **Spec coverage:** every mockup screen (New/Running/History) + every component in §3.1 has a task. Multi-pipeline Running implemented (Task 5–7). Fonts self-hosted (Task 0). Theme test rewritten (Task 11A).
- [ ] **DOM contract:** all §3.2 IDs/classes preserved or their JS updated in lockstep. No `id="projectDir"` reintroduced. `appendLog` still consumes `{source,level,text,ts}`.
- [ ] **Tests:** `npm test` fully green (including rewritten `ui-theme.test.mjs`); `npm run smoke` passes offline.
- [ ] **Visual:** all five mockup screenshots reproduced (Task 11B checklist).
- [ ] **No placeholders:** every CSS value sourced from §1/§3.1 or re-extracted from the source HTML; no "TBD"/"handle later".

## 7. Risks & notes

- **Biggest risk = the `app.js` multi-run refactor** (Task 5). The single→multi-run conversion touches the WS router, step painting, log, question, stop, and done/error paths. Mitigate by keeping `STEP_ORDER`/`normalizePhase`/`maxStepIdx` semantics intact and only changing *where* state lives (per-run model + per-card DOM). Confirm `hello.runs[]` field names against `summarizeRuns()` in `ui/server.mjs` before relying on them.
- **Server needs no change** — it already broadcasts all runs and serves `/fonts/*`. Do not modify `ui/server.mjs` unless a gap is found.
- **Minimal-churn choice for Task source:** keep the hidden `input[name="source"]` radios and drive the `.seg` look from them, so `el.sourceRadios` logic is untouched.
- **Per-step config relocation** must keep the exact substrings `data-role="planner|refiner|implementer|reviewer"`, `step-model`, `step-effort` in `index.html` and `renderStepConfigs`/`addModelFlow`/`/api/config` in `app.js` (config-ui test).
- **Keep `app.js` as the home** of `loadProjects`, `selectedProjectPath`, `renderStepConfigs`, `addModelFlow` and the `fetch('/api/projects')`/`/api/config` strings (projects-ui/config-ui tests assert against `app.js` specifically). If you split modules, re-point those tests.
- **Work on `main`, no PR** (per request). Commit per task as shown.

---

## 8. Execution handoff

Plan complete and saved to `UI_REDESIGN_PLAN.md` (project root). Mockups in `ui-redesign-mockups/`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task with review between tasks (use superpowers:subagent-driven-development).
2. **Inline Execution** — execute tasks in one session with checkpoints (use superpowers:executing-plans).

Attach this file **and** the five mockups + the source HTML (`/Users/denislavprinov/Downloads/Maestro Refined (standalone) (1).html`) to the implementation agent.
