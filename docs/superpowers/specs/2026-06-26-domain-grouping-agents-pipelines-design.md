# Domain grouping for agents and pipelines

**Status:** design approved (2026-06-26), pending spec review
**Author:** brainstormed with Bulibas

## Problem

Maestro now hosts more than one kind of pipeline. The coding pipeline
(Plan → Refine → Implement → Review) ships built in; a marketing pipeline
(Brief → Research → Strategy → Copy + Art → Review) was added in the user layer,
and more domains are coming (financing, etc.).

Today there is **no domain-aware organization**. The Composer palette is one flat
list sorted by `order` and tinted by `color`; agents carry only `scope`
(`project` | `workspace-only`); workflows carry only `id` + `name`. As the agent
and workflow counts grow across unrelated domains, the palette and the workflow
picker become an undifferentiated pile. A user building a marketing campaign
should not have to scroll past `decomposer` and `manualWebUiTesting`.

## Goal

Add a lightweight, **organizational-only** domain tag to both agents and
workflows so the UI can group and filter by domain (coding, marketing,
financing, …), with a `shared` escape hatch for cross-cutting agents.

### Non-goals

- **No wiring enforcement.** Mixing domains in one pipeline stays legal. The
  existing channel-reachability validator (`validateWorkflow`) is the only
  correctness gate; domain does not constrain `connectsTo`, channels, or
  dispatch.
- **No pack/bundle primitive.** A first-class installable "domain pack" is
  explicitly deferred. The tag is the MVP; a pack could later just set the tag
  on its members.
- **No engine changes.** `orchestrator.mjs`, `channels.mjs`, `runners.mjs`,
  `phases.mjs`, and `workflow-validator.mjs` are untouched. This is a metadata +
  UI feature.

## Decisions (locked during brainstorming)

| Decision | Choice |
|----------|--------|
| Primitive shape | Lightweight open-vocab `domain` **string** on agent meta + workflow |
| Semantics | **Organizational only** — palette sections + workflow filter; no enforcement |
| Cross-cutting agents | Reserved value **`shared`** — surfaces in every domain section |
| Default for untagged | **`general`** — its own visible bucket (fail-safe visible) |
| Shared placement | **Injected into every domain section** (top), not a separate section |

## Design

### 1. Data model

#### Agent meta sidecar — new optional `domain` field

```jsonc
{
  "key": "copywriter",
  "domain": "marketing",
  "...": "..."
}
```

Normalized in `agent-registry.mjs#normalizeMeta`, mirroring the fail-safe style
already used for `color` and `scope`:

- Validation regex: `^[a-z][a-z0-9-]{0,31}$` (lowercase kebab, ≤32 chars). A new
  `DOMAIN_RE` constant.
- Absent or malformed → `"general"` (fail-safe **visible**, never hidden).
- `"shared"` is a recognized sentinel (passes the regex; treated specially by the
  palette grouping, not by normalization).
- Stored verbatim in the sidecar; no computed sub-fields.

The normalized `AgentMeta` gains `domain: string` (always set, default
`"general"`).

#### Workflow template — new `domain` field + DB column

- `workflows` table gains a nullable `domain TEXT` column.
- `DEFAULT_WORKFLOW.domain = "coding"` (the built-in coding flow).
- `writeWorkflow(tpl)` accepts `tpl.domain`; persists `domain` (default
  `"general"` when absent/blank/malformed — same `DOMAIN_RE` guard).
- `rowToTpl` returns `domain` (COALESCE NULL → `"general"` so pre-migration rows
  read back as `general`).
- `readWorkflow` / `listWorkflows` carry `domain` through.

### 2. Registry helpers + data migration

- `normalizeMeta` adds `domain` (as above).
- New exported helper `collectDomains(registry)` → ordered unique domain list,
  used by the UI for section headers. Ordering rule: domains appear in
  first-seen registry order (registry is already sorted by `.order`), with
  `general` pinned **last** and `shared` excluded from the header list (it is
  injected into each section, not a section itself).
- **Built-in backfill (in-repo, additive):** add `"domain": "coding"` to the 11
  built-in coding/workspace agent metas in `agents/*.meta.json`.
- **User backfill:** add `"domain": "marketing"` to the 6 marketing agent metas
  in `~/.maestro/agents/*.meta.json` (`briefBuilder`, `marketResearcher`,
  `contentStrategist`, `copywriter`, `artDirector`, `contentReviewer`).
