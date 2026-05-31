# Named project registry + dropdown — design

**Date:** 2026-05-31
**Status:** Approved (brainstorming)

## Problem

The web UI requires the user to paste an absolute project path into a free-text
field (`#projectDir`) on every run. There is no memory of past projects. The user
wants to link a path to a name once, then pick that project from a dropdown on
later runs, and manage that list from the UI.

A true "browse with a file explorer" was considered and rejected: browser
security prevents client-side JavaScript from reading a real absolute filesystem
path from a file/folder picker. A real browser would have to be implemented
server-side. The user chose the simpler **dropdown + add-by-path** approach
instead.

## Decisions

1. **Picker UX:** saved-projects dropdown + an "Add project" form (name + paste
   path once). No filesystem browser, no native OS dialog.
2. **Storage:** a server-side JSON file at `~/.maestro/projects.json`, managed
   through new `/api/projects` endpoints. Durable across browser clears and
   shared across browsers hitting this server ("saved in the product").
3. **Management actions:** add, select, delete. No rename (delete + re-add to
   change a name).
4. **Non-existent paths are saveable**, flagged `exists: false` and shown with a
   subtle "(missing)" tag. This matches the existing `/api/run` behavior, which
   `mkdir`s a missing `projectDir`.

## Architecture

A pure core module owns the registry. The server exposes a thin REST surface
over it. The client replaces the path text input with a dropdown. The existing
run / install / history / stop endpoints are **unchanged** — they already accept
a `projectDir` string; the client now feeds them the selected project's path.

```
~/.maestro/projects.json  --  src/core/projects.mjs  --  /api/projects  --  <select> (app.js)
   [{name,path}]              list/add/remove/validate    GET/POST/DELETE     dropdown + Add + delete
```

## Components

### Core module — `src/core/projects.mjs` (new)

Follows the conventions of `src/core/artifacts.mjs` (JSDoc header, named exports,
`node:fs/promises`). The on-disk file is an array of `{ name, path }`.

- `projectsFile()` → absolute path to the registry file. Resolves to
  `<MAESTRO_HOME or os.homedir()>/.maestro/projects.json`. The `MAESTRO_HOME`
  environment override lets tests point at a tmpdir instead of the real home.
- `listProjects()` → `Promise<Array<{name, path, exists}>>`. Reads and parses the
  file. A missing file or unparseable JSON yields `[]` — reads never throw.
  `exists` is computed per entry via `fs.existsSync` + directory check at read
  time (it is not persisted).
- `addProject({name, path})` → validates, appends, writes, returns the updated
  list. Throws a descriptive `Error` on invalid input or duplicate name.
- `removeProject(name)` → drops the entry whose name matches (case-insensitive),
  writes, returns the updated list. Removing an absent name is a no-op (returns
  the unchanged list).
- Path normalization reuses the server's existing logic: expand a leading `~` to
  the home dir, then `path.resolve`. This logic is centralized so the server and
  the core agree.
- Writes are atomic-ish: write to a temp file in the same directory, then
  `rename` over the target. The `~/.maestro` directory is created on first write.

**Validation rules (in `addProject`):**

- `name`: trimmed, non-empty; unique case-insensitively against existing names →
  otherwise throw.
- `path`: trimmed, non-empty; normalized as above.
- If the normalized path exists and is **not** a directory (e.g. a file) → throw
  "not a directory".
- A normalized path that does **not** exist is accepted (the run will create it).

### Server — `ui/server.mjs`

Three new JSON endpoints, placed alongside the existing `/api/*` handlers and
delegating to the core module:

- `GET /api/projects` → `{ projects: [{name, path, exists}] }`.
- `POST /api/projects` with body `{ name, path }` → adds; `400` with
  `{ error }` on duplicate/invalid; on success → `{ projects }`.
- `DELETE /api/projects?name=<encoded>` → removes; → `{ projects }`. A query
  param (not a path segment) avoids route-encoding pitfalls when a name contains
  `/` or other URL-reserved characters.

The existing `resolveProjectDir` helper is refactored to delegate to (or share)
the core module's path-normalization function so there is a single source of
truth.

### Client — `ui/public/index.html` + `ui/public/app.js`

Replace the always-visible `#projectDir` text input with a project selector:

- `<select id="projectSelect">`: one `<option>` per project (visible text =
  `name`, value = `path`), plus a trailing **"+ Add project…"** entry.
- **Add** inline mini-form (name input + path input + Save), hidden until
  "+ Add project…" is chosen. On Save → `POST /api/projects` → refresh the
  select → auto-select the new project. Validation errors are shown inline.
- **Delete**: a small control (✕) next to the selected project → confirm →
  `DELETE /api/projects?name=<encoded>` → refresh. If the deleted project was
  active, clear the selection and history.
- On select change → set `state.projectDir` to the option's value (path) and call
  `loadHistory()`.
- The last-selected project **name** is remembered in
  `localStorage['maestro.lastProject']` and auto-restored on boot.
- Empty registry → the select shows only "+ Add project…", a hint is displayed,
  and **Start is disabled** until a project is selected. The Install button
  likewise requires a selected project.

All references to `el.projectDir.value` in `app.js` (run submit, install, history
load, change handler) are updated to read the selected path from the dropdown.

## Data flow

- **Boot:** `GET /api/projects` → populate `<select>` → restore last selection
  from localStorage → `loadHistory(path)`.
- **Add:** open form → Save → `POST /api/projects` → refresh select →
  auto-select new → `loadHistory`.
- **Run:** `POST /api/run` with the selected path (server run path unchanged).
- **Delete:** confirm → `DELETE /api/projects?name=<encoded>` → refresh; clear selection
  and history if the active project was removed.

## Error handling / edge cases

- Duplicate name (case-insensitive) → `400 "a project named X already exists"`.
- Empty name or path → `400`.
- Path that exists but is a file → `400 "path is not a directory"`.
- Non-existent path → accepted; entry flagged `exists: false`; UI shows a subtle
  "(missing)" tag; run still creates the folder.
- Corrupt or missing `projects.json` → treated as an empty list; never throws on
  read.
- Concurrent writes (single local user) → last-write-wins via temp-file +
  rename; acceptable for this single-user local tool.

## Testing

`test/projects.test.mjs` (node:test, tmpdir, `assert/strict`), pointing
`MAESTRO_HOME` at a fresh tmpdir so the real home is never touched:

- `addProject` then `listProjects` returns the entry.
- Duplicate name (including different case) is rejected.
- `removeProject` drops the entry; removing an absent name is a no-op.
- A path that is a file is rejected.
- Missing file → `[]`; corrupt JSON → `[]`.
- Leading `~` in a path is expanded.

Existing `npm test` and `npm run smoke` must stay green.

## Out of scope (YAGNI)

- Rename (delete + re-add instead).
- Filesystem browser / native OS folder dialog.
- In-place path editing.
- Per-project settings beyond `{name, path}`.
- Authentication / multi-user concerns.
