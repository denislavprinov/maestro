# Pipeline Composer — mockups

Visual + behavioral source of truth for the Pipeline Composer feature.
Implementation agents: open these directly.

| File | What it shows |
|------|---------------|
| `01-composer-overview.png` | Full Composer view: 11-agent palette, dotted-grid canvas with sequential steps + a **parallel** group (Step 5), amber **feedback loops** with delete-X, legend, `Reset to default` / `Clear canvas` / `Save pipeline` toolbar, start of the Saved pipelines list. |
| `02-saved-and-readonly-preview.png` | Saved pipelines list (`Full Delivery Flow`, `Quick Fix`) with meta line "N steps · M agents · K feedback loops" + distinct-agent chips, and an expanded **read-only preview** (locked canvas) of the `Quick Fix` pipeline. |
| `maestro-standalone-mockup.html` | The standalone interactive mockup (HTML+CSS+JS, single file). **Behavioral** source of truth: drag/drop, `paintWires` SVG renderer, link mode, save/snapshot, read-only previews. The real HTML is JSON-string-escaped on one line — decode with `JSON.parse` of that line (or open in a browser) to read it. |

## Notes for implementation

- The palette in the mockup shows **11** agents. This feature ships **6 runnable**
  (Plan, Refine Plan, Implementation, Review Implementation, Manual Tests
  Checklist, Manual web UI testing). Build the palette from the agent registry,
  not a hardcoded list.
- The mockup's **default** pipeline is 8 steps. The product **default is the
  current 4-step** `Plan → Refine → Implement → Review` — "Reset to default"
  must draw that.
- Saved pipelines are **read-only previews** in the mockup. The product keeps them
  read-only but adds **run** (select from New Pipeline). No load-into-canvas edit.
- Match the mockup's look using the existing `ui/public/style.css` design tokens;
  port the canvas/wire logic into `ui/public/app.js` (vanilla JS, no framework).

See the design spec: `docs/superpowers/specs/2026-06-01-pipeline-composer-design.md`.