- **DB migration:** bump `SCHEMA_VERSION` 8 → **9** in `src/core/db.mjs` and
  append a stepwise `SCHEMA_V9` migration:

  ```sql
  ALTER TABLE workflows ADD COLUMN domain TEXT;
  ```

  Existing rows get `NULL`, read back as `general` via the `rowToTpl` COALESCE.
  No data UPDATE needed.

  > **Schema-version coordination risk.** Maestro is checked out in more than one
  > working tree. A stale memory recorded both checkouts claiming db v5 with
  > divergent DDL, causing silent failures. This checkout is at v8. The v9 step
  > MUST be the next sequential version in whichever checkout ships first; the
  > other checkout must rebase onto it rather than independently minting a
  > conflicting v9. Call this out in the implementation plan and verify
  > `SCHEMA_VERSION` is 8 immediately before bumping.

### 3. API + UI

- **`GET /api/agents`** (`ui/server.mjs:1684`): include `domain` in each
  serialized agent. Since the handler serializes the registry meta, this is
  additive once `normalizeMeta` sets the field. Verify the serializer does not
  whitelist fields in a way that drops `domain`.
- **Palette** (`ui/public/composer-core.mjs`):
  - `mergePalette` currently maps a fixed field set and drops everything else —
    add `domain: a.domain || 'general'` to the mapped object so it survives.
  - New pure helper `groupPaletteByDomain(palette, domains)` → ordered
    `[{ domain, agents: [...] }]`, where each group is the domain's own agents
    **plus** every `shared` agent prepended, each group sorted by `order`.
  - The composer render consumes the grouped structure: collapsible section per
    domain (header label = domain, tinted with an existing color token), and a
    row of domain **filter chips** to toggle section visibility. No modal
    "active domain" state — all sections render; chips collapse.
- **Workflow picker** (New Pipeline / workflow list view in `ui/public`):
  - Show a **domain badge** per workflow.
  - A domain filter to scope the list (coding / marketing / financing / general).
  - On save, set the workflow's `domain` via a dropdown, **default
    auto-suggested** from the dominant domain among its member agents (the most
    frequent non-`shared` domain), falling back to `general`.

### 4. Error handling & edge cases

- Malformed/absent `domain` → `general` (never an error, never hidden).
- A workflow whose agents span multiple domains: legal (organizational only).
  The save dropdown suggests the dominant domain; the user may override.
- A `shared` agent: appears at the top of every domain section; never forms its
  own header.
- Pre-migration workflows: read back as `general` with zero data loss.
- Empty registry / `/api/agents` failure: palette falls back to
  `EMBEDDED_AGENTS` (existing behavior); those default to `general`.

### 5. Testing

| Area | Test |
|------|------|
| `agent-registry` | `domain` normalization: default `general`, sentinel `shared`, malformed → `general`, valid kebab passes |
| `collectDomains` | ordered unique; `general` pinned last; `shared` excluded from headers |
| `workflows` store | `domain` round-trips; `DEFAULT_WORKFLOW.domain === "coding"`; pre-migration row reads `general` |
| DB migration | fresh DB reaches v9; v8 DB upgrades; `workflows.domain` column exists; existing rows backfill `general` |
| `composer-core` | `mergePalette` carries `domain`; `groupPaletteByDomain` injects `shared` into every section and preserves `order` |
| Regression guard | `MAESTRO_MOCK=1 npm run smoke` stays green — proves engine/dispatch/validator unchanged |

## Files touched

- `src/core/agent-registry.mjs` — `DOMAIN_RE`, `normalizeMeta` domain, `collectDomains`
- `src/core/workflows.mjs` — `domain` on template/`writeWorkflow`/`rowToTpl`/read/list; `DEFAULT_WORKFLOW.domain`
- `src/core/db.mjs` — `SCHEMA_VERSION` 8→9, `SCHEMA_V9` ALTER
- `agents/*.meta.json` — `"domain": "coding"` on the 11 built-ins
- `~/.maestro/agents/*.meta.json` — `"domain": "marketing"` on the 6 marketing agents (out-of-repo; a setup step, not a repo change)
- `ui/server.mjs` — `domain` in `/api/agents` response
- `ui/public/composer-core.mjs` — `mergePalette` domain, `groupPaletteByDomain`
- `ui/public/*` — palette section render + filter chips; workflow picker badge/filter/save-dropdown
- `test/*` — the cases in §5

## Rollout

Pure additive metadata + UI. No breaking change: untagged everything reads as
`general` and renders exactly as today (one effective section). Ships safely
incrementally — schema migration first, then registry/store, then UI.
