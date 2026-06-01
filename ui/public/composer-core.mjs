// ui/public/composer-core.mjs
// Framework-free, DOM-free helpers for the Pipeline Composer. Imported by
// ui/public/app.js (browser, type="module") AND by test/composer-ui.test.mjs
// (node:test, no jsdom). KEEP THIS FILE FREE OF document/window references so it
// stays unit-testable in isolation — DOM wiring lives in app.js.

// ---------------------------------------------------------------------------
// topology(steps, feedbacks) -> WorkflowTemplate {steps,feedbacks} body.
// Canvas model uses throwaway local ids (n1, n7…). The persisted contract uses
// stable instance ids "s{stepIndex}_{memberIndex}" (e.g. "s0_0"); feedback
// from/to reference those instance ids. We rebuild the id map and remap edges,
// dropping any edge whose endpoint is gone (defensive; the UI prunes these too).
// ---------------------------------------------------------------------------
export function topology(steps, feedbacks) {
  const idMap = {}; // localId -> "sI_J"
  const outSteps = steps.map((col, i) =>
    col.map((node, j) => {
      const id = `s${i}_${j}`;
      idMap[node.id] = id;
      return { id, key: node.key };
    }),
  );
  const outFeedbacks = [];
  (feedbacks || []).forEach((fb) => {
    const from = idMap[fb.from];
    const to = idMap[fb.to];
    if (from && to) outFeedbacks.push({ id: `fb_${outFeedbacks.length}`, from, to });
  });
  return { steps: outSteps, feedbacks: outFeedbacks };
}

// Filled in by later tasks (each gated by its own failing test).
export function metaLine() { return ''; }
export function distinctAgents() { return []; }
export function defaultTopologyFromTemplate() { return { steps: [], feedbacks: [] }; }
export function mergePalette() { return []; }
export const EMBEDDED_AGENTS = {};
