# Enable: create TODO.md tasks from "Still worth doing" gaps

Date: 2026-07-12
Status: approved (brainstorm with Bulibas)

## Problem

After an Enable run, the results screen lists remaining readiness gaps under
"Still worth doing" — but the list is a dead end. Nothing turns the advice into
trackable work.

## Decision

One-click button that writes all gaps as checkbox tasks to `TODO.md` at the
enabled project's root. Chosen over GitHub/Jira issues (external deps) and a
client-side download (breaks one-click flow). All gaps at once — no per-gap
selection UI.

## Server — `POST /api/todo` (apps/enable/server.mjs)

Request: `{ dir: string, gaps: string[] }`

- Validate: `dir` exists and is a directory; `gaps` non-empty array of strings.
  Else 400 `{ error }`.
- Target file: `<dir>/TODO.md`. Create if missing.
- Append section:

  ```markdown
  ## Enable — still worth doing (2026-07-12)

  - [ ] <gap 1>
  - [ ] <gap 2>
  ```

- Dedup: skip any gap whose `- [ ] <text>` (or `- [x] <text>`) line already
  exists verbatim anywhere in the file. If all gaps skipped, append nothing.
- Response: `{ written: n, skipped: n, path: '<dir>/TODO.md' }`.
- Write failure (permissions etc.): 500 `{ error }`.

## UI (apps/enable/public/index.html + app.js + styles.css)

- Ghost button `Create tasks in TODO.md` in the `gaps-wrap` header row, next to
  the "Still worth doing" heading. Hidden when there are no gaps.
- Gap items may be strings or `{ title }` objects (see `renderResults` in
  app.js) — normalize to strings before sending.
- On click: POST current run's project dir + gaps.
  - Success → button disabled, label `✓ Added to TODO.md (n)` where n =
    written count (`(already there)` when written = 0).
  - Error → inline `.error-line` under the gaps list; button re-enabled.
- Works from history-loaded past runs too (project dir is stored with the run).
- Button state resets when a new result renders.

## Testing

- Mock run → click button → verify TODO.md created with section + items.
- Click again → verify dedup (written: 0, no duplicate lines).
- Invalid dir (deleted project) → inline error shown.

## Out of scope

Re-run failed dimensions, score history sparkline, open-in-editor, PDF export,
per-gap selection, GitHub/Jira targets.
