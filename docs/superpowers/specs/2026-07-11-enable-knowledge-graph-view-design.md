# Enable: Knowledge Graph View — Design

Date: 2026-07-11
Status: Approved (pending spec review)
Surface: `apps/enable` (Electron + Express)

## Goal

Let a user see the graphify knowledge graph for a project from inside the
enable app, in a human-readable form, with the cheapest possible build.

## Key insight

graphify already emits everything needed. Enable does **not** generate a graph;
it only surfaces existing artifacts in `<project>/graphify-out/`:

- `graph.html` (~350 KB) — interactive graph. Embeds node/edge data inline, but
  loads `vis-network.min.js` from the unpkg CDN → offline = blank canvas.
- `GRAPH_REPORT.md` — plain-language report with clean `##` markdown headers
  (Summary, Community Hubs, God Nodes, Surprising Connections, Suggested
  Questions, etc.). Zero dependencies. The most "human readable" artifact.
- `graph.json` — raw data. Enable already reads its node count at
  `apps/enable/server.mjs:139`.

Decision: **A+B combined** — show the interactive `graph.html` in an embedded
iframe **and** render `GRAPH_REPORT.md` as a text panel beside it. Vendor
`vis-network.min.js` locally so the graph works offline.

## Architecture

Enable plumbs and gates; it does not transform graph data. Two existing
artifacts, three thin read-only server routes, one new UI screen.

```
project dir ──> graphify-out/graph.json   (exists check, node count)
            ──> graphify-out/graph.html    (served, CDN src rewritten)
            ──> graphify-out/GRAPH_REPORT.md (served raw, md→html in UI)
public/vendor/vis-network.min.js           (vendored once, static-served)
```

## Server (`apps/enable/server.mjs`)

All routes resolve the project dir through a single `resolveProjectDir(name)`
helper and are read-only.

### `resolveProjectDir(name)` (shared, security-critical)

- Look the project up by **name** against the existing project list
  (immediate git-repo subdirs of `PROJECTS_ROOT`, logic already at
  `server.mjs:81`). Return that dir's absolute path.
- Reject anything not in that list. Do **not** accept arbitrary paths, `..`
  segments, or absolute paths from the client. Unknown name → `404`.
- This confines all graph routes to known projects under `PROJECTS_ROOT`.

### `GET /api/enable/graph/exists?project=<name>`

- Resolve dir. Read `graphify-out/graph.json` via the existing
  `readJsonSafe` helper.
- Response: `{ exists: boolean, nodes: number, hasReport: boolean, hasHtml: boolean }`
  - `exists` = graph.json present and parseable.
  - `nodes` = node count (reuse logic at `server.mjs:139`).
  - `hasHtml` = `graphify-out/graph.html` exists.
  - `hasReport` = `graphify-out/GRAPH_REPORT.md` exists.
- Never throws; missing dir/file → `{ exists: false, nodes: 0, hasReport: false, hasHtml: false }`.

### `GET /api/enable/graph/view?project=<name>`

- Resolve dir. Read `graphify-out/graph.html` as UTF-8.
- Rewrite the vis-network CDN script tag to the local vendored copy:
  replace the unpkg URL
  `https://unpkg.com/vis-network@<ver>/standalone/umd/vis-network.min.js`
  with `/vendor/vis-network.min.js`. Use a regex tolerant of the version
  (`https://unpkg.com/vis-network@[^"']+/standalone/umd/vis-network.min.js`)
  so a graphify version bump does not break the rewrite.
- Send with `Content-Type: text/html`.
- Missing `graph.html` → `404` (UI falls back to report-only).

### `GET /api/enable/graph/report?project=<name>`

- Resolve dir. Read `graphify-out/GRAPH_REPORT.md` as UTF-8, send as
  `text/markdown` (or `text/plain`).
- Missing → `404` (UI shows graph-only).

### Vendored asset

- Add `apps/enable/public/vendor/vis-network.min.js` (pinned to the version
  graphify's `graph.html` references). Served by the existing
  `express.static(PUBLIC_DIR)` middleware — no new static route.

## UI (`apps/enable/public/`)

### New screen: `#graph` (`index.html`)

A new `<section id="graph" class="screen">` (same screen pattern as
`home`/`setup`/`progress`/`results`), containing:

- Header with project name + a "Back" / close control returning to the
  previous screen.
- `<iframe id="graph-frame" src="" title="Knowledge graph">` — the interactive
  graph. `src` set to `/api/enable/graph/view?project=<name>` when opened.
- `<div id="graph-report" class="graph-report">` — rendered report HTML.
- Empty/fallback states (see Edge cases).

Layout: iframe and report side-by-side on wide viewports, stacked on narrow;
plain fl/grid in `styles.css`. Reuse existing card/panel styling.

### Entry points (`app.js`)

- **Home** (`#home`): a "View knowledge graph" button, shown once a project is
  selected. On project selection, call `graph/exists`; enable the button when
  `exists && hasHtml`; when `!exists`, show it disabled with hint text
  "Run /graphify on this project first."
- **Results** (`#results`): same button, so the user can view the graph after a
  run. Same gating.

### Report rendering (`app.js`)

- Fetch `graph/report`, render markdown → HTML with a small inline renderer
  (headings `#`/`##`/`###`, lists, paragraphs, inline code, bold, links).
  No external markdown library — the report is regular and the subset is small.
- Escape HTML in the source before applying markdown so report content cannot
  inject markup.

### Data flow

```
select project
  → GET graph/exists
  → gate "View knowledge graph" button
  → click → show #graph screen
      → iframe.src = graph/view?project=…   (rewritten HTML + local vis-network)
      → GET graph/report → md→html → #graph-report
```

All local; identical in Electron window and browser.

## Edge cases

- No `graphify-out/` at all → `exists:false`; button disabled + hint.
- `graph.json` present but `graph.html` missing → report-only view; iframe area
  shows "Interactive graph not available — run /graphify to regenerate."
- `GRAPH_REPORT.md` missing → graph-only view; report panel shows a short note.
- Graphs > 5000 nodes are already aggregated to a community view by graphify;
  enable does nothing special.
- Path traversal / unknown project name → `404` from `resolveProjectDir`.
- Offline → vendored vis-network keeps the graph rendering.

## Testing

Server (fixtures: one project with full `graphify-out/`, one with only
`graph.json`, one with none):

- `exists` returns correct `{exists,nodes,hasReport,hasHtml}` for each fixture.
- `view` rewrites the unpkg vis-network URL to `/vendor/vis-network.min.js`
  (assert the CDN string is gone and the local path is present).
- `view` / `report` return `404` when the artifact is missing.
- `resolveProjectDir` rejects `..`, absolute paths, and unknown names (`404`);
  no route escapes `PROJECTS_ROOT`.

UI:

- Button gating: enabled only when `exists && hasHtml`; disabled + hint
  otherwise.
- Opening `#graph` sets iframe `src` to the correct project.
- Report markdown renders (headings/lists present; source HTML escaped).
- Fallback states render when html or report is absent.

## Out of scope

- Generating or updating the graph from enable (still done via `/graphify`).
- Custom in-app graph rendering from `graph.json`.
- Editing/querying the graph from enable.

## Files touched

- `apps/enable/server.mjs` — `resolveProjectDir` + 3 routes.
- `apps/enable/public/index.html` — `#graph` screen + entry buttons.
- `apps/enable/public/app.js` — gating, screen wiring, md renderer.
- `apps/enable/public/styles.css` — graph screen layout.
- `apps/enable/public/vendor/vis-network.min.js` — vendored (new).
- Tests alongside enable's existing test setup.
