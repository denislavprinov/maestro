# Pipeline Tabs — Visual Separation of Concurrent Pipelines

**Date:** 2026-06-27
**Status:** Design approved, pending implementation plan

## Problem

Multiple pipelines (orchestration runs) execute concurrently. Today they all
render as stacked cards on the single **Running** view ([app.js:6397](../../../ui/public/app.js#L6397)).
With several live runs the page is hard to scan, and there is no way to focus on
one pipeline or to tell — without scrolling — which one needs the user (e.g. a
clarify question waiting on an answer).

## Goal

Give each running pipeline its own navigable tab, nested under **Running** in the
sidebar, so the user can:

1. **See at a glance** every pipeline that is running and which ones need attention.
2. **Focus** on one pipeline at a time (full-screen, others hidden).
3. Be told passively — never yanked — when a pipeline needs input, even while on
   another view.

## Constraints

- **No database or server change.** All new behavior is client-side. The existing
  WebSocket `hello`/event stream already carries everything needed
  ([server.mjs:284 `summarizeRuns`](../../../ui/server.mjs#L284)).
- Reuse existing card painters, question panel, WS layer, and `/api/answer`.

## Design

### Layout — global pipeline tabs nested under "Running"

```
┌ NAV ─────────────┐
│  New             │
│  Running    ⑶ !  │  parent: live-count badge + amber "!" roll-up
│   ├ ● auth-fix ! │  child = focus tab (amber dot = needs you)
│   ├ ● seo-pSEO   │
│   └ ◐ groundwork │  greyed = finished, unread, lingering
│  History         │
│  Workspaces      │
│  ...             │
└──────────────────┘
```

- **Parent "Running"** keeps the existing live-count badge (`#nav-running-count`,
  [app.js:6455](../../../ui/public/app.js#L6455)) and gains an **amber roll-up dot**
  shown whenever any child has `pendingQuestion != null`. The roll-up is visible
  from any view, so "something needs you" is never hidden behind the current page.
- **Child rows** render one per pipeline that is either live or lingering-finished.
  Auto-expanded when ≥1 such run exists; the parent has a collapse arrow.
- Mirrored in the mobile compact topnav ([index.html:72](../../../ui/public/index.html#L72)).

### Two views under Running

| Hash | View | Behavior |
|------|------|----------|
| `#running` | **Overview** (parent click) | Today's stacked cards, condensed/compact. Scan-all "mission control". Click a card → that run's focus view. |
| `#running/<runId>` | **Focus** (child click) | The single run's full card, others hidden. This is the core fix for "hard to separate visually." |

Routing extends the existing hash router ([app.js:6489 `showView`](../../../ui/public/app.js#L6489)).
`state.selectedRunId` (in-memory, transient — not persisted across reload) drives
the focus selection.

### Child row anatomy

- **Status dot** (left):
  - amber — needs input (`pendingQuestion != null`)
  - blue — running
  - grey-pulse — starting / pausing
  - green — done
  - red — error / stopped
- **Title** — truncated `r.title` + small project hint.
- The amber dot doubles as the "needs you" marker — no separate icon.

### Ordering (top → bottom)

1. Needs-attention (`pendingQuestion != null`)
2. Running / starting
3. Finished-unread (lingering)

Within each group: most-recently-active first.

### Lifecycle — linger until opened once (option C)

A finished run does not vanish immediately; it lingers as a greyed child row
until the user has looked at it once.

- A run finishing **live** (a `done`/`error`/`stopped` event received over the
  open WebSocket) → its child row goes greyed with the final-status dot and stays.
- Opening that run's focus view marks it **acknowledged** → persisted to
  `localStorage` → the row drops on the next render.
- A never-opened finished run persists across a page reload (via `localStorage`),
  so a result is not lost just because the tab was reloaded.
- **Seed-on-first-hello:** the server never prunes terminal runs, so the first
  `hello` after a server restart would otherwise dump every old finished run as
  "unread." On the first hello of a session, all already-terminal runs are marked
  acknowledged. Only runs that finish **live while connected** become lingerers.

### State

| Name | Where | Purpose |
|------|-------|---------|
| `state.selectedRunId` | memory | which run is focused (`#running/<runId>`) |
| `acknowledged` Set ↔ `localStorage` key `maestro.ackRuns` | localStorage | runIds the user has seen post-finish |

### Reuse — touched vs untouched

- **Untouched:** WebSocket layer ([app.js:203](../../../ui/public/app.js#L203)),
  `/api/answer`, the card builder/painter (`buildRunCard` / `paintRunCard` /
  `renderQpanel`), all server code.
- **Extended:** `liveRuns()` ([app.js:6001](../../../ui/public/app.js#L6001)) to
  also surface lingering-unread finished runs (gated by `acknowledged`); `showView`
  / hash router for `#running/<runId>`; sidebar nav template for child rows + the
  parent roll-up dot.
- Child rows re-render on the same WS events that already drive the cards
  (`phase` / `question` / `done` / ...) — **no new sync**.

## Non-goals (YAGNI)

- No database or server change.
- No auto-navigation, no toasts — signals are passive; the user clicks when ready.
- No drag-reorder or pinning of tabs.
- No cross-project grouping in the strip (flat list).
- No desktop notifications or sound.
- No persistence of `selectedRunId` across reload.

## Open questions

None blocking. A server-side recency cap on retained terminal runs is a possible
future nice-to-have but is explicitly out of scope here (no server change).
