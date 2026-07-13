# Enable Readiness App: v1 frontend

Date: 2026-07-13
Status: SUPERSEDED — enable-app branch already ships this (see plan header note)

## Problem

`apps/enable/` (P2, commit `9d88ad1`) ships a working onboarding-only server
(`apps/enable/server.mjs`, 88 lines) and an Electron shell, but **no frontend**:
`apps/enable/public/` does not exist, so `express.static(PUBLIC_DIR)`
(`server.mjs:84`) serves nothing and the Electron window opens blank. The
backend readiness event stream (baseline / cycle / final, derived in
`src/core/onboarding.mjs:146-176`) broadcasts into the void — no screen renders
the readiness card that is the product's entire point.

A complete earlier frontend exists in worktree `mystifying-gould-e9599c`
(public/ + 411-line renderer test + richer server), but P2 deliberately rewrote
the server minimal ("NOT a fork of ui/server.mjs").

## Decisions (user-confirmed)

1. **Fresh minimal build, steal patterns.** Build a lean frontend matching P2's
   minimal-server philosophy. Reuse proven markup/test patterns from the prior
   app where they fit, but only for views the current 88-line server supports.
2. **Core flow only in v1.** Pick project → answer 5 setup questions → watch
   run → readiness card. Zero new server endpoints. History, changes/diff view,
   and interactive gates are explicitly deferred.
3. **Picker = list + manual path field.** Render the `GET /api/enable/projects`
   list plus a free-text absolute-path input as escape hatch. No `/browse`
   endpoint in v1.
4. **Approach A: vanilla 3-file SPA.** `public/{index.html, app.js, styles.css}`,
   no build step, screen state machine. Matches the `ui/` composer convention;
   testable with jsdom exactly like the prior `enable-renderer` tests.
   (Rejected: B — vendored preact/lit, overkill for 3 screens; C —
   server-rendered pages, fights the live WS stream.)

## Design

### Screens — one page, 3 states

State machine: **Setup → Running → Report**.

**Setup**
- Project list from `GET /api/enable/projects` + free-text absolute-path input.
  Manual path, when non-empty, wins over list selection.
- Form for the 5 fixed clarify questions (the `enableClarifier` set is
  deterministic — `agents/maestro-enable-clarifier.md` always emits exactly
  these ids — so the UI hardcodes them):
  - `testTier` — radio: scaffold (default) / docs-only / smoke / characterization
  - `vendoringDepth` — radio: full (default) / baseline-only / none
  - `multiToolTargets` — checkboxes: Cursor / Copilot / AGENTS.md; CLAUDE.md
    shown as locked-on. UI sends an **array of label keys**
    (`["cursor","copilot"]`); the server side's `joinMultiToolTargets`
    (`src/core/onboarding.mjs:48-54`) maps keys → files and forces CLAUDE.md.
  - `canary` — yes/no toggle (default yes)
  - `scopeConstraints` — free textarea (optional)
- Mock-mode checkbox (dev aid; maps to `mock: true` in the run POST).
- Run button → `POST /api/enable/run {projectDir, answers, mock}` → `{runId}`.

**Running**
- 6-phase stepper — Clarify → Analyze → Infra → Tests → Evaluate → Canary —
  driven by `phase` events (match on `nodeId`/`phase` the same way
  `matchNode` does in `onboarding.mjs:86-88`).
- Baseline score chip when `readiness {kind:"baseline"}` arrives.
- Per-cycle score chips on `readiness {kind:"cycle"}` — makes the
  `s_eval → s_infra` rewind loop visible (cycle 2, 3, …).
- Scrolling log tail from `log` events.
- Error banner region (see Error handling).

**Report**
- Rendered on `readiness {kind:"final"}`.
- Big final score, headline `baseline → final (+delta)` (e.g. "28 → 93, +65").
- 9 dimension bars. Labels are a UI-local copy of `DIMENSION_LABELS`
  (`src/core/onboarding.mjs:35-40`); a test imports both and asserts parity so
  drift breaks CI.
- Gaps list, branch name (from run `done`/state), "Run another" button →
  back to Setup.

### Data flow

- Load → `GET /api/enable/projects` → render list.
- Run → `POST /api/enable/run` → `{runId}` → open `WS /ws?runId=<id>`.
- The server replays the per-run buffer on connect (`server.mjs:38`), so a
  reconnect after drop loses nothing (buffer cap 5000).
- WS message router keyed on `type`: `phase` → stepper; `readiness` →
  chips/card; `log` → tail; `error`/`done` → terminal states. Unknown types
  ignored (forward compatible).
- `runId` kept in `location.hash` (`#run=<id>`) — a mid-run page refresh
  reattaches via the replay buffer. No server change needed.

### Error handling

- WS `close` while a run is active → reconnect with backoff (1s → 5s cap);
  replay restores state idempotently (renderers must tolerate re-delivered
  events — e.g. phase/stepper updates are level-triggered, chips deduped by
  cycle number).
- `error` event, or `done` with a failed status → red banner on the Running
  screen; log stays visible.
- `POST /run` failure → inline error on the Setup form; stay on Setup.
- Malformed WS JSON → skip the message, `console.warn`.

### Testing

jsdom + `node:test`, pattern lifted from the prior worktree's
`enable-renderer.mjs`: boot DOM from the real `index.html`, inject FakeWS +
fake fetch. Cases:

1. Setup renders the projects list; manual path wins over list selection.
2. Run POST body shape — all 5 answer ids present; `multiToolTargets` is an
   array of keys.
3. `phase` events advance the stepper, including the eval→infra rewind
   (cycle 2 re-lights Infra/Tests/Evaluate).
4. `readiness` baseline/cycle/final render score, delta, all 9 dimensions,
   gaps.
5. Dimension-label parity: import `DIMENSION_LABELS` from
   `src/core/onboarding.mjs` and the UI copy; assert deep-equal.
6. Reconnect: closing the FakeWS while running constructs a new FakeWS with
   the same runId.

`test/onboarding-api.mjs` untouched, stays green. `jsdom` already in root
devDependencies (`package.json:32`).

## Affected files

| File | Action |
|------|--------|
| `apps/enable/public/index.html` | new — 3 screens markup, a11y roles/labels |
| `apps/enable/public/app.js` | new — state machine, WS router, renderers (~300–400 lines) |
| `apps/enable/public/styles.css` | new — dark theme matching the `ui/` composer look |
| `test/enable-renderer.test.mjs` | new — the 6 cases above |
| `apps/enable/server.mjs`, `apps/enable/electron/main.mjs`, `src/core/*` | **unchanged** |

## Non-goals (deferred, recorded)

- Run history / persistence (in-memory `runs` Map is v1-acceptable).
- Changes/diff view of pipeline-written files.
- Interactive gates (the `/api/enable/answer` route stays dormant;
  `runOnboarding` keeps auto-answering).
- Directory browser endpoint.
- Auth / non-localhost exposure (server binds 127.0.0.1).
- Workspace/multi-repo selection.

## Open questions

None.
