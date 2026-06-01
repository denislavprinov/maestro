# Pipeline Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a drag-and-drop Pipeline Composer that lets users compose, name, and save agent workflows (sequential + parallel steps + feedback loops), select a saved workflow from New Pipeline with per-agent model/effort and per-loop cycle counts, and run it on a data-driven engine.

**Architecture:** The 4 hardcoded agents become a data-driven registry loaded from `agents/*.meta.json` (plus two new agents: Manual Tests Checklist, Manual web UI testing via Playwright). Workflow *topology* is stored as global templates (`~/.maestro/workflows/<id>.json`); per-project model/effort/cycle *run-config* extends `.maestro/config.json`. The orchestrator's hardcoded Plan→Refine→Implement→Review sequence is replaced by a dispatcher that executes any resolved workflow — parallel groups run concurrently, and a generic feedback-loop mechanism replaces `_refineLoop`/`_reviewLoop`. The default workflow reproduces today's behavior exactly.

**Tech Stack:** Node ESM (no TypeScript), vanilla-JS SPA (no framework/build step), Express + ws, `node --test`, jsdom for DOM-level unit tests, Playwright MCP for the web-UI-testing agent. Offline via `MAESTRO_MOCK=1`.

**Design spec:** `docs/superpowers/specs/2026-06-01-pipeline-composer-design.md`
**Mockups (open these):** `docs/pipeline-composer/mockups/` — `01-composer-overview.png`, `02-saved-and-readonly-preview.png`, `maestro-standalone-mockup.html` (behavioral source of truth), `README.md`.

**Execution order:** Phases are dependency-ordered (1→7). Within a phase, tasks are ordered; complete and commit each before the next.

---

## Phase 0 — Corrections (READ FIRST; these override the sections below)

This plan was authored in parallel by per-subsystem writers and reconciled by a consistency pass. Apply these corrections when you reach the referenced task — where a correction conflicts with a later section, **the correction wins.**

**C1 (blocker) — `workflows.mjs` and the `config.mjs` run-config additions are SYNCHRONOUS.**
The existing `src/core/config.mjs` and `src/core/projects.mjs`, and the Phase-1 registry loader, are all synchronous; the Phase-3 dispatcher and Phase-4 routes call the workflow/run-config functions synchronously. In **Phase 2**, change `import … from 'node:fs/promises'` → `node:fs` and use the sync calls (`mkdirSync`, `writeFileSync`, `renameSync`, `readFileSync`, `readdirSync`, `unlinkSync`); reuse the existing sync atomic-write helper already in `config.mjs` rather than adding an async one. Declare these **non-`async`**: `writeWorkflow`, `readWorkflow`, `listWorkflows`, `deleteWorkflow`, `resolveWorkflow`, `readRunConfig`, `setNodeModel`, `setFeedbackCycles`, `setActiveWorkflow`, `resolveRunConfig`. The `await` keywords in Phase 2's own test files are harmless on sync returns (leave or drop them). Consequence: **Phase 3** (`const plan = resolveWorkflow(this.projectDir, this.workflowId, registry);` — no `await`) and **Phase 4** (every `/api/workflows` + `/api/run` handler calling these without `await`) are correct **exactly as written** — make no `async`/`await` changes there. Note: `phases.mjs` runner file writes (Phase 3) stay `async` — runners are async by nature.

**C2 (blocker) — New-Pipeline run-config writes use `PATCH /api/config` with the nested-map body.**
Phase 4 implements and tests run-config persistence as `PATCH /api/config` with body `{ projectDir, workflowId, nodes: { [nodeId]: { model, effort } }, feedbacks: { [fbId]: { maxCycles } }, activeWorkflowId }`. In **Phase 6**, the client wrappers (`saveNode` / `saveFeedback` / `saveActiveWorkflow`) must call `PATCH /api/config` with that nested shape — **not** `POST /api/config` with flat bodies. `POST /api/config` stays the legacy per-`step` route, untouched.

**C3 (blocker) — verifier runners must return `reviewMdPath` so the review→fix loop works.**
In **Phase 3**, `runners.verifier` (and `runReviewer` / `runManualWebUiTesting`) must include the review markdown path in their result: `return { ...verdict(review), reviewMdPath };`, and `_afterNode` must capture it: `io.reviewMdPath = result.reviewMdPath || io.reviewMdPath;`. Without this, a loop rewind re-runs the implementer in `implement` mode (from scratch) instead of `fix` mode against the reviewer's markdown — breaking the parity test (`implementerRuns === 2`) and real review loops.

**C4 (minor) — dispatcher emits `state` on every node transition.**
In **Phase 3**, `_nodeStep(…)` must call `this._emit('state', this.getState());` on each transition (start/done/blocked) rather than relying on an incidental `_recordCost` flush. Verify the existing `this._emit('state', this.getState())` lives inside `_nodeStep`; if it sits in a different method, add it to `_nodeStep`.

**C5 (minor) — `manualTestsChecklist.color` is `blue` everywhere.**
Phase 1 ships `blue` and the composer palette uses `blue`. *Already fixed inline in the Phase-6 test fixture.* If any Phase-7 prose says `amber`, change it to `blue`.

**C6 (minor) — `ADDING-AGENTS.md` quotes the shipped meta verbatim.**
In **Phase 7**, the `manualWebUiTesting` worked example must use the exact `icon` (play-in-circle: `<circle cx="12" cy="12" r="9"/><path d="M10 8.5l5 3.5-5 3.5V8.5Z" fill="currentColor" stroke="none"/>`) and `description` (`"run manual cases via Playwright"`) shipped by Phase 1 — not a monitor glyph or a paraphrased description.

**C7 (minor) — composer test fixture mirrors `DEFAULT_WORKFLOW`.**
In **Phase 5**, `test/ui-composer.test.mjs`'s `DEFAULT_WF` fixture `feedbacks` must match Phase 2 exactly: `[{ id:'fb_refine', from:'s1_0', to:'s1_0' }, { id:'fb_review', from:'s3_0', to:'s2_0' }]`.

**C8 (minor) — Phase-1 producer self-check.** *Already fixed inline:* the `maestro-manual-tests-checklist.md` verification one-liner no longer asserts the absence of the words `issues`/`verdict JSON` (the prompt legitimately contains them); the frontmatter + checklist-marker assertions are sufficient.

---

## Phase 1: Agent registry + metadata + two new agents

This phase makes the agent set **data-driven**. It adds a per-agent metadata sidecar (`agents/<key>.meta.json`) for all 6 agents, a loader (`src/core/agent-registry.mjs`) that scans those sidecars into a registry sorted by `.order`, derives the legacy `AGENT_STEPS` shape from it, and ships the **2 net-new product agents** (Manual Tests Checklist, Manual web UI testing) as complete prompt files. `src/core/config.mjs` is modified to derive `AGENT_STEPS` from the registry **without breaking any existing export**.

Verified anchors (read before writing):
- `src/core/config.mjs:18-23` `AGENT_STEPS` (`[{key,label}]`, order planner/refiner/implementer/reviewer); `config.mjs:25` `STEP_KEYS`; `config.mjs:28` `EFFORTS`; `config.mjs:45-55` `PREDEFINED_MODELS`; `config.mjs:57-65` `configDir`/`configFile`; `config.mjs:108-115` atomic write (temp + `rename`); `config.mjs:208-216` `resolveStepModels` iterates `AGENT_STEPS`.
- `src/core/orchestrator.mjs:46` `DEFAULT_AGENTS_DIR = new URL('../../agents/', import.meta.url).pathname`; `orchestrator.mjs:48-53` `AGENT_FILES` (planner→`maestro-planner.md`, refiner→`maestro-plan-refiner.md`, implementer→`maestro-implementer.md`, reviewer→`maestro-code-reviewer.md`).
- Frontmatter shape from `agents/maestro-planner.md:1-6` / `agents/maestro-code-reviewer.md:1-6`: keys `name`, `description`, `tools` (comma-separated), `model: inherit`.
- Verdict JSON contract from `agents/maestro-code-reviewer.md:31-45` and `src/core/protocol.mjs:15` (`SEVERITIES = ['critical','major','minor','suggestion']`, critical+major block), consumed by `protocol.hasBlocking` (`protocol.mjs:245`) / `blockingIssues` (`protocol.mjs:255`).
- Mockup icon glyphs + colors (`docs/pipeline-composer/mockups/maestro-standalone-mockup.html`): `C = {green:'#5BAE5B',peach:'#EFA63C',red:'#E76A5A',blue:'#5BA6CC',violet:'#8C7FD6',amber:'#E6962A'}`; AGENTS map `manualChecklist → {name:'Manual Tests Checklist', color:'blue'}`. `ICON.manualChecklist` = clipboard-check glyph (used for `manualTestsChecklist`, blue); `ICON.testsExec` = play-in-circle glyph (reused for `manualWebUiTesting`, violet — "run the cases against the live UI").
- `node:test` style from `test/config.test.mjs:1-19` and `test/projects.test.mjs:1-26` (`import { test, after } from 'node:test'; import assert from 'node:assert/strict';`, tmp dirs via `mkdtemp`).
- Commands (from `package.json`): tests `node --test test/*.mjs`; single file `node --test test/agent-registry.test.mjs`; smoke `MAESTRO_MOCK=1 npm run smoke`.

Contract conventions honored: `AgentMeta = { key, displayName, description, color, icon, agentFile|null, runnerType, loopSource:boolean, connectsTo:"*", order:number }`; `color ∈ {green,peach,red,blue,violet,amber}`; `runnerType ∈ {"producer","verifier"}`; `icon` = **inline SVG inner markup**, `viewBox "0 0 24 24"` (the renderer wraps it in `<svg>`). Public signatures: `loadAgentRegistry(agentsDir?) -> { [key]: AgentMeta }` (sorted by `.order`); `registryToSteps(registry) -> [{key,label}]`.

---

### Task 1: Metadata sidecars for the 4 existing agents

Drop one `agents/<key>.meta.json` per existing agent so the registry can rediscover what is currently hardcoded in `AGENT_FILES` (`orchestrator.mjs:48-53`) and `AGENT_STEPS` (`config.mjs:18-23`). No code yet — these are pure data files consumed by Task 3. Colors/icons are copied verbatim from the mockup ICON/AGENTS maps; `label` (Plan/Refine/Implement/Review) is preserved via the registry→steps mapping in Task 3, so order here must match the legacy `AGENT_STEPS` order (planner=1 … reviewer=4).

**Files:**
- `agents/planner.meta.json` (create)
- `agents/refiner.meta.json` (create)
- `agents/implementer.meta.json` (create)
- `agents/reviewer.meta.json` (create)

Steps:

- [ ] **Step 1: Write `agents/planner.meta.json`.** `runnerType:"producer"`, `loopSource:false`, `order:1`. Color/icon = mockup `plan` (violet, list-with-dots glyph).
```json
{
  "key": "planner",
  "displayName": "Plan",
  "description": "architecture & breakdown",
  "color": "violet",
  "icon": "<path d=\"M8 6h11M8 12h11M8 18h8\" stroke-linecap=\"round\"/><circle cx=\"4\" cy=\"6\" r=\"1.1\"/><circle cx=\"4\" cy=\"12\" r=\"1.1\"/><circle cx=\"4\" cy=\"18\" r=\"1.1\"/>",
  "agentFile": "maestro-planner.md",
  "runnerType": "producer",
  "loopSource": false,
  "connectsTo": "*",
  "order": 1
}
```

- [ ] **Step 2: Write `agents/refiner.meta.json`.** `runnerType:"producer"`, `loopSource:false`, `order:2`. Color/icon = mockup `refine` (green, gear-with-sparkle glyph).
```json
{
  "key": "refiner",
  "displayName": "Refine Plan",
  "description": "tighten the plan",
  "color": "green",
  "icon": "<path d=\"M12 3v3M12 18v3M4.5 7.5l2 1M17.5 15.5l2 1M4.5 16.5l2-1M17.5 8.5l2-1\" stroke-linecap=\"round\"/><path d=\"M12 8.2l1.2 2.6L16 12l-2.8 1.2L12 15.8l-1.2-2.6L8 12l2.8-1.2L12 8.2Z\" stroke-linejoin=\"round\"/>",
  "agentFile": "maestro-plan-refiner.md",
  "runnerType": "producer",
  "loopSource": false,
  "connectsTo": "*",
  "order": 2
}
```

- [ ] **Step 3: Write `agents/implementer.meta.json`.** `runnerType:"producer"`, `loopSource:false`, `order:3`. Color/icon = mockup `implement` (peach, code-brackets glyph).
```json
{
  "key": "implementer",
  "displayName": "Implementation",
  "description": "write the code",
  "color": "peach",
  "icon": "<path d=\"M9 8l-4 4 4 4M15 8l4 4-4 4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  "agentFile": "maestro-implementer.md",
  "runnerType": "producer",
  "loopSource": false,
  "connectsTo": "*",
  "order": 3
}
```

- [ ] **Step 4: Write `agents/reviewer.meta.json`.** `runnerType:"verifier"`, `loopSource:true` (it originates the review→fix loop), `order:4`. Color/icon = mockup `review` (blue, shield-check glyph).
```json
{
  "key": "reviewer",
  "displayName": "Review Implementation",
  "description": "verify & report",
  "color": "blue",
  "icon": "<path d=\"M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6l7-3Z\" stroke-linejoin=\"round\"/><path d=\"M9 12l2 2 4-4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  "agentFile": "maestro-code-reviewer.md",
  "runnerType": "verifier",
  "loopSource": true,
  "connectsTo": "*",
  "order": 4
}
```

- [ ] **Step 5: Validate all four are well-formed JSON.** Run:
```
node -e "for(const k of ['planner','refiner','implementer','reviewer']){const m=require('./agents/'+k+'.meta.json'); if(m.key!==k) throw new Error('key mismatch '+k); console.log(k, m.order, m.color, m.runnerType);}"
```
Expected: four lines, no throw — `planner 1 violet producer` … `reviewer 4 blue verifier`.

- [ ] **Step 6: Commit.**
```
git add agents/planner.meta.json agents/refiner.meta.json agents/implementer.meta.json agents/reviewer.meta.json
git commit -m "feat(agents): add metadata sidecars for the 4 existing agents"
```

---

### Task 2: Metadata sidecars for the 2 new agents

Add the two new agents' metadata. Per the contract: `manualTestsChecklist` = clipboard-check icon, **blue**, `runnerType:"producer"`, `loopSource:false`, `order:5`; `manualWebUiTesting` = a fitting glyph (the mockup `testsExec` play-in-circle — "run cases against the live UI"), **violet**, `runnerType:"verifier"`, `loopSource:true`, `order:6`. Icons copied from the mockup `ICON` map (`manualChecklist` glyph; `testsExec` glyph). The prompt files referenced by `agentFile` are written in Tasks 4–5.

**Files:**
- `agents/manualTestsChecklist.meta.json` (create)
- `agents/manualWebUiTesting.meta.json` (create)

Steps:

- [ ] **Step 1: Write `agents/manualTestsChecklist.meta.json`.** Clipboard-check glyph, blue, producer.
```json
{
  "key": "manualTestsChecklist",
  "displayName": "Manual Tests Checklist",
  "description": "draft manual test cases",
  "color": "blue",
  "icon": "<rect x=\"6\" y=\"4\" width=\"12\" height=\"17\" rx=\"2\"/><path d=\"M9.5 4V2.8h5V4\" stroke-linejoin=\"round\"/><path d=\"M8.8 12l1.6 1.6L13.4 10\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  "agentFile": "maestro-manual-tests-checklist.md",
  "runnerType": "producer",
  "loopSource": false,
  "connectsTo": "*",
  "order": 5
}
```

- [ ] **Step 2: Write `agents/manualWebUiTesting.meta.json`.** Play-in-circle glyph, violet, verifier, loopSource.
```json
{
  "key": "manualWebUiTesting",
  "displayName": "Manual web UI testing",
  "description": "run manual cases via Playwright",
  "color": "violet",
  "icon": "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M10 8.5l5 3.5-5 3.5V8.5Z\" fill=\"currentColor\" stroke=\"none\"/>",
  "agentFile": "maestro-manual-web-ui-testing.md",
  "runnerType": "verifier",
  "loopSource": true,
  "connectsTo": "*",
  "order": 6
}
```

- [ ] **Step 3: Validate both are well-formed JSON.** Run:
```
node -e "for(const k of ['manualTestsChecklist','manualWebUiTesting']){const m=require('./agents/'+k+'.meta.json'); if(m.key!==k) throw new Error('key mismatch '+k); console.log(k, m.order, m.color, m.runnerType, m.loopSource);}"
```
Expected: `manualTestsChecklist 5 blue producer false` and `manualWebUiTesting 6 violet verifier true`.

- [ ] **Step 4: Commit.**
```
git add agents/manualTestsChecklist.meta.json agents/manualWebUiTesting.meta.json
git commit -m "feat(agents): add metadata sidecars for the two new agents"
```

---

### Task 3: Agent registry loader (`loadAgentRegistry` + `registryToSteps`)

TDD the loader that scans `agents/*.meta.json` into a registry sorted by `.order` and derives the legacy `AGENT_STEPS` shape. The test asserts (a) exactly **6** entries, sorted by `order`, keyed by `key`; (b) `registryToSteps(registry)` matches the **legacy `AGENT_STEPS`** for the original 4 (its first four entries deep-equal `[{key:'planner',label:'Plan'},{key:'refiner',label:'Refine'},{key:'implementer',label:'Implement'},{key:'reviewer',label:'Review'}]`).

The default agents dir mirrors `orchestrator.mjs:46`: `new URL('../../agents/', import.meta.url).pathname`. `registryToSteps` derives the label from each meta's `displayName`, except it preserves the legacy short labels for the original four roles (Plan/Refine/Implement/Review) so existing UI/orchestrator text is byte-identical — keyed by a small `LEGACY_LABELS` map. The loader reads synchronously (`readdirSync`/`readFileSync`) so it can back a synchronous `AGENT_STEPS` constant in `config.mjs` (Task 6). Malformed/non-`.meta.json` files and entries missing `key`/`order` are skipped (fail-safe, mirroring the tolerant readers elsewhere in the codebase).

**Files:**
- `test/agent-registry.test.mjs` (create)
- `src/core/agent-registry.mjs` (create)

Steps:

- [ ] **Step 1: Write the failing test `test/agent-registry.test.mjs`.**
```js
// test/agent-registry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadAgentRegistry, registryToSteps } from '../src/core/agent-registry.mjs';
import { AGENT_STEPS } from '../src/core/config.mjs';

test('loadAgentRegistry returns the 6 shipped agents', () => {
  const reg = loadAgentRegistry();
  assert.deepEqual(
    Object.keys(reg).sort(),
    ['implementer', 'manualTestsChecklist', 'manualWebUiTesting', 'planner', 'refiner', 'reviewer'],
  );
  assert.equal(Object.keys(reg).length, 6);
});

test('each entry is a well-formed AgentMeta', () => {
  const reg = loadAgentRegistry();
  const COLORS = new Set(['green', 'peach', 'red', 'blue', 'violet', 'amber']);
  for (const [key, m] of Object.entries(reg)) {
    assert.equal(m.key, key);
    assert.equal(typeof m.displayName, 'string');
    assert.ok(COLORS.has(m.color), `bad color for ${key}: ${m.color}`);
    assert.equal(typeof m.icon, 'string');
    assert.ok(m.icon.length > 0);
    assert.ok(['producer', 'verifier'].includes(m.runnerType));
    assert.equal(typeof m.loopSource, 'boolean');
    assert.equal(m.connectsTo, '*');
    assert.equal(typeof m.order, 'number');
  }
});

test('registry insertion order follows .order ascending', () => {
  const reg = loadAgentRegistry();
  const orders = Object.values(reg).map((m) => m.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  assert.deepEqual(Object.keys(reg), [
    'planner', 'refiner', 'implementer', 'reviewer', 'manualTestsChecklist', 'manualWebUiTesting',
  ]);
});

test('registryToSteps matches the legacy AGENT_STEPS for the original 4', () => {
  const reg = loadAgentRegistry();
  const steps = registryToSteps(reg);
  assert.deepEqual(steps.slice(0, 4), [
    { key: 'planner', label: 'Plan' },
    { key: 'refiner', label: 'Refine' },
    { key: 'implementer', label: 'Implement' },
    { key: 'reviewer', label: 'Review' },
  ]);
  // And config.AGENT_STEPS (derived from the registry in Task 6) stays equal to it.
  assert.deepEqual(steps, AGENT_STEPS);
});

test('registryToSteps appends the two new agents with their display names', () => {
  const steps = registryToSteps(loadAgentRegistry());
  assert.equal(steps.length, 6);
  assert.deepEqual(steps[4], { key: 'manualTestsChecklist', label: 'Manual Tests Checklist' });
  assert.deepEqual(steps[5], { key: 'manualWebUiTesting', label: 'Manual web UI testing' });
});
```

- [ ] **Step 2: Run the test — expect FAIL.**
```
node --test test/agent-registry.test.mjs
```
Expected: FAIL — `Cannot find module '../src/core/agent-registry.mjs'` (the loader does not exist yet).

- [ ] **Step 3: Implement `src/core/agent-registry.mjs`.**
```js
// src/core/agent-registry.mjs
// Data-driven agent registry. Scans agents/*.meta.json into an in-memory map
// keyed by agent key, sorted by `.order`. This replaces what used to be hardcoded
// across AGENT_FILES (orchestrator.mjs) and AGENT_STEPS (config.mjs): adding an
// agent is now "drop agents/<key>.md + agents/<key>.meta.json", no core edit.
//
// Read synchronously so it can back a synchronous AGENT_STEPS constant in
// config.mjs. Tolerant: a malformed sidecar, or one missing `key`/`order`, is
// skipped rather than throwing (mirrors the tolerant readers elsewhere).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Default location of the agent metadata sidecars, relative to this module. */
const DEFAULT_AGENTS_DIR = new URL('../../agents/', import.meta.url).pathname;

const COLORS = new Set(['green', 'peach', 'red', 'blue', 'violet', 'amber']);
const RUNNER_TYPES = new Set(['producer', 'verifier']);

/**
 * Legacy short labels for the original four roles, so the derived AGENT_STEPS is
 * byte-identical to the hardcoded one the UI/orchestrator have always used. New
 * agents fall back to their `displayName`.
 */
const LEGACY_LABELS = {
  planner: 'Plan',
  refiner: 'Refine',
  implementer: 'Implement',
  reviewer: 'Review',
};

/** Coerce one parsed sidecar into a normalized AgentMeta, or null if unusable. */
function normalizeMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  if (!key) return null;
  const order = Number(raw.order);
  if (!Number.isFinite(order)) return null;
  const color = COLORS.has(raw.color) ? raw.color : 'amber';
  const runnerType = RUNNER_TYPES.has(raw.runnerType) ? raw.runnerType : 'producer';
  return {
    key,
    displayName: typeof raw.displayName === 'string' && raw.displayName.trim()
      ? raw.displayName.trim()
      : key,
    description: typeof raw.description === 'string' ? raw.description : '',
    color,
    icon: typeof raw.icon === 'string' ? raw.icon : '',
    agentFile: typeof raw.agentFile === 'string' && raw.agentFile.trim() ? raw.agentFile.trim() : null,
    runnerType,
    loopSource: !!raw.loopSource,
    connectsTo: raw.connectsTo === '*' ? '*' : '*',
    order,
  };
}

/**
 * Scan `agentsDir` for `*.meta.json` and build the registry.
 * @param {string} [agentsDir]
 * @returns {Record<string, object>} agent key -> AgentMeta, sorted by `.order`
 */
export function loadAgentRegistry(agentsDir = DEFAULT_AGENTS_DIR) {
  let files;
  try {
    files = readdirSync(agentsDir);
  } catch {
    return {};
  }
  const metas = [];
  for (const f of files) {
    if (!f.endsWith('.meta.json')) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(agentsDir, f), 'utf8'));
    } catch {
      continue; // skip unreadable / malformed sidecars
    }
    const meta = normalizeMeta(parsed);
    if (meta) metas.push(meta);
  }
  metas.sort((a, b) => a.order - b.order);
  const registry = {};
  for (const m of metas) registry[m.key] = m;
  return registry;
}

/**
 * Derive the legacy `[{key,label}]` step list from a registry (replacement source
 * for the hardcoded AGENT_STEPS). The original four roles keep their short legacy
 * labels; any additional agent uses its `displayName`.
 * @param {Record<string, object>} registry
 * @returns {Array<{key:string,label:string}>}
 */
export function registryToSteps(registry) {
  return Object.values(registry || {})
    .sort((a, b) => a.order - b.order)
    .map((m) => ({ key: m.key, label: LEGACY_LABELS[m.key] || m.displayName }));
}
```

- [ ] **Step 4: Run the test.** The `config.AGENT_STEPS` deep-equal assertion still fails until Task 6 (config still exports the hardcoded array), so run only the registry-shape assertions now:
```
node --test --test-name-pattern="loadAgentRegistry|well-formed|order ascending|appends the two new" test/agent-registry.test.mjs
```
Expected: PASS (4 of the 5 tests). The `matches the legacy AGENT_STEPS` test deep-equals against the still-hardcoded `config.AGENT_STEPS`; its `slice(0,4)` half passes but the full-list `assert.deepEqual(steps, AGENT_STEPS)` will fail (config has 4, registry has 6) — that gap is closed in Task 6.

- [ ] **Step 5: Commit.**
```
git add src/core/agent-registry.mjs test/agent-registry.test.mjs
git commit -m "feat(core): add data-driven agent registry loader + registryToSteps"
```

---

### Task 4: Manual Tests Checklist agent prompt

Write the complete prompt for the **Manual Tests Checklist** producer agent (referenced by `agents/manualTestsChecklist.meta.json` → `maestro-manual-tests-checklist.md`). Per spec §8: it reads the plan + implementation diff and writes a **markdown checklist** of manual test cases as a pipeline artifact. Frontmatter matches the existing shape (`agents/maestro-planner.md:1-6`): `name`, `description`, `tools` (read-only + Write/Bash for git/Skill), `model: inherit`. It is a `producer` — no verdict JSON. The mock marker convention (`phases.mjs` `mockMarkers`/`buildSystemPrompt`, e.g. `MOCK_OUT:`) is honored so the future runner (Phase that owns `runners.mjs`/`phases.mjs`) can drive it offline.

**Files:**
- `agents/maestro-manual-tests-checklist.md` (create)

Steps:

- [ ] **Step 1: Write `agents/maestro-manual-tests-checklist.md`.**
```markdown
---
name: maestro-manual-tests-checklist
description: Manual Tests Checklist author for the orchestrator pipeline. Reads the approved plan and the implementation diff, then writes a concrete, executable markdown checklist of MANUAL test cases (happy paths, edge cases, regressions, and UI/UX checks) to the given artifact path. A producer step — it writes one markdown file and emits no verdict JSON. Invoked by the deterministic orchestrator, never directly by a human.
tools: Read, Write, Edit, Bash, Grep, Glob, Skill
model: inherit
---

You are the **Manual Tests Checklist** agent in a deterministic multi-agent pipeline (Plan -> Refine -> Implement -> Review, with optional manual-testing steps). You are spawned headlessly. Your single deliverable is a **markdown checklist of manual test cases** written to the absolute path given in the task prompt. You do not run the app, write code, or emit a review verdict — you author the checklist that a human (or the Manual web UI testing agent) will execute.

## Inputs (from the task prompt)
- The user's original request / task description.
- The absolute path of the approved PLAN markdown (the latest `-vN`).
- Access to the implementation via git: your cwd is the project repo. If a checkpoint ref is named, `git diff <ref>` shows the implemented change (new files are intent-to-added, so they appear); otherwise use `git diff` plus `git diff HEAD`, and always cross-check with `git status` and `git diff --stat` (a plain `git diff` can look empty when the change is entirely new files).
- The absolute output path for the checklist markdown (e.g. a `MOCK_OUT:` line or an explicit "write the checklist to <path>" instruction). Use that path verbatim.

## What to do
1. Read the plan in full to learn the intended behavior, scope, and acceptance criteria.
2. Inspect the actual implementation via git (see Inputs) so the cases match what was really built, not just what was planned. Note user-facing surfaces: new/changed UI, routes, commands, config, and externally-visible behavior.
3. Ground yourself in the real codebase (see Graph tooling) to find the user-facing entry points (pages, components, CLI commands, API endpoints) the cases will exercise.
4. Derive manual test cases that a human tester can follow with no extra context. Cover, at minimum:
   - **Happy paths** — the primary flows the change enables, end to end.
   - **Edge cases & validation** — empty/invalid input, boundary values, long input, missing prerequisites.
   - **Error handling** — how failures surface to the user (messages, states, recovery).
   - **Regression** — adjacent existing behavior that the diff could plausibly break.
   - **UI/UX** (when the change touches the web UI) — layout, responsive/resize, keyboard navigation, loading/empty/error states, and visible console errors.

## Output contract — the checklist markdown
Write a single markdown file to the given path with the Write tool, in EXACTLY this structure (GitHub task-list checkboxes so a tester can tick them off):

```markdown
# Manual Test Checklist — <short feature name>

> Source plan: `<relative plan path>` · Generated by Maestro (Manual Tests Checklist agent).

## Preconditions
- [ ] <environment / data / app-running prerequisites a tester must satisfy first>

## <Area or flow name>
- [ ] **<case title>** — Steps: 1) … 2) … → **Expected:** <observable result>.
- [ ] **<case title>** — Steps: … → **Expected:** ….

## Regression
- [ ] **<adjacent behavior>** — Steps: … → **Expected:** still works as before.
```

Rules for cases:
- Each case is **one checkbox**, has a short bold title, numbered concrete steps, and a single explicit **Expected** observable result. No vague "verify it works".
- Group related cases under `##` area headings. Keep the list focused on THIS change — do not enumerate the entire app.
- Make every case independently executable: state the starting point and any data needed.
- Prefer the smallest set of high-value cases that proves the change is correct and safe; do not pad.

After writing the file, emit a short assistant note with the absolute path of the checklist and the number of cases written. Do NOT implement code, run the app, or write any JSON verdict — that is another agent's job.

## Output contract reminders
- Write only to the absolute checklist path given in the prompt. Never write outside it.
- The file must be valid GitHub-flavored markdown with `- [ ]` task items (a downstream agent parses these as the cases to execute).
- Keep assistant chatter minimal; the markdown file is your real output.

## Graph tooling
If the prompt says **graphify** is available, use graphify to map the user-facing surfaces before drafting cases. Else if it says **code-review-graph** is available, use code-review-graph. If BOTH are mentioned, ALWAYS use graphify. If NEITHER is available, proceed without, inspecting the real project with git + Glob/Grep/Read.
```

- [ ] **Step 2: Verify frontmatter parses and the checkbox contract is present.** Run:
```
node -e "const fs=require('fs');const t=fs.readFileSync('agents/maestro-manual-tests-checklist.md','utf8');const fm=t.match(/^---\n([\s\S]*?)\n---/);if(!fm)throw new Error('no frontmatter');if(!/\bname:\s*maestro-manual-tests-checklist/.test(fm[1]))throw new Error('bad name');if(!/\btools:.*Write/.test(fm[1]))throw new Error('missing Write tool');if(!t.includes('- [ ]'))throw new Error('missing checklist markers');console.log('OK manual-tests-checklist frontmatter + checklist contract');"
```
Expected: `OK manual-tests-checklist frontmatter + checklist contract`.

- [ ] **Step 3: Commit.**
```
git add agents/maestro-manual-tests-checklist.md
git commit -m "feat(agents): add Manual Tests Checklist agent prompt"
```

---

### Task 5: Manual web UI testing agent prompt

Write the complete prompt for the **Manual web UI testing** verifier agent (referenced by `agents/manualWebUiTesting.meta.json` → `maestro-manual-web-ui-testing.md`). Per spec §8: its frontmatter **declares Playwright MCP tools**, it drives the running web UI through the checklist, and emits the **`protocol.mjs` verdict JSON** (`{ issues:[{severity,title,detail,location}], summary }`, severities per `protocol.mjs:15`). On blocking issues it can drive a feedback loop back to Implementation (it is `loopSource:true`). Frontmatter `tools` lists the read tools plus the Playwright MCP tool names (`mcp__plugin_playwright_playwright__browser_*` — confirmed available in this environment). The "app must be running" open item (spec §8) is pinned: the agent reads `webUiTesting.startCommand`/`baseUrl` from the project's `.maestro/config.json`; if absent it starts the app per the README and reports if it cannot.

**Files:**
- `agents/maestro-manual-web-ui-testing.md` (create)

Steps:

- [ ] **Step 1: Write `agents/maestro-manual-web-ui-testing.md`.**
```markdown
---
name: maestro-manual-web-ui-testing
description: Manual web UI testing agent for the orchestrator pipeline. Drives the RUNNING web UI through the manual test checklist using the Playwright MCP browser tools, then emits review-cycleN.json with honest critical/major/minor/suggestion severities so the Implement -> Manual-UI-test loop terminates correctly. A verifier/loopSource step. Invoked by the deterministic orchestrator, never directly by a human.
tools: Read, Bash, Grep, Glob, Skill, mcp__plugin_playwright_playwright__browser_navigate, mcp__plugin_playwright_playwright__browser_snapshot, mcp__plugin_playwright_playwright__browser_click, mcp__plugin_playwright_playwright__browser_type, mcp__plugin_playwright_playwright__browser_fill_form, mcp__plugin_playwright_playwright__browser_select_option, mcp__plugin_playwright_playwright__browser_press_key, mcp__plugin_playwright_playwright__browser_hover, mcp__plugin_playwright_playwright__browser_wait_for, mcp__plugin_playwright_playwright__browser_take_screenshot, mcp__plugin_playwright_playwright__browser_console_messages, mcp__plugin_playwright_playwright__browser_navigate_back, mcp__plugin_playwright_playwright__browser_resize, mcp__plugin_playwright_playwright__browser_close
model: inherit
---

You are the **Manual web UI testing** agent in a deterministic Plan -> Refine -> Implement -> Review pipeline (with manual-testing steps). You are spawned headlessly, once per testing cycle. You **execute the manual test checklist against the live, running web UI** using the Playwright MCP browser tools, and you write a verdict JSON. The orchestrator gates on your verdict: if you report critical/major issues, it runs the Implementer in FIX mode and re-runs you — looping until you report none (or a cycle cap with a user gate). Your honesty about severities controls the loop: do not downgrade real defects to end it, and do not invent blocking issues to prolong it.

## Inputs (from the task prompt)
- The absolute path of the manual test **checklist markdown** to execute (authored by the Manual Tests Checklist agent). Each `- [ ]` item is a case with steps + an Expected result.
- The absolute path of the PLAN that was implemented (for context on intended behavior).
- The absolute path to write `review-cycleN.json`.
- The cycle number.
- Optionally a screenshots directory under the pipeline dir to save evidence.

## Getting the app running (required)
The UI must be reachable before you can test it.
1. Read `<projectDir>/.maestro/config.json`. If it has `webUiTesting.startCommand` (and optionally `webUiTesting.baseUrl`), use them: run the start command with Bash (in the background) and target `baseUrl` (default `http://localhost:3000` if unspecified).
2. If there is no `webUiTesting` config, consult the project README for the dev/start command and the local URL, and start it with Bash.
3. Poll the URL (Bash `curl`, or `browser_navigate` then `browser_wait_for`) until it responds. If after a reasonable wait the app will not start, do NOT fabricate results: write a verdict JSON whose single issue has severity `critical`, title "Web UI did not start", and a detail explaining what you tried and the error, then stop.
4. When you finish testing, stop the app process you started (Bash kill) and call `browser_close`.

## What to do
1. Read the checklist markdown and the plan. Treat each unchecked `- [ ]` item as one case to execute, in order.
2. For each case: navigate (`browser_navigate`), take a `browser_snapshot` to read the accessibility tree, perform the steps (`browser_click` / `browser_type` / `browser_fill_form` / `browser_select_option` / `browser_press_key` / `browser_hover`), wait for results (`browser_wait_for`), and compare the actual outcome to the case's **Expected** result. Use `browser_take_screenshot` to capture evidence for any failure (save under the screenshots dir if one was given). Check `browser_console_messages` for errors after meaningful interactions.
3. Record, per case, PASS or FAIL with the observed behavior. A case whose Expected result does not occur, or that throws a visible/console error, is a FAILED case.
4. Map failures to issues with honest severities:
   - **critical** — a primary flow is broken, the page errors/crashes, data is lost/corrupted, or a console error breaks functionality.
   - **major** — a checklist case fails, a secondary flow is broken, or a clear functional/UX defect that should block acceptance.
   - **minor** — small visual/UX glitch that does not block the flow.
   - **suggestion** — optional polish.

## review-cycleN.json contract (consumed by protocol.readReview / hasBlocking)

```json
{
  "issues": [
    {
      "severity": "major",
      "title": "Short imperative summary of the failed case",
      "detail": "Which checklist case failed, the steps taken, expected vs. actual, and any console error or screenshot path.",
      "location": "URL or view/component, e.g. /composer or 'New Pipeline > workflow dropdown'"
    }
  ],
  "summary": "1-3 sentence verdict: how many checklist cases ran, how many passed/failed, overall pass/fail."
}
```

`critical` and `major` are blocking; the loop continues (Implementer fixes, you re-test) until none remain. Report `[]` issues with a positive summary ONLY when every executed case genuinely passed against the live UI. As fixes land across cycles, your blocking count should genuinely fall.

After writing the JSON, emit a short assistant note with the absolute path of `review-cycleN.json`, the count of cases run vs. passed, and the count of critical/major issues. Do NOT modify application code — you only test and report.

## Output contract reminders
- The verdict JSON must be valid and match the shape above (`severity` from {critical, major, minor, suggestion}); it is parsed by `safeParseJson` / `readReview`.
- Base every finding on what the live UI actually did via the Playwright tools, not assumptions. Write only to the absolute JSON path given (plus screenshots under the given dir).
- Always stop the app you started and `browser_close` before finishing.
- Keep assistant chatter minimal; the verdict JSON is your real output.

## Graph tooling
If the prompt says **graphify** is available, use graphify to understand the UI's routes/components before testing. Else if it says **code-review-graph** is available, use code-review-graph. If BOTH are mentioned, ALWAYS use graphify. If NEITHER is available, proceed without, inspecting the real project with Glob/Grep/Read.
```

- [ ] **Step 2: Verify frontmatter declares Playwright MCP tools and the verdict JSON contract.** Run:
```
node -e "const fs=require('fs');const t=fs.readFileSync('agents/maestro-manual-web-ui-testing.md','utf8');const fm=t.match(/^---\n([\s\S]*?)\n---/);if(!fm)throw new Error('no frontmatter');if(!/\bname:\s*maestro-manual-web-ui-testing/.test(fm[1]))throw new Error('bad name');if(!/mcp__plugin_playwright_playwright__browser_navigate/.test(fm[1]))throw new Error('missing Playwright MCP tools in frontmatter');if(!t.includes('review-cycleN.json'))throw new Error('missing verdict JSON contract');if(!/\"severity\"/.test(t))throw new Error('missing severity field');console.log('OK manual-web-ui-testing: Playwright MCP tools + verdict JSON');"
```
Expected: `OK manual-web-ui-testing: Playwright MCP tools + verdict JSON`.

- [ ] **Step 3: Commit.**
```
git add agents/maestro-manual-web-ui-testing.md
git commit -m "feat(agents): add Manual web UI testing agent prompt (Playwright MCP + verdict)"
```

---

### Task 6: Derive `AGENT_STEPS` in `config.mjs` from the registry

Modify `src/core/config.mjs` to derive `AGENT_STEPS` from the registry instead of the hardcoded literal at `config.mjs:18-23`, **without breaking any existing export**. The new `AGENT_STEPS` is built via `registryToSteps(loadAgentRegistry())`. Critically: `STEP_KEYS` (`config.mjs:25`), `sanitizeSteps` (`config.mjs:72-81`), and `resolveStepModels` (`config.mjs:208-216`) already derive from `AGENT_STEPS`, so they automatically pick up all 6 agents — meaning the two new agents become valid per-step config keys too. This is the additive behavior the contract wants (per-node model/effort in later phases); the original 4 keys keep their exact labels (Plan/Refine/Implement/Review) via `registryToSteps`'s `LEGACY_LABELS`, so existing tests and UI text are unchanged.

The import is synchronous (`agent-registry.mjs` uses `readdirSync`), so `AGENT_STEPS` stays a module-eval constant — no signature changes, no async. All existing `config.mjs` exports (`EFFORTS`, `PREDEFINED_MODELS`, `configDir`, `configFile`, `readConfig`, `listModels`, `setStep`, `addCustomModel`, `removeCustomModel`, `resolveStepModels`) are untouched.

**Files:**
- `src/core/config.mjs:13-23` (modify — add import, replace the hardcoded `AGENT_STEPS`)
- `test/config.test.mjs` (verify — existing suite must stay green)
- `test/agent-registry.test.mjs` (verify — the `assert.deepEqual(steps, AGENT_STEPS)` assertion now passes)

Steps:

- [ ] **Step 1: Add the registry import after the existing imports in `config.mjs`.** Insert immediately below `config.mjs:15` (`import { randomBytes } from 'node:crypto';`):
```js
import { loadAgentRegistry, registryToSteps } from './agent-registry.mjs';
```

- [ ] **Step 2: Replace the hardcoded `AGENT_STEPS` (current `config.mjs:17-23`) with the registry-derived constant.** Replace this exact block:
```js
/** The four agent steps, in pipeline order. Drives the UI + orchestrator. */
export const AGENT_STEPS = [
  { key: 'planner', label: 'Plan' },
  { key: 'refiner', label: 'Refine' },
  { key: 'implementer', label: 'Implement' },
  { key: 'reviewer', label: 'Review' },
];
```
with:
```js
/**
 * The agent steps, in pipeline order — now DERIVED from the agent registry
 * (agents/*.meta.json) rather than hardcoded, so adding an agent needs no edit
 * here. The original four roles keep their legacy short labels via
 * registryToSteps's LEGACY_LABELS, so this stays byte-identical for them while
 * also surfacing the two new agents. Drives the UI + orchestrator + per-step
 * config keys (STEP_KEYS, sanitizeSteps, resolveStepModels all read this).
 */
export const AGENT_STEPS = registryToSteps(loadAgentRegistry());
```

- [ ] **Step 3: Run the existing config suite — expect PASS (no regression).**
```
node --test test/config.test.mjs
```
Expected: PASS. `setStep`/`resolveStepModels`/`sanitizeSteps` still accept `planner`/`refiner`/`implementer`/`reviewer` (they are still in `AGENT_STEPS`, now positions 1–4), and `resolveStepModels` still returns those four roles.

- [ ] **Step 4: Run the registry suite — now ALL pass.**
```
node --test test/agent-registry.test.mjs
```
Expected: PASS (all 5). `config.AGENT_STEPS` now equals `registryToSteps(loadAgentRegistry())`, so the `assert.deepEqual(steps, AGENT_STEPS)` from Task 3 Step 1 passes, and `AGENT_STEPS.length === 6`.

- [ ] **Step 5: Run the full unit suite — confirm nothing else broke.**
```
node --test test/*.mjs
```
Expected: PASS. (If any test asserted `AGENT_STEPS.length === 4` it would surface here; the current suite asserts only role behavior — `test/config.test.mjs` — and is unaffected.)

- [ ] **Step 6: Smoke the default pipeline offline — parity for the original four roles.**
```
MAESTRO_MOCK=1 npm run smoke
```
Expected: PASS — the mock Plan→Refine→Implement→Review run completes; `AGENT_STEPS[0..3]` still resolve to the original roles, so `resolveStepModels` and the orchestrator's `_phaseCtx(role)` behave exactly as before.

- [ ] **Step 7: Commit.**
```
git add src/core/config.mjs
git commit -m "refactor(config): derive AGENT_STEPS from the agent registry"
```

---

### Task 7: Verify the registry round-trips against the orchestrator's hardcoded `AGENT_FILES`

A regression guard: the registry's `agentFile` for the original four roles must match the orchestrator's still-hardcoded `AGENT_FILES` map (`orchestrator.mjs:48-53`), so when a later phase replaces that map with the registry, the prompt files resolve identically. This catches a typo in any sidecar's `agentFile` before it can desync the engine.

**Files:**
- `test/agent-registry.test.mjs:1` (modify — append the cross-check tests)

Steps:

- [ ] **Step 1: Append the round-trip tests to `test/agent-registry.test.mjs`** (after the existing tests, reusing the existing `loadAgentRegistry` import; add the `node:fs`/`node:path` imports at the top of the file):
```js
import { existsSync } from 'node:fs';
import { join } from 'node:path';
```
```js
test('every agentFile points at an existing prompt under agents/', () => {
  const reg = loadAgentRegistry();
  const agentsDir = new URL('../agents/', import.meta.url).pathname;
  for (const m of Object.values(reg)) {
    assert.ok(m.agentFile, `${m.key} has no agentFile`);
    assert.ok(
      existsSync(join(agentsDir, m.agentFile)),
      `missing prompt file for ${m.key}: ${m.agentFile}`,
    );
  }
});

test('original four agentFiles match the orchestrator AGENT_FILES map', () => {
  const reg = loadAgentRegistry();
  // Mirror of orchestrator.mjs:48-53 (the hardcoded map a later phase replaces).
  const LEGACY_AGENT_FILES = {
    planner: 'maestro-planner.md',
    refiner: 'maestro-plan-refiner.md',
    implementer: 'maestro-implementer.md',
    reviewer: 'maestro-code-reviewer.md',
  };
  for (const [key, file] of Object.entries(LEGACY_AGENT_FILES)) {
    assert.equal(reg[key].agentFile, file, `agentFile mismatch for ${key}`);
  }
});

test('exactly the two verifiers are loopSources; producers are not', () => {
  const reg = loadAgentRegistry();
  const loopSources = Object.values(reg).filter((m) => m.loopSource).map((m) => m.key).sort();
  assert.deepEqual(loopSources, ['manualWebUiTesting', 'reviewer']);
  for (const m of Object.values(reg)) {
    if (m.runnerType === 'producer') assert.equal(m.loopSource, false, `${m.key} producer must not loop`);
  }
});
```

- [ ] **Step 2: Run the test — expect PASS.**
```
node --test test/agent-registry.test.mjs
```
Expected: PASS — all `agentFile`s resolve to real files, the original four match `AGENT_FILES`, and only `reviewer` + `manualWebUiTesting` are loop sources.

- [ ] **Step 3: Commit.**
```
git add test/agent-registry.test.mjs
git commit -m "test(agents): guard registry agentFiles against orchestrator AGENT_FILES"
```

---

### Task 8: Full-suite + smoke green checkpoint

A consolidation checkpoint proving Phase {N} did not regress anything and that the engine still runs offline with the registry-derived `AGENT_STEPS`. No new files; this is the verification-before-completion gate for the foundation.

**Files:** (none — verification only)

Steps:

- [ ] **Step 1: Run the entire unit suite.**
```
node --test test/*.mjs
```
Expected: PASS for every file. Watch specifically that `test/config.test.mjs`, `test/agent-registry.test.mjs`, and any UI/config tests are green.

- [ ] **Step 2: Run the offline smoke.**
```
MAESTRO_MOCK=1 npm run smoke
```
Expected: PASS — the mocked Plan→Refine→Implement→Review pipeline completes with status `done`.

- [ ] **Step 3: Confirm the 6 sidecars + 2 new prompts are present and parse.**
```
node -e "const r=await import('./src/core/agent-registry.mjs');const reg=r.loadAgentRegistry();const keys=Object.keys(reg);if(keys.length!==6)throw new Error('expected 6, got '+keys.length+': '+keys);console.log('registry OK:',keys.join(', '));console.log('steps:',JSON.stringify(r.registryToSteps(reg)));"
```
Expected: `registry OK: planner, refiner, implementer, reviewer, manualTestsChecklist, manualWebUiTesting` and the 6-entry steps array.

- [ ] **Step 4: Commit (empty allowed) the checkpoint marker only if Step 1–3 are clean.** No code changed, so skip an empty commit unless you want a marker; otherwise this task is a pure gate. If marking:
```
git commit --allow-empty -m "chore(agents): phase foundation green (registry + 6 metas + 2 new agents)"
```

## Phase 2: Workflow template store, validator, run-config resolution

This phase builds the data layer the data-driven engine reads: the global workflow-template store (`~/.maestro/workflows/`), the built-in `DEFAULT_WORKFLOW` (which reproduces today's `Plan → Refine → Implement → Review` with the `_refineLoop`/`_reviewLoop` gates), the topology validator, the per-project run-config (model/effort/cycles, layered on top of `.maestro/config.json` without disturbing the legacy `steps`/`customModels` keys), and `resolveWorkflow` which merges template + run-config + agent registry into an `ExecutablePlan`.

**Verified anchors (read before coding):**
- Atomic write = `mkdir(dir,{recursive:true})` → write `${file}.${randomBytes(4).toString('hex')}.tmp` → `rename(tmp,file)` — `src/core/config.mjs:108-115`, `src/core/projects.mjs:64-71`.
- Global dir resolution honoring `MAESTRO_HOME`: `maestroHome()` `src/core/projects.mjs:16-20`; reads never throw (missing/corrupt → `[]`/default) `src/core/projects.mjs:53-62`, `src/core/config.mjs:97-106`.
- Legacy config shape `{ steps:{}, customModels:[] }` from `defaultConfig()` `src/core/config.mjs:67-69`; `readRaw` sanitizes only `steps`/`customModels` `src/core/config.mjs:98-106`; `resolveStepModels` `src/core/config.mjs:208-216`.
- Default cycle counts `maxRefineCycles=5` / `maxReviewCycles=5` — `src/core/orchestrator.mjs:81-82` (from `opts`, default 5).
- Loop semantics: refine loop re-runs the **refine** step itself (self-loop), gates at `cycle >= maxRefineCycles` `src/core/orchestrator.mjs:331-389`; review loop runs reviewer then, on blocking, an implementer **fix** pass before re-review — i.e. the loop target is the **implement** step — gating at `cycle >= maxReviewCycles` `src/core/orchestrator.mjs:395-459`.
- Blocking = critical|major, gate verdict shape `{issues,summary}` — `src/core/protocol.mjs:15-17,245-258`.
- The 4 existing `agentFile`s: planner→`maestro-planner.md`, refiner→`maestro-plan-refiner.md`, implementer→`maestro-implementer.md`, reviewer→`maestro-code-reviewer.md` — `src/core/orchestrator.mjs:48-53`.
- Test conventions: `import { test } from 'node:test'`, `import assert from 'node:assert/strict'`, `mkdtemp`+`after()` cleanup, offline (`MAESTRO_MOCK=1`) — `test/config.test.mjs:1-19`, `test/projects.test.mjs`.

**Cross-phase contract:** `resolveWorkflow(projectDir, workflowId, registry)` takes the registry built by Phase 1's `loadAgentRegistry()` (`{ [key]: AgentMeta }`, AgentMeta = `{ key, displayName, description, color, icon, agentFile|null, runnerType, loopSource, connectsTo, order }`). To keep this phase independently testable, every test in this phase builds a small **inline fake registry** matching that shape (it does not import `agent-registry.mjs`). The `agents/<agentFile>.md` files referenced by `DEFAULT_WORKFLOW` already exist on disk (`agents/maestro-*.md`), so `resolveWorkflow`'s prompt/tool loading is exercised against the real files.

---

### Task 1: `DEFAULT_WORKFLOW` + `workflowsDir()` and a failing skeleton test

**Files:**
- Create `src/core/workflows.mjs`
- Create `test/workflows.test.mjs`

- [ ] **Step 1: Write the failing test for `DEFAULT_WORKFLOW` shape + `workflowsDir()`.** Create `test/workflows.test.mjs`:
```js
// test/workflows.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_WORKFLOW,
  workflowsDir,
  listWorkflows,
  readWorkflow,
  writeWorkflow,
  deleteWorkflow,
  resolveWorkflow,
} from '../src/core/workflows.mjs';

// Each test gets its own ~/.maestro via MAESTRO_HOME so the global store is
// isolated and nothing touches the developer's real home dir.
const homes = [];
async function freshHome() {
  const d = await mkdtemp(join(tmpdir(), 'maestro-home-'));
  homes.push(d);
  process.env.MAESTRO_HOME = d;
  return d;
}
const projects = [];
async function freshProject() {
  const d = await mkdtemp(join(tmpdir(), 'maestro-proj-'));
  projects.push(d);
  return d;
}
after(async () => {
  delete process.env.MAESTRO_HOME;
  await Promise.all([...homes, ...projects].map((d) => rm(d, { recursive: true, force: true })));
});

test('DEFAULT_WORKFLOW is the Plan->Refine->Implement->Review topology', () => {
  assert.equal(DEFAULT_WORKFLOW.id, 'wf_default');
  assert.equal(DEFAULT_WORKFLOW.name, 'Default');
  assert.equal(DEFAULT_WORKFLOW.version, 1);
  // 4 sequential steps, one node each.
  assert.equal(DEFAULT_WORKFLOW.steps.length, 4);
  assert.deepEqual(DEFAULT_WORKFLOW.steps.map((s) => s.length), [1, 1, 1, 1]);
  assert.deepEqual(
    DEFAULT_WORKFLOW.steps.map((s) => s[0].key),
    ['planner', 'refiner', 'implementer', 'reviewer'],
  );
  // Node ids are unique instance ids.
  const ids = DEFAULT_WORKFLOW.steps.flat().map((n) => n.id);
  assert.deepEqual(ids, ['s0_0', 's1_0', 's2_0', 's3_0']);
});

test('DEFAULT_WORKFLOW feedbacks reproduce the refine self-loop and review->implement loop', () => {
  // Two loops: refiner self-loop (s1_0 -> s1_0) and review -> implement (s3_0 -> s2_0).
  const fbs = DEFAULT_WORKFLOW.feedbacks;
  assert.equal(fbs.length, 2);
  const refine = fbs.find((f) => f.from === 's1_0');
  const review = fbs.find((f) => f.from === 's3_0');
  assert.ok(refine, 'refine loop present');
  assert.equal(refine.to, 's1_0'); // self-loop, mirrors _refineLoop re-running refine
  assert.ok(review, 'review loop present');
  assert.equal(review.to, 's2_0'); // review -> implement (fix pass), mirrors _reviewLoop
  // Feedback ids are unique.
  assert.equal(new Set(fbs.map((f) => f.id)).size, fbs.length);
});

test('workflowsDir is <MAESTRO_HOME>/.maestro/workflows', async () => {
  const home = await freshHome();
  assert.equal(workflowsDir(), join(home, '.maestro', 'workflows'));
});
```

- [ ] **Step 2: Run it — expect FAIL (module missing).**
```bash
node --test test/workflows.test.mjs
```
Expected: failure — `Cannot find module '../src/core/workflows.mjs'`.

- [ ] **Step 3: Create `src/core/workflows.mjs` with `DEFAULT_WORKFLOW`, `workflowsDir()`, and import stubs.** Write the file (CRUD + resolve bodies are filled in later tasks; this step defines the constant, the dir helper, and the import surface so the test compiles):
```js
// src/core/workflows.mjs
// Global workflow-template store + the built-in DEFAULT_WORKFLOW + resolveWorkflow.
//
// Templates are TOPOLOGY ONLY (steps + feedbacks, by node-instance id); they live
// under ~/.maestro/workflows/<id>.json (global, honoring MAESTRO_HOME like
// projects.mjs). Per-project model/effort/cycle data is the run-config in
// config.mjs and is merged in by resolveWorkflow.
//
// Reads never throw: a missing/corrupt store yields []/null. Writes are atomic
// (temp file + rename), mirroring config.mjs / projects.mjs.

import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { maestroHome } from './projects.mjs';
import { resolveRunConfig } from './config.mjs';

/**
 * The built-in default workflow: the CURRENT pipeline Plan -> Refine -> Implement
 * -> Review, with the two feedback loops that reproduce today's _refineLoop and
 * _reviewLoop (orchestrator.mjs:331-459):
 *   - refiner self-loop  (s1_0 -> s1_0): re-run the refine step on blocking issues.
 *   - review -> implement (s3_0 -> s2_0): on blocking review issues, run an
 *     implementer fix pass (the 'to' step) then re-review.
 * Default cycle counts come from run-config resolution (resolveRunConfig falls
 * back to DEFAULT_MAX_CYCLES = 5, matching orchestrator maxRefine/maxReviewCycles).
 * NOT persisted to the user store; always present; readWorkflow('wf_default')
 * returns it.
 * @type {{id:string,name:string,version:number,steps:Array<Array<{id:string,key:string}>>,feedbacks:Array<{id:string,from:string,to:string}>,createdAt:string,updatedAt:string}}
 */
export const DEFAULT_WORKFLOW = Object.freeze({
  id: 'wf_default',
  name: 'Default',
  version: 1,
  steps: [
    [{ id: 's0_0', key: 'planner' }],
    [{ id: 's1_0', key: 'refiner' }],
    [{ id: 's2_0', key: 'implementer' }],
    [{ id: 's3_0', key: 'reviewer' }],
  ],
  feedbacks: [
    { id: 'fb_refine', from: 's1_0', to: 's1_0' },
    { id: 'fb_review', from: 's3_0', to: 's2_0' },
  ],
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
});

/** Absolute path to ~/.maestro/workflows (honors MAESTRO_HOME via projects.mjs). */
export function workflowsDir() {
  return join(maestroHome(), 'workflows');
}

/** Absolute path to a single template file. */
function workflowFile(id) {
  return join(workflowsDir(), `${id}.json`);
}

export function listWorkflows() { return []; }            // Task 2
export function readWorkflow(_id) { return null; }         // Task 2
export function writeWorkflow(_tpl) { throw new Error('not implemented'); } // Task 2
export function deleteWorkflow(_id) { return false; }      // Task 3
export function resolveWorkflow(_projectDir, _workflowId, _registry) { throw new Error('not implemented'); } // Task 6
```

- [ ] **Step 4: Run the test — expect PASS for the 3 implemented tests.**
```bash
node --test test/workflows.test.mjs
```
Expected: the `DEFAULT_WORKFLOW` and `workflowsDir` tests PASS. (Other functions are stubs; no test covers them yet.)

- [ ] **Step 5: Commit.**
```bash
git add src/core/workflows.mjs test/workflows.test.mjs
git commit -m "feat(workflows): DEFAULT_WORKFLOW topology + workflowsDir scaffold

Built-in wf_default reproduces Plan->Refine->Implement->Review with the
refine self-loop and review->implement feedback, matching today's
_refineLoop/_reviewLoop. Store dir honors MAESTRO_HOME.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `writeWorkflow` / `readWorkflow` / `listWorkflows` (atomic write+read roundtrip)

**Files:**
- Modify `src/core/workflows.mjs` (replace the `listWorkflows`/`readWorkflow`/`writeWorkflow` stubs)
- Modify `test/workflows.test.mjs` (add roundtrip tests)

- [ ] **Step 1: Add failing roundtrip tests.** Append to `test/workflows.test.mjs`:
```js
test('writeWorkflow stamps id/createdAt/updatedAt and roundtrips through readWorkflow', async () => {
  await freshHome();
  const saved = await writeWorkflow({
    name: 'Quick Fix',
    steps: [[{ id: 's0_0', key: 'planner' }], [{ id: 's1_0', key: 'implementer' }]],
    feedbacks: [],
  });
  assert.match(saved.id, /^wf_/);
  assert.equal(saved.name, 'Quick Fix');
  assert.equal(saved.version, 1);
  assert.ok(saved.createdAt && saved.updatedAt, 'timestamps stamped');

  // Persisted on disk as <id>.json.
  const onDisk = JSON.parse(await readFile(join(workflowsDir(), `${saved.id}.json`), 'utf8'));
  assert.equal(onDisk.name, 'Quick Fix');

  const got = await readWorkflow(saved.id);
  assert.deepEqual(got.steps, saved.steps);
  assert.deepEqual(got.feedbacks, saved.feedbacks);
});

test('writeWorkflow derives a wf_<slug> id from the name when id is missing', async () => {
  await freshHome();
  const saved = await writeWorkflow({ name: 'My Cool Flow', steps: [[{ id: 's0_0', key: 'planner' }]], feedbacks: [] });
  assert.match(saved.id, /^wf_my-cool-flow/);
});

test('writeWorkflow preserves createdAt but bumps updatedAt on re-save', async () => {
  await freshHome();
  const first = await writeWorkflow({ id: 'wf_x', name: 'X', steps: [[{ id: 's0_0', key: 'planner' }]], feedbacks: [] });
  const second = await writeWorkflow({ ...first, name: 'X2', updatedAt: undefined });
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.name, 'X2');
});

test('listWorkflows returns user templates sorted newest-first; excludes wf_default', async () => {
  await freshHome();
  const a = await writeWorkflow({ id: 'wf_a', name: 'A', steps: [[{ id: 's0_0', key: 'planner' }]], feedbacks: [], createdAt: '2026-01-01T00:00:00.000Z' });
  const b = await writeWorkflow({ id: 'wf_b', name: 'B', steps: [[{ id: 's0_0', key: 'planner' }]], feedbacks: [], createdAt: '2026-02-01T00:00:00.000Z' });
  const list = await listWorkflows();
  assert.deepEqual(list.map((w) => w.id), ['wf_b', 'wf_a']); // newest createdAt first
  assert.ok(!list.some((w) => w.id === 'wf_default'), 'DEFAULT_WORKFLOW is not in the user store');
});

test('readWorkflow returns DEFAULT_WORKFLOW for "wf_default"', async () => {
  await freshHome();
  const got = await readWorkflow('wf_default');
  assert.equal(got.id, 'wf_default');
  assert.equal(got.steps.length, 4);
});

test('readWorkflow returns null for a missing id; listWorkflows is [] on an empty store', async () => {
  await freshHome();
  assert.equal(await readWorkflow('wf_nope'), null);
  assert.deepEqual(await listWorkflows(), []);
});
```

- [ ] **Step 2: Run — expect FAIL.**
```bash
node --test test/workflows.test.mjs
```
Expected: the new roundtrip/list tests FAIL (`writeWorkflow` throws "not implemented"; `readWorkflow` returns null for real ids; `listWorkflows` returns `[]`).

- [ ] **Step 3: Implement the CRUD read/write helpers.** In `src/core/workflows.mjs`, add a slug import and replace the three stubs. First add to the existing artifacts import — instead, import `slugify` from artifacts:
```js
import { slugify } from './artifacts.mjs';
```
Then replace `export function listWorkflows() { return []; }`, `export function readWorkflow(_id) { return null; }`, and `export function writeWorkflow(_tpl) { throw new Error('not implemented'); }` with:
```js
/** Atomically write the JSON store file. Creates ~/.maestro/workflows on demand. */
async function writeRaw(id, tpl) {
  await mkdir(workflowsDir(), { recursive: true });
  const file = workflowFile(id);
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(tpl, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

/** Read + shallow-validate one stored template. Missing/corrupt => null. */
async function readRaw(id) {
  try {
    const data = JSON.parse(await readFile(workflowFile(id), 'utf8'));
    if (!data || typeof data !== 'object' || !Array.isArray(data.steps)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Persist a template atomically. Stamps a wf_<slug> id (from the name) when
 * missing, version 1, createdAt (preserved across re-saves) and a fresh
 * updatedAt. Returns the stored object. Never mutates the input.
 * @param {object} tpl { id?, name, steps, feedbacks }
 * @returns {Promise<object>}
 */
export async function writeWorkflow(tpl) {
  const now = new Date().toISOString();
  const name = (tpl && typeof tpl.name === 'string' && tpl.name.trim()) || 'Untitled';
  const id = (tpl && typeof tpl.id === 'string' && tpl.id.trim()) || `wf_${slugify(name)}`;
  // Preserve the original createdAt if this id already exists (re-save).
  const existing = await readRaw(id);
  const createdAt =
    (tpl && typeof tpl.createdAt === 'string' && tpl.createdAt) ||
    existing?.createdAt ||
    now;
  const stored = {
    id,
    name,
    version: 1,
    steps: Array.isArray(tpl?.steps) ? tpl.steps : [],
    feedbacks: Array.isArray(tpl?.feedbacks) ? tpl.feedbacks : [],
    createdAt,
    updatedAt: now,
  };
  await writeRaw(id, stored);
  return stored;
}

/**
 * Read a template by id. Returns the built-in DEFAULT_WORKFLOW for "wf_default";
 * otherwise the stored template, or null when absent/corrupt.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function readWorkflow(id) {
  if (id === DEFAULT_WORKFLOW.id) return DEFAULT_WORKFLOW;
  return readRaw(id);
}

/**
 * List user templates (NOT DEFAULT_WORKFLOW — callers prepend it), newest first
 * by createdAt. Missing store => []. Never throws.
 * @returns {Promise<object[]>}
 */
export async function listWorkflows() {
  let names;
  try {
    names = await readdir(workflowsDir());
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const tpl = await readRaw(f.slice(0, -'.json'.length));
    if (tpl && tpl.id !== DEFAULT_WORKFLOW.id) out.push(tpl);
  }
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return out;
}
```

- [ ] **Step 4: Run — expect PASS.**
```bash
node --test test/workflows.test.mjs
```
Expected: all roundtrip/list/read tests PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/core/workflows.mjs test/workflows.test.mjs
git commit -m "feat(workflows): atomic write/read/list template CRUD

writeWorkflow stamps wf_<slug> id + version + timestamps (createdAt
preserved on re-save), atomic temp+rename. readWorkflow returns
DEFAULT_WORKFLOW for wf_default, null when missing. listWorkflows is
newest-first and excludes the built-in default.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `deleteWorkflow` (delete + refuse-delete-default)

**Files:**
- Modify `src/core/workflows.mjs` (replace the `deleteWorkflow` stub)
- Modify `test/workflows.test.mjs` (add delete tests)

- [ ] **Step 1: Add failing delete tests.** Append to `test/workflows.test.mjs`:
```js
test('deleteWorkflow removes a saved template and returns true', async () => {
  await freshHome();
  const saved = await writeWorkflow({ id: 'wf_del', name: 'Del', steps: [[{ id: 's0_0', key: 'planner' }]], feedbacks: [] });
  assert.equal(await deleteWorkflow(saved.id), true);
  assert.equal(await readWorkflow(saved.id), null);
  const files = await readdir(workflowsDir());
  assert.ok(!files.includes('wf_del.json'));
});

test('deleteWorkflow returns false for a missing id', async () => {
  await freshHome();
  assert.equal(await deleteWorkflow('wf_ghost'), false);
});

test('deleteWorkflow refuses to delete the built-in default (returns false, leaves it readable)', async () => {
  await freshHome();
  assert.equal(await deleteWorkflow('wf_default'), false);
  const still = await readWorkflow('wf_default');
  assert.equal(still.id, 'wf_default'); // DEFAULT_WORKFLOW is always present
});
```

- [ ] **Step 2: Run — expect FAIL.**
```bash
node --test test/workflows.test.mjs
```
Expected: delete tests FAIL (stub returns `false` for the happy path too, and does not unlink).

- [ ] **Step 3: Implement `deleteWorkflow`.** In `src/core/workflows.mjs` replace `export function deleteWorkflow(_id) { return false; }` with:
```js
/**
 * Delete a saved template by id. Refuses to delete the built-in DEFAULT_WORKFLOW
 * (returns false). Returns false when the file does not exist; true on removal.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteWorkflow(id) {
  if (id === DEFAULT_WORKFLOW.id) return false; // built-in default is undeletable
  const file = workflowFile(id);
  if (!existsSync(file)) return false;
  try {
    await unlink(file);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run — expect PASS.**
```bash
node --test test/workflows.test.mjs
```
Expected: all workflow CRUD tests PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/core/workflows.mjs test/workflows.test.mjs
git commit -m "feat(workflows): deleteWorkflow with refuse-delete-default

Returns false for wf_default and for missing ids; unlinks and returns
true on success. DEFAULT_WORKFLOW stays readable after a refused delete.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `validateWorkflow` (every CONTRACT rule, each with a failing test)

**Files:**
- Create `src/core/workflow-validator.mjs`
- Create `test/workflow-validator.test.mjs`

- [ ] **Step 1: Write the failing validator test (one assertion per rule).** Create `test/workflow-validator.test.mjs`:
```js
// test/workflow-validator.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateWorkflow } from '../src/core/workflow-validator.mjs';
import { DEFAULT_WORKFLOW } from '../src/core/workflows.mjs';

// Inline fake registry (matches Phase 1's AgentMeta shape) so this phase tests
// independently of agent-registry.mjs. Only `key` is consulted by the validator.
const REGISTRY = {
  planner: { key: 'planner', runnerType: 'producer', agentFile: 'maestro-planner.md', loopSource: false },
  refiner: { key: 'refiner', runnerType: 'producer', agentFile: 'maestro-plan-refiner.md', loopSource: true },
  implementer: { key: 'implementer', runnerType: 'producer', agentFile: 'maestro-implementer.md', loopSource: false },
  reviewer: { key: 'reviewer', runnerType: 'verifier', agentFile: 'maestro-code-reviewer.md', loopSource: true },
};

// A minimal valid template builder so each test perturbs exactly one rule.
function valid() {
  return {
    id: 'wf_t',
    name: 'T',
    steps: [
      [{ id: 's0_0', key: 'planner' }],
      [{ id: 's1_0', key: 'implementer' }],
      [{ id: 's2_0', key: 'reviewer' }],
    ],
    feedbacks: [{ id: 'fb_0', from: 's2_0', to: 's1_0' }],
  };
}

test('a well-formed workflow passes', () => {
  const { ok, errors } = validateWorkflow(valid(), REGISTRY);
  assert.equal(ok, true, errors.join('; '));
  assert.deepEqual(errors, []);
});

test('DEFAULT_WORKFLOW passes against a registry of its 4 keys', () => {
  const { ok, errors } = validateWorkflow(DEFAULT_WORKFLOW, REGISTRY);
  assert.equal(ok, true, errors.join('; '));
});

test('rejects a workflow with no steps', () => {
  const t = valid();
  t.steps = [];
  const { ok, errors } = validateWorkflow(t, REGISTRY);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /at least one step|no steps|empty/i.test(e)), errors.join('; '));
});

test('rejects an empty step (a step with zero nodes)', () => {
  const t = valid();
  t.steps = [[{ id: 's0_0', key: 'planner' }], [], [{ id: 's2_0', key: 'reviewer' }]];
  const { ok, errors } = validateWorkflow(t, REGISTRY);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /empty step|step 1|no nodes/i.test(e)), errors.join('; '));
});

test('rejects an unknown node key (not in registry)', () => {
  const t = valid();
  t.steps[0][0].key = 'wizard';
  const { ok, errors } = validateWorkflow(t, REGISTRY);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /wizard/.test(e) && /registry|unknown/i.test(e)), errors.join('; '));
});

test('rejects duplicate node ids', () => {
  const t = valid();
  t.steps[1][0].id = 's0_0'; // collide with the planner node id
  const { ok, errors } = validateWorkflow(t, REGISTRY);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /duplicate/i.test(e) && /s0_0/.test(e)), errors.join('; '));
});

test('rejects a node with a missing/blank id', () => {
  const t = valid();
  delete t.steps[1][0].id;
  const { ok, errors } = validateWorkflow(t, REGISTRY);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /id/i.test(e)), errors.join('; '));
});

test('rejects a dangling feedback (from references a non-existent node)', () => {
  const t = valid();
  t.feedbacks = [{ id: 'fb_0', from: 'sX_0', to: 's1_0' }];
  const { ok, errors } = validateWorkflow(t, REGISTRY);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /sX_0/.test(e) && /from|exist|unknown/i.test(e)), errors.join('; '));
});

test('rejects a dangling feedback (to references a non-existent node)', () => {
  const t = valid();
  t.feedbacks = [{ id: 'fb_0', from: 's2_0', to: 'sY_0' }];
  const { ok, errors } = validateWorkflow(t, REGISTRY);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /sY_0/.test(e) && /to|exist|unknown/i.test(e)), errors.join('; '));
});

test('rejects a forward-pointing feedback (target step index >= source step index)', () => {
  const t = valid();
  // from s1_0 (step 1) to s2_0 (step 2) points forward -> illegal.
  t.feedbacks = [{ id: 'fb_0', from: 's1_0', to: 's2_0' }];
  const { ok, errors } = validateWorkflow(t, REGISTRY);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /precede|forward|before|step/i.test(e)), errors.join('; '));
});

test('accepts a self-loop feedback (to step index == from step index is NOT allowed)', () => {
  // The refine loop in DEFAULT is a self-loop (from===to, same node). The rule is
  // "target step index < source step index"; a same-node self-loop has equal
  // indices and must be allowed as a special case (same node id), but a DIFFERENT
  // node in the SAME step pointing back is still forward-equal and rejected.
  const t = valid();
  t.feedbacks = [{ id: 'fb_0', from: 's1_0', to: 's1_0' }];
  const { ok, errors } = validateWorkflow(t, REGISTRY);
  assert.equal(ok, true, errors.join('; '));
});

test('rejects duplicate feedback ids', () => {
  const t = valid();
  t.feedbacks = [
    { id: 'fb_0', from: 's2_0', to: 's1_0' },
    { id: 'fb_0', from: 's2_0', to: 's0_0' },
  ];
  const { ok, errors } = validateWorkflow(t, REGISTRY);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /duplicate/i.test(e) && /fb_0/.test(e)), errors.join('; '));
});

test('rejects a null/non-object template', () => {
  assert.equal(validateWorkflow(null, REGISTRY).ok, false);
  assert.equal(validateWorkflow({}, REGISTRY).ok, false);
});
```

- [ ] **Step 2: Run — expect FAIL (module missing).**
```bash
node --test test/workflow-validator.test.mjs
```
Expected: `Cannot find module '../src/core/workflow-validator.mjs'`.

- [ ] **Step 3: Implement `validateWorkflow`.** Create `src/core/workflow-validator.mjs`:
```js
// src/core/workflow-validator.mjs
// Pure, dependency-free validator for a WorkflowTemplate against an agent
// registry. Collects ALL violations (does not short-circuit) so the UI/API can
// show every problem at once. Returns { ok, errors:string[] }.
//
// Rules (CONTRACT §workflow-validator):
//   1. template is a non-null object with a non-empty steps array;
//   2. no empty steps (every step has >= 1 node);
//   3. every node has a non-blank string id, and ids are unique workflow-wide;
//   4. every node.key exists in the registry;
//   5. feedback from/to reference existing node ids;
//   6. a feedback's target step index < its source step index
//      (a same-node self-loop, from===to, is allowed; the forward graph is
//       otherwise acyclic so only back-edges are legal feedbacks);
//   7. feedback ids are unique.

/**
 * @param {object} tpl  WorkflowTemplate { steps:[[{id,key}]], feedbacks:[{id,from,to}] }
 * @param {Record<string,{key:string}>} registry  loadAgentRegistry() output
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateWorkflow(tpl, registry) {
  const errors = [];
  const reg = registry && typeof registry === 'object' ? registry : {};

  if (!tpl || typeof tpl !== 'object' || !Array.isArray(tpl.steps)) {
    return { ok: false, errors: ['workflow must be an object with a steps array'] };
  }
  if (tpl.steps.length === 0) {
    errors.push('workflow must have at least one step');
  }

  // Pass 1: nodes — shape, unique ids, known keys. Build id -> stepIndex map.
  const stepOfNode = new Map(); // nodeId -> step index
  const seenIds = new Set();
  for (let i = 0; i < tpl.steps.length; i++) {
    const group = tpl.steps[i];
    if (!Array.isArray(group) || group.length === 0) {
      errors.push(`step ${i} is empty (a step must contain at least one node)`);
      continue;
    }
    for (const node of group) {
      if (!node || typeof node !== 'object') {
        errors.push(`step ${i} contains a non-object node`);
        continue;
      }
      const id = typeof node.id === 'string' ? node.id.trim() : '';
      if (!id) {
        errors.push(`step ${i} has a node with a missing or blank id`);
        continue;
      }
      if (seenIds.has(id)) {
        errors.push(`duplicate node id "${id}"`);
      } else {
        seenIds.add(id);
        stepOfNode.set(id, i);
      }
      const key = typeof node.key === 'string' ? node.key.trim() : '';
      if (!key) {
        errors.push(`node "${id}" has a missing or blank key`);
      } else if (!Object.prototype.hasOwnProperty.call(reg, key)) {
        errors.push(`node "${id}" has key "${key}" which is not in the agent registry`);
      }
    }
  }

  // Pass 2: feedbacks — unique ids, endpoints exist, target precedes source.
  const feedbacks = Array.isArray(tpl.feedbacks) ? tpl.feedbacks : [];
  const seenFb = new Set();
  for (const fb of feedbacks) {
    if (!fb || typeof fb !== 'object') {
      errors.push('feedbacks contains a non-object entry');
      continue;
    }
    const fid = typeof fb.id === 'string' ? fb.id.trim() : '';
    if (!fid) {
      errors.push('a feedback has a missing or blank id');
    } else if (seenFb.has(fid)) {
      errors.push(`duplicate feedback id "${fid}"`);
    } else {
      seenFb.add(fid);
    }
    const from = typeof fb.from === 'string' ? fb.from.trim() : '';
    const to = typeof fb.to === 'string' ? fb.to.trim() : '';
    const hasFrom = stepOfNode.has(from);
    const hasTo = stepOfNode.has(to);
    if (!hasFrom) errors.push(`feedback "${fid || '?'}" from "${from}" does not exist`);
    if (!hasTo) errors.push(`feedback "${fid || '?'}" to "${to}" does not exist`);
    if (hasFrom && hasTo) {
      const sFrom = stepOfNode.get(from);
      const sTo = stepOfNode.get(to);
      // A same-node self-loop (from === to) is legal (the refine loop). Otherwise
      // the target step must strictly precede the source step (a back-edge).
      if (from !== to && sTo >= sFrom) {
        errors.push(
          `feedback "${fid || '?'}" target step (${sTo}) must precede its source step (${sFrom})`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
```

- [ ] **Step 4: Run — expect PASS.**
```bash
node --test test/workflow-validator.test.mjs
```
Expected: every rule test PASSes (including DEFAULT_WORKFLOW valid and the self-loop accepted).

- [ ] **Step 5: Commit.**
```bash
git add src/core/workflow-validator.mjs test/workflow-validator.test.mjs
git commit -m "feat(workflows): validateWorkflow with one failing test per rule

Collects all violations: non-empty steps, no empty step, unique non-blank
node ids, keys present in registry, feedback endpoints exist, feedback
target step precedes source (self-loop allowed), unique feedback ids.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Run-config in `config.mjs` (`readRunConfig`/`setNodeModel`/`setFeedbackCycles`/`setActiveWorkflow`/`resolveRunConfig`)

**Files:**
- Modify `src/core/config.mjs` (add run-config layer; keep all existing exports)
- Create `test/run-config.test.mjs`

- [ ] **Step 1: Write the failing run-config test.** Create `test/run-config.test.mjs`:
```js
// test/run-config.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readConfig, setStep, configFile,
  readRunConfig, setNodeModel, setFeedbackCycles, setActiveWorkflow, resolveRunConfig,
} from '../src/core/config.mjs';

const dirs = [];
async function freshProject() {
  const d = await mkdtemp(join(tmpdir(), 'maestro-proj-'));
  dirs.push(d);
  return d;
}
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

test('readRunConfig on a fresh project returns empty workflows and no active id', async () => {
  const p = await freshProject();
  const rc = await readRunConfig(p);
  assert.deepEqual(rc.workflows, {});
  assert.equal(rc.activeWorkflowId, undefined);
  // Legacy keys still present and empty.
  assert.deepEqual(rc.steps, {});
  assert.deepEqual(rc.customModels, []);
});

test('setNodeModel persists model+effort keyed by workflowId -> nodeId', async () => {
  const p = await freshProject();
  await setNodeModel(p, 'wf_quickfix', 's1_0', { model: 'claude-opus-4-8', effort: 'high' });
  const rc = await readRunConfig(p);
  assert.deepEqual(rc.workflows.wf_quickfix.nodes.s1_0, { model: 'claude-opus-4-8', effort: 'high' });
  // Written to the SAME file as legacy config.
  const onDisk = JSON.parse(await readFile(configFile(p), 'utf8'));
  assert.equal(onDisk.workflows.wf_quickfix.nodes.s1_0.effort, 'high');
});

test('setFeedbackCycles persists maxCycles keyed by workflowId -> fbId', async () => {
  const p = await freshProject();
  await setFeedbackCycles(p, 'wf_quickfix', 'fb_0', 4);
  const rc = await readRunConfig(p);
  assert.deepEqual(rc.workflows.wf_quickfix.feedbacks.fb_0, { maxCycles: 4 });
});

test('setActiveWorkflow records the last-selected workflow id', async () => {
  const p = await freshProject();
  await setActiveWorkflow(p, 'wf_quickfix');
  assert.equal((await readRunConfig(p)).activeWorkflowId, 'wf_quickfix');
});

test('run-config writes do NOT clobber legacy steps/customModels', async () => {
  const p = await freshProject();
  await setStep(p, 'planner', { model: 'claude-opus-4-8', effort: 'xhigh' });
  await setNodeModel(p, 'wf_x', 's0_0', { model: 'claude-sonnet-4-6', effort: 'high' });
  const cfg = await readConfig(p); // legacy reader is unchanged
  assert.deepEqual(cfg.steps.planner, { model: 'claude-opus-4-8', effort: 'xhigh' });
  const rc = await readRunConfig(p);
  assert.deepEqual(rc.steps.planner, { model: 'claude-opus-4-8', effort: 'xhigh' });
  assert.equal(rc.workflows.wf_x.nodes.s0_0.model, 'claude-sonnet-4-6');
});

test('resolveRunConfig returns the per-workflow nodes+feedbacks maps', async () => {
  const p = await freshProject();
  await setNodeModel(p, 'wf_x', 's0_0', { model: 'claude-opus-4-8', effort: 'max' });
  await setFeedbackCycles(p, 'wf_x', 'fb_0', 2);
  const resolved = await resolveRunConfig(p, 'wf_x');
  assert.deepEqual(resolved.nodes.s0_0, { model: 'claude-opus-4-8', effort: 'max' });
  assert.deepEqual(resolved.feedbacks.fb_0, { maxCycles: 2 });
});

test('resolveRunConfig for an unconfigured workflow yields empty maps', async () => {
  const p = await freshProject();
  const resolved = await resolveRunConfig(p, 'wf_never');
  assert.deepEqual(resolved, { nodes: {}, feedbacks: {} });
});

test('setNodeModel clears a node when model and effort are both blank', async () => {
  const p = await freshProject();
  await setNodeModel(p, 'wf_x', 's0_0', { model: 'claude-opus-4-8', effort: 'high' });
  await setNodeModel(p, 'wf_x', 's0_0', { model: '', effort: '' });
  const rc = await readRunConfig(p);
  assert.equal(rc.workflows.wf_x?.nodes?.s0_0, undefined);
});

test('setFeedbackCycles coerces to an integer >= 1', async () => {
  const p = await freshProject();
  await setFeedbackCycles(p, 'wf_x', 'fb_0', 0);
  assert.equal((await readRunConfig(p)).workflows.wf_x.feedbacks.fb_0.maxCycles, 1);
});
```

- [ ] **Step 2: Run — expect FAIL (exports missing).**
```bash
node --test test/run-config.test.mjs
```
Expected: failure — `readRunConfig`/`setNodeModel`/… are not exported.

- [ ] **Step 3: Implement the run-config layer in `src/core/config.mjs`.** The legacy `readRaw`/`writeRaw`/`readConfig` strip unknown keys, so the run-config readers/writers must operate on the **raw file** directly (preserving legacy keys). Append to the end of `src/core/config.mjs`:
```js
// ── run-config: per-project model/effort/cycles for composed workflows ─────────
// Layered ON TOP of the legacy { steps, customModels } config in the SAME file.
// readRaw()/writeRaw() above intentionally drop unknown keys, so these helpers
// read and write the file directly to preserve `workflows` + `activeWorkflowId`
// alongside the sanitized legacy keys.

/** Read the whole config file untouched. Missing/corrupt => {}. Never throws. */
async function readWholeFile(projectDir) {
  try {
    const data = JSON.parse(await readFile(configFile(projectDir), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/** Atomically persist the whole config object. Creates <projectDir>/.maestro. */
async function writeWholeFile(projectDir, obj) {
  await mkdir(configDir(projectDir), { recursive: true });
  const file = configFile(projectDir);
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

/** Coerce a per-node selection to a clean {model?,effort?} or null (both blank). */
function cleanNodeSel(selection) {
  const model = typeof selection?.model === 'string' ? selection.model.trim() : '';
  const effort = typeof selection?.effort === 'string' ? selection.effort.trim() : '';
  if (!model && !effort) return null;
  return { ...(model && { model }), ...(effort && { effort }) };
}

/**
 * Read the full RunConfig: the sanitized legacy view (steps/customModels) plus
 * the run-config layer (workflows + activeWorkflowId). Missing => empty layer.
 * Never throws.
 * @param {string} projectDir
 * @returns {Promise<{steps:object,customModels:Array,workflows:object,activeWorkflowId?:string}>}
 */
export async function readRunConfig(projectDir) {
  const legacy = await readRaw(projectDir); // sanitized { steps, customModels }
  const whole = await readWholeFile(projectDir);
  const workflows =
    whole.workflows && typeof whole.workflows === 'object' ? whole.workflows : {};
  const out = { ...legacy, workflows };
  if (typeof whole.activeWorkflowId === 'string' && whole.activeWorkflowId.trim()) {
    out.activeWorkflowId = whole.activeWorkflowId.trim();
  }
  return out;
}

/** Get (creating as needed) the nested workflows[id] bucket on a raw config obj. */
function bucket(whole, workflowId) {
  if (!whole.workflows || typeof whole.workflows !== 'object') whole.workflows = {};
  if (!whole.workflows[workflowId] || typeof whole.workflows[workflowId] !== 'object') {
    whole.workflows[workflowId] = {};
  }
  const wf = whole.workflows[workflowId];
  if (!wf.nodes || typeof wf.nodes !== 'object') wf.nodes = {};
  if (!wf.feedbacks || typeof wf.feedbacks !== 'object') wf.feedbacks = {};
  return wf;
}

/**
 * Set (or clear) the model+effort for one node instance of a workflow. Both
 * blank => the node entry is removed. Writes preserve all other config keys.
 * @param {string} projectDir
 * @param {string} workflowId
 * @param {string} nodeId
 * @param {{model?:string,effort?:string}} selection
 * @returns {Promise<void>}
 */
export async function setNodeModel(projectDir, workflowId, nodeId, selection = {}) {
  const whole = await readWholeFile(projectDir);
  const wf = bucket(whole, workflowId);
  const sel = cleanNodeSel(selection);
  if (sel) wf.nodes[nodeId] = sel;
  else delete wf.nodes[nodeId];
  await writeWholeFile(projectDir, whole);
}

/**
 * Set the cycle count for one feedback loop of a workflow. Coerced to an integer
 * >= 1 (a loop runs at least once). Preserves all other config keys.
 * @param {string} projectDir
 * @param {string} workflowId
 * @param {string} fbId
 * @param {number} maxCycles
 * @returns {Promise<void>}
 */
export async function setFeedbackCycles(projectDir, workflowId, fbId, maxCycles) {
  const n = Math.max(1, Math.floor(Number(maxCycles) || 0) || 1);
  const whole = await readWholeFile(projectDir);
  const wf = bucket(whole, workflowId);
  wf.feedbacks[fbId] = { maxCycles: n };
  await writeWholeFile(projectDir, whole);
}

/**
 * Remember the last workflow selected in New Pipeline. Preserves other keys.
 * @param {string} projectDir
 * @param {string} workflowId
 * @returns {Promise<void>}
 */
export async function setActiveWorkflow(projectDir, workflowId) {
  const whole = await readWholeFile(projectDir);
  whole.activeWorkflowId = String(workflowId || '').trim();
  await writeWholeFile(projectDir, whole);
}

/**
 * Resolve just the run-config for one workflow into { nodes, feedbacks } maps
 * (the inputs resolveWorkflow overlays on the template). Unconfigured => empties.
 * @param {string} projectDir
 * @param {string} workflowId
 * @returns {Promise<{nodes:Record<string,{model?:string,effort?:string}>,feedbacks:Record<string,{maxCycles:number}>}>}
 */
export async function resolveRunConfig(projectDir, workflowId) {
  const rc = await readRunConfig(projectDir);
  const wf = rc.workflows[workflowId] || {};
  return {
    nodes: wf.nodes && typeof wf.nodes === 'object' ? wf.nodes : {},
    feedbacks: wf.feedbacks && typeof wf.feedbacks === 'object' ? wf.feedbacks : {},
  };
}
```

- [ ] **Step 4: Run — expect PASS, and confirm no legacy regressions.**
```bash
node --test test/run-config.test.mjs test/config.test.mjs
```
Expected: all run-config tests PASS and the existing `config.test.mjs` stays green (legacy `readConfig`/`setStep`/`resolveStepModels` untouched).

- [ ] **Step 5: Commit.**
```bash
git add src/core/config.mjs test/run-config.test.mjs
git commit -m "feat(config): per-project run-config layer (nodes/feedbacks/active)

readRunConfig/setNodeModel/setFeedbackCycles/setActiveWorkflow/
resolveRunConfig operate on the raw config file so workflows{} and
activeWorkflowId coexist with the legacy steps/customModels keys.
maxCycles coerced to >=1; blank node selection clears the entry.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `resolveWorkflow` (template + run-config + registry → ExecutablePlan)

**Files:**
- Modify `src/core/workflows.mjs` (replace the `resolveWorkflow` stub; add `agentsDir`/prompt+tools loading)
- Modify `test/workflows.test.mjs` (add resolveWorkflow tests)

- [ ] **Step 1: Add failing `resolveWorkflow` tests.** Append to `test/workflows.test.mjs`. (Reuse `freshHome`/`freshProject` from Task 1; import `setNodeModel`/`setFeedbackCycles` at the top of the file by editing the existing import block — shown inline here for clarity.) Add this import near the top of the test file:
```js
import { setNodeModel, setFeedbackCycles } from '../src/core/config.mjs';
```
Then append the tests:
```js
// Inline fake registry mirroring Phase 1's AgentMeta shape. agentFile values are
// the REAL agent prompt files on disk so prompt + tools load is exercised.
const REGISTRY = {
  planner: { key: 'planner', runnerType: 'producer', agentFile: 'maestro-planner.md', loopSource: false },
  refiner: { key: 'refiner', runnerType: 'producer', agentFile: 'maestro-plan-refiner.md', loopSource: true },
  implementer: { key: 'implementer', runnerType: 'producer', agentFile: 'maestro-implementer.md', loopSource: false },
  reviewer: { key: 'reviewer', runnerType: 'verifier', agentFile: 'maestro-code-reviewer.md', loopSource: true },
};

test('resolveWorkflow(default) yields a 4-step ExecutablePlan with prompts and default cycles', async () => {
  await freshHome();
  const p = await freshProject();
  const plan = await resolveWorkflow(p, 'wf_default', REGISTRY);
  assert.equal(plan.id, 'wf_default');
  assert.equal(plan.steps.length, 4);
  const flat = plan.steps.flat();
  assert.deepEqual(flat.map((n) => n.key), ['planner', 'refiner', 'implementer', 'reviewer']);
  // Each node carries the resolved runner + a non-empty agentPrompt from its file.
  for (const n of flat) {
    assert.ok(['producer', 'verifier'].includes(n.runnerType), `runnerType for ${n.key}`);
    assert.ok(typeof n.agentPrompt === 'string' && n.agentPrompt.length > 0, `prompt for ${n.key}`);
    assert.ok('model' in n && 'effort' in n, 'model/effort fields present');
    assert.ok(Array.isArray(n.tools), 'tools array present');
  }
  // loopSource flows through from the registry.
  assert.equal(flat.find((n) => n.key === 'reviewer').loopSource, true);
  assert.equal(flat.find((n) => n.key === 'planner').loopSource, false);
  // Feedbacks carry the gate + a default maxCycles of 5 (orchestrator parity).
  assert.equal(plan.feedbacks.length, 2);
  for (const f of plan.feedbacks) {
    assert.equal(f.gate, 'hasBlocking');
    assert.equal(f.maxCycles, 5);
  }
});

test('resolveWorkflow overlays per-project model/effort and feedback cycles', async () => {
  await freshHome();
  const p = await freshProject();
  await setNodeModel(p, 'wf_default', 's2_0', { model: 'claude-opus-4-8', effort: 'high' });
  await setFeedbackCycles(p, 'wf_default', 'fb_review', 2);
  const plan = await resolveWorkflow(p, 'wf_default', REGISTRY);
  const impl = plan.steps.flat().find((n) => n.nodeId === 's2_0');
  assert.equal(impl.model, 'claude-opus-4-8');
  assert.equal(impl.effort, 'high');
  const reviewFb = plan.feedbacks.find((f) => f.id === 'fb_review');
  assert.equal(reviewFb.maxCycles, 2);
});

test('resolveWorkflow resolves a saved template (incl. a parallel step)', async () => {
  await freshHome();
  const p = await freshProject();
  await writeWorkflow({
    id: 'wf_par',
    name: 'Parallel',
    steps: [
      [{ id: 'n_plan', key: 'planner' }],
      [{ id: 'n_impl', key: 'implementer' }, { id: 'n_refine', key: 'refiner' }], // parallel group
      [{ id: 'n_rev', key: 'reviewer' }],
    ],
    feedbacks: [{ id: 'fb_r', from: 'n_rev', to: 'n_impl' }],
  });
  const plan = await resolveWorkflow(p, 'wf_par', REGISTRY);
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.steps[1].length, 2); // the parallel group survives
  assert.deepEqual(plan.steps[1].map((n) => n.nodeId).sort(), ['n_impl', 'n_refine']);
  assert.equal(plan.feedbacks[0].from, 'n_rev');
  assert.equal(plan.feedbacks[0].to, 'n_impl');
});

test('resolveWorkflow throws for an unknown workflow id', async () => {
  await freshHome();
  const p = await freshProject();
  await assert.rejects(() => resolveWorkflow(p, 'wf_missing', REGISTRY), /wf_missing|not found|unknown/i);
});
```

- [ ] **Step 2: Run — expect FAIL.**
```bash
node --test test/workflows.test.mjs
```
Expected: resolveWorkflow tests FAIL (stub throws "not implemented").

- [ ] **Step 3: Implement `resolveWorkflow` (+ prompt/tools loading helpers).** In `src/core/workflows.mjs`, add the default-cycles constant and an agents-dir resolver near the top (after the imports), then replace the `resolveWorkflow` stub.

Add after the imports:
```js
/**
 * Default feedback cycle count when run-config does not override it. Matches the
 * orchestrator's maxRefineCycles/maxReviewCycles default of 5 so DEFAULT_WORKFLOW
 * reproduces today's gate timing.
 */
const DEFAULT_MAX_CYCLES = 5;

/** Default location of the agent prompt markdown files (mirrors orchestrator.mjs). */
const DEFAULT_AGENTS_DIR = new URL('../../agents/', import.meta.url).pathname;

/**
 * Read an agent prompt file and pull its declared tools from YAML frontmatter.
 * Returns { prompt, tools }. A missing file => { prompt:'', tools:[] } (fails
 * safe; the orchestrator already tolerates an empty agent body). The frontmatter
 * `tools:` line is a comma-separated list (matches agents/*.md convention).
 * @param {string} agentsDir
 * @param {string|null} agentFile
 * @returns {Promise<{prompt:string, tools:string[]}>}
 */
async function loadAgentFile(agentsDir, agentFile) {
  if (!agentFile) return { prompt: '', tools: [] };
  let text = '';
  try {
    text = await readFile(join(agentsDir, agentFile), 'utf8');
  } catch {
    return { prompt: '', tools: [] };
  }
  return { prompt: text, tools: parseFrontmatterTools(text) };
}

/** Extract a comma-separated `tools:` list from leading --- YAML frontmatter. */
function parseFrontmatterTools(text) {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  if (!m) return [];
  const line = m[1].split(/\r?\n/).find((l) => /^tools\s*:/.test(l));
  if (!line) return [];
  return line
    .replace(/^tools\s*:/, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
```

Then replace `export function resolveWorkflow(_projectDir, _workflowId, _registry) { throw new Error('not implemented'); }` with:
```js
/**
 * Merge a workflow template + the project's run-config + the agent registry into
 * an ExecutablePlan the dispatcher runs:
 *   { id, name, steps:[[Node]], feedbacks:[{id,from,to,maxCycles,gate}] }
 *   Node = { nodeId, key, runnerType, agentFile, agentPrompt, model, effort, tools, loopSource }
 * model/effort come from run-config (undefined when unset; the orchestrator folds
 * in the global fallback at dispatch). maxCycles defaults to DEFAULT_MAX_CYCLES.
 * @param {string} projectDir
 * @param {string} workflowId
 * @param {Record<string,object>} registry  loadAgentRegistry() output
 * @param {string} [agentsDir]  override for tests; defaults to ../../agents
 * @returns {Promise<object>} ExecutablePlan
 * @throws {Error} when the workflow id is unknown
 */
export async function resolveWorkflow(projectDir, workflowId, registry, agentsDir = DEFAULT_AGENTS_DIR) {
  const tpl = await readWorkflow(workflowId);
  if (!tpl) throw new Error(`workflow not found: ${workflowId}`);
  const reg = registry && typeof registry === 'object' ? registry : {};
  const { nodes: nodeCfg, feedbacks: fbCfg } = await resolveRunConfig(projectDir, workflowId);

  const steps = [];
  for (const group of tpl.steps) {
    const resolvedGroup = [];
    for (const node of group) {
      const meta = reg[node.key] || {};
      const { prompt, tools } = await loadAgentFile(agentsDir, meta.agentFile ?? null);
      const sel = nodeCfg[node.id] || {};
      resolvedGroup.push({
        nodeId: node.id,
        key: node.key,
        runnerType: meta.runnerType || 'producer',
        agentFile: meta.agentFile ?? null,
        agentPrompt: prompt,
        model: sel.model,            // undefined unless configured (folded later)
        effort: sel.effort,          // undefined unless configured
        tools,
        loopSource: !!meta.loopSource,
      });
    }
    steps.push(resolvedGroup);
  }

  const feedbacks = (Array.isArray(tpl.feedbacks) ? tpl.feedbacks : []).map((fb) => ({
    id: fb.id,
    from: fb.from,
    to: fb.to,
    maxCycles: Number(fbCfg[fb.id]?.maxCycles) > 0 ? Number(fbCfg[fb.id].maxCycles) : DEFAULT_MAX_CYCLES,
    gate: 'hasBlocking',
  }));

  return { id: tpl.id, name: tpl.name, steps, feedbacks };
}
```

- [ ] **Step 4: Run — expect PASS.**
```bash
node --test test/workflows.test.mjs
```
Expected: every workflows test (DEFAULT, CRUD, resolve, parallel, overlay) PASSes.

- [ ] **Step 5: Commit.**
```bash
git add src/core/workflows.mjs test/workflows.test.mjs
git commit -m "feat(workflows): resolveWorkflow -> ExecutablePlan

Merges template topology + per-project run-config + agent registry into
{id,name,steps:[[Node]],feedbacks}. Node carries runnerType/agentFile and
the agentPrompt + tools loaded from the agent file frontmatter; feedbacks
get gate=hasBlocking and maxCycles (default 5 for DEFAULT_WORKFLOW parity).
Parallel groups and run-config overrides pass through.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Full-suite green + offline smoke gate

**Files:**
- (no new files — verification only)

- [ ] **Step 1: Run the three new suites together.**
```bash
node --test test/workflows.test.mjs test/workflow-validator.test.mjs test/run-config.test.mjs
```
Expected: all PASS, 0 failures.

- [ ] **Step 2: Run the WHOLE test suite to confirm no regressions in legacy config/projects.**
```bash
node --test test/*.mjs
```
Expected: green (the run-config additions left `readConfig`/`setStep`/`resolveStepModels` and `projects.mjs`/`maestroHome` behavior unchanged).

- [ ] **Step 3: Confirm the offline smoke still passes (default-workflow parity gate for this phase's data layer).**
```bash
MAESTRO_MOCK=1 npm run smoke
```
Expected: PASS. (The orchestrator still runs its hardcoded path in this phase; the smoke guards that nothing in `config.mjs`/new modules broke the existing run. The dispatcher swap that consumes `resolveWorkflow` lands in a later phase.)

- [ ] **Step 4: Commit any incidental fixes surfaced by the full suite (only if needed).**
```bash
git add -A
git commit -m "test(workflows): full-suite + offline smoke green for the data layer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Phase 3: Data-driven dispatcher: runner registry, parallel steps, generic feedback loop

> **Goal.** Replace the orchestrator's hardcoded `Plan → Refine → Implement → Review` sequence (`orchestrator.mjs` `run()` L222–256) and its two bespoke loops (`_refineLoop` L331–389, `_reviewLoop` L395–459) with a **data-driven dispatcher** that executes an `ExecutablePlan` (from `resolveWorkflow`, built in Phase 1/2): it walks `plan.steps` in order, runs parallel groups via `Promise.all`, tags every emit with `{nodeId, stepIndex, cycle}`, and drives a single **generic feedback loop** (`_runLoop`) that rewinds the execution pointer when a `loopSource` verifier returns blocking issues. `DEFAULT_WORKFLOW` (id `wf_default`) routes through the *same* dispatcher and reproduces today's gates/cycle-counts exactly — protected by a regression test and `MAESTRO_MOCK=1 npm run smoke`.
>
> **Dependencies (built in earlier phases — read but do not author here):**
> - `src/core/agent-registry.mjs` → `loadAgentRegistry()` (Phase 1).
> - `src/core/workflows.mjs` → `DEFAULT_WORKFLOW`, `resolveWorkflow(projectDir, workflowId, registry)` → `ExecutablePlan` (Phase 2).
> - `src/core/config.mjs` → `resolveRunConfig`/`readRunConfig` (Phase 2).
> - `ExecutablePlan` shape (CONTRACT): `{ id, name, steps: Array<Array<Node>>, feedbacks: Array<{id,from,to,maxCycles,gate:"hasBlocking"}> }`; `Node: { nodeId, key, runnerType, agentFile, agentPrompt, model, effort, tools, loopSource }`.
>
> **What this phase OWNS:** `src/core/runners.mjs`, `src/core/orchestrator.mjs` (rework `run()` + replace both loops + event tagging + cost attribution), `src/core/phases.mjs` (add the two new-agent runner bodies, reuse existing runners), `test/runners.test.mjs`, `test/dispatcher.test.mjs`.
>
> **Anchors verified by reading:** `_phaseCtx(role)` (`orchestrator.mjs:525-547`) keys `stepModels[role]` and wires `onEvent:(e)=>this._onAgentEvent(role,e)` + `claudeOpts:{model,effort,...}`; `_onAgentEvent` (`:550-578`) records cost via `this.state.phase`/`this.state.cycle`; `_phase`/`_recordStep` (`:710-740`) key steps `cycle ? "phase#cycle" : "phase"` and `_recordCost` (`:753-765`) reuses that key — **a single-active-step assumption that parallel steps break, so cost/step keys move to be node-aware.** `runOpts` (`phases.mjs:79-97`) maps `ctx.claudeOpts → runClaude`. `protocol.mjs` `SEVERITIES` (`:15`), review shape (`:208-222`), `hasBlocking`/`blockingIssues` (`:245-258`). `runClaude` MOCK keys off `MOCK_ROLE`/`MOCK_CYCLE` markers (`claude-runner.mjs:284-381`); the mock decreases blocking issues with `cycle` so loops terminate (`:488-517`, `:573-596`).
>
> **MOCK_ROLE invariant (must hold for smoke green):** the mock dispatches solely on `MOCK_ROLE ∈ {planner-clarify, planner-plan, refiner, implementer, reviewer}`. The new dispatcher MUST keep emitting those exact role strings for the default-workflow nodes; the two NEW agents get NEW mock roles added to `claude-runner.mjs` in Task 3 so their nodes are deterministic offline.

---

### Task 1: Runner registry wrapping the existing phase runners (`producer` / `verifier`)

Create `src/core/runners.mjs`: a registry `runners = { producer, verifier }` where each entry is `async (ctx) => RunnerResult`. It dispatches on `ctx.node.key` (canonical agent key) + `ctx.mode`, calls the **existing** `phases.mjs` exports, and normalizes their return into the contracted `RunnerResult` `{ status:"ok"|"blocked", issues?, summary?, review?, planPath?, outPlanPath? }`. `status` is derived from `protocol.hasBlocking` for verifiers; producers are always `ok`.

**Files:**
- `src/core/runners.mjs` (create)
- `test/runners.test.mjs` (create)

- [ ] **Step 1: Write the failing test `test/runners.test.mjs`.** Drives both runner types through MOCK against a tmp dir, asserting the normalized shape + status derivation.
```javascript
// test/runners.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runners } from '../src/core/runners.mjs';

const tmpDirs = [];
async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-runners-'));
  tmpDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

// Minimal ctx mirroring orchestrator._nodeCtx: a node + the fields phases.mjs reads.
function ctxFor(dir, node, extra = {}) {
  return {
    projectDir: dir,
    pipelineDir: dir,
    taskPrompt: 'demo task',
    toolInstruction: '',
    agentPrompts: { planner: '', refiner: '', implementer: '', reviewer: '' },
    checkpointRef: null,
    signal: undefined,
    onEvent: () => {},
    claudeOpts: { mock: true },
    node,
    nodeId: node.nodeId,
    stepIndex: 0,
    cycle: 1,
    ...extra,
  };
}

test('runners registry exposes exactly producer and verifier', () => {
  assert.deepEqual(Object.keys(runners).sort(), ['producer', 'verifier']);
  assert.equal(typeof runners.producer, 'function');
  assert.equal(typeof runners.verifier, 'function');
});

test('producer(planner) writes a plan and returns status ok with planPath', async () => {
  const dir = await makeTmpDir();
  const node = { nodeId: 's0_0', key: 'planner', runnerType: 'producer', loopSource: false };
  const res = await runners.producer(ctxFor(dir, node, {
    planFilePath: join(dir, 'plan.md'),
    baseName: 'feature',
    answers: [],
  }));
  assert.equal(res.status, 'ok');
  assert.equal(res.planPath, join(dir, 'plan.md'));
});

test('producer(implementer) returns status ok with a summary', async () => {
  const dir = await makeTmpDir();
  const node = { nodeId: 's1_0', key: 'implementer', runnerType: 'producer', loopSource: false };
  const res = await runners.producer(ctxFor(dir, node, {
    planPath: join(dir, 'plan.md'),
    mode: 'implement',
  }));
  assert.equal(res.status, 'ok');
  assert.ok(typeof res.summary === 'string' && res.summary.length > 0);
});

test('verifier(reviewer) cycle 1 is blocked, cycle 2 is ok (mock decreases severity)', async () => {
  const dir = await makeTmpDir();
  const node = { nodeId: 's3_0', key: 'reviewer', runnerType: 'verifier', loopSource: true };
  const blocked = await runners.verifier(ctxFor(dir, node, {
    planPath: join(dir, 'plan.md'),
    reviewMdPath: join(dir, 'review.md'),
    reviewJsonPath: join(dir, 'review-c1.json'),
    cycle: 1,
  }));
  assert.equal(blocked.status, 'blocked', 'cycle 1 reviewer has a major issue');
  assert.ok(Array.isArray(blocked.issues) && blocked.issues.length >= 1);
  assert.ok(blocked.review, 'carries the raw protocol review');

  const ok = await runners.verifier(ctxFor(dir, node, {
    planPath: join(dir, 'plan.md'),
    reviewMdPath: join(dir, 'review.md'),
    reviewJsonPath: join(dir, 'review-c2.json'),
    cycle: 2,
  }));
  assert.equal(ok.status, 'ok', 'cycle 2 reviewer has only a suggestion');
});

test('verifier(reviewer) reading a pre-written blocking review reports blocked', async () => {
  const dir = await makeTmpDir();
  // Pre-seed the json the mock would otherwise create; status must come from protocol.hasBlocking.
  const jsonPath = join(dir, 'pre.json');
  await writeFile(
    jsonPath,
    JSON.stringify({ issues: [{ severity: 'critical', title: 't', detail: 'd', location: 'l' }], summary: 's' }),
    'utf8',
  );
  const node = { nodeId: 's3_0', key: 'reviewer', runnerType: 'verifier', loopSource: true };
  // cycle 1 mock overwrites with a major anyway; assert blocked regardless.
  const res = await runners.verifier(ctxFor(dir, node, {
    planPath: join(dir, 'plan.md'),
    reviewMdPath: join(dir, 'review.md'),
    reviewJsonPath: jsonPath,
    cycle: 1,
  }));
  assert.equal(res.status, 'blocked');
});

test('unknown producer key throws a clear error', async () => {
  const dir = await makeTmpDir();
  const node = { nodeId: 'x', key: 'nope', runnerType: 'producer', loopSource: false };
  await assert.rejects(() => runners.producer(ctxFor(dir, node)), /unknown producer agent "nope"/);
});
```

- [ ] **Step 2: Run it — expect FAIL (module missing).**
```bash
MAESTRO_MOCK=1 node --test test/runners.test.mjs
```
Expect: `Cannot find module '.../src/core/runners.mjs'` (or "Error [ERR_MODULE_NOT_FOUND]").

- [ ] **Step 3: Implement `src/core/runners.mjs`.** Wrap the existing `phases.mjs` exports; derive `status` via `protocol.hasBlocking`; pass through `blockingIssues` as `issues`. The producer's `refiner` branch ALSO returns the review (a refiner emits a verdict but does not gate by default in the default workflow — only the explicit `loopSource` reviewer does).
```javascript
// src/core/runners.mjs
// Runner registry: maps an agent's runnerType -> a function the dispatcher calls.
//
// There are exactly two runner types (CONTRACT):
//   - producer : generates artifacts/code (Plan, Refine, Implement, Manual Tests
//                Checklist). Always returns status "ok"; may carry a review.
//   - verifier : emits a protocol.mjs review verdict (Review, Manual web UI
//                testing). status is "blocked" iff the review has blocking
//                (critical/major) issues; eligible as a loopSource.
//
// Each runner receives the orchestrator's node ctx (see Orchestrator._nodeCtx):
//   { projectDir, pipelineDir, taskPrompt, toolInstruction, agentPrompts,
//     checkpointRef, signal, onEvent, claudeOpts:{model,effort,mock,...},
//     node:{nodeId,key,runnerType,loopSource,...}, nodeId, stepIndex, cycle,
//     ...per-call fields the dispatcher threads in (planPath, planFilePath,
//        reviewMdPath, reviewJsonPath, outPlanPath, inPlanPath, baseName,
//        answers, reviewPath, mode) }
//
// New agents pick an existing runnerType and need NO engine code; a genuinely new
// behavior = add one branch (or one runner) here.

import {
  runPlannerPlan,
  runRefiner,
  runImplementer,
  runReviewer,
  runManualTestsChecklist,
  runManualWebUiTesting,
} from './phases.mjs';
import { hasBlocking, blockingIssues } from './protocol.mjs';

/** Normalize a protocol review into the RunnerResult verdict fields. */
function verdict(review) {
  return {
    status: hasBlocking(review) ? 'blocked' : 'ok',
    issues: blockingIssues(review),
    review,
    summary: review?.summary || '',
  };
}

/**
 * producer — generates artifacts/code. Dispatches on the canonical agent key.
 * Always status "ok" (producers do not gate); the refiner additionally surfaces
 * its review so a workflow MAY hang a loop off it, but default routing does not.
 * @param {object} ctx node ctx from the orchestrator
 * @returns {Promise<{status:'ok', summary?:string, planPath?:string, outPlanPath?:string, review?:object}>}
 */
async function producer(ctx) {
  const key = ctx?.node?.key;
  switch (key) {
    case 'planner': {
      const { planPath } = await runPlannerPlan(ctx, {
        answers: ctx.answers || [],
        planFilePath: ctx.planFilePath,
        baseName: ctx.baseName,
      });
      return { status: 'ok', planPath, summary: 'Plan written.' };
    }
    case 'refiner': {
      const { outPlanPath, review } = await runRefiner(ctx, {
        inPlanPath: ctx.inPlanPath,
        outPlanPath: ctx.outPlanPath,
        cycle: ctx.cycle,
        reviewJsonPath: ctx.reviewJsonPath,
      });
      // A producer never blocks; expose the review (+ issues) for loop wiring.
      return { status: 'ok', outPlanPath, review, issues: blockingIssues(review), summary: review?.summary || '' };
    }
    case 'implementer': {
      const { summary } = await runImplementer(ctx, {
        planPath: ctx.planPath,
        reviewPath: ctx.reviewPath,
        mode: ctx.mode || 'implement',
      });
      return { status: 'ok', summary };
    }
    case 'manualTestsChecklist': {
      const { checklistPath, summary } = await runManualTestsChecklist(ctx, {
        planPath: ctx.planPath,
        checklistPath: ctx.checklistPath,
      });
      return { status: 'ok', checklistPath, summary };
    }
    default:
      throw new Error(`unknown producer agent "${key}"`);
  }
}

/**
 * verifier — emits a protocol review verdict. status "blocked" iff the review has
 * blocking issues. Eligible as a loopSource.
 * @param {object} ctx node ctx from the orchestrator
 * @returns {Promise<{status:'ok'|'blocked', issues:Array, review:object, summary:string}>}
 */
async function verifier(ctx) {
  const key = ctx?.node?.key;
  switch (key) {
    case 'reviewer': {
      const { review } = await runReviewer(ctx, {
        planPath: ctx.planPath,
        reviewMdPath: ctx.reviewMdPath,
        reviewJsonPath: ctx.reviewJsonPath,
        cycle: ctx.cycle,
      });
      return verdict(review);
    }
    case 'manualWebUiTesting': {
      const { review } = await runManualWebUiTesting(ctx, {
        checklistPath: ctx.checklistPath,
        reviewMdPath: ctx.reviewMdPath,
        reviewJsonPath: ctx.reviewJsonPath,
        cycle: ctx.cycle,
      });
      return verdict(review);
    }
    default:
      throw new Error(`unknown verifier agent "${key}"`);
  }
}

/** The runner registry: runnerType -> async (ctx) => RunnerResult. */
export const runners = { producer, verifier };
```

- [ ] **Step 4: Run the test — expect FAIL on the two new-agent imports.** `runners.mjs` imports `runManualTestsChecklist`/`runManualWebUiTesting` which Task 3 adds. Confirm the *failure reason* is the missing export (not a logic bug):
```bash
MAESTRO_MOCK=1 node --test test/runners.test.mjs 2>&1 | head -20
```
Expect: `SyntaxError: The requested module './phases.mjs' does not provide an export named 'runManualTestsChecklist'`. (Tasks 2–3 add the bodies; this task's logic is complete and re-greens after Task 3. Do NOT stub here — keep the registry honest.)

- [ ] **Step 5: Commit.**
```bash
git add src/core/runners.mjs test/runners.test.mjs
git commit -m "feat(runners): registry wrapping phase runners under producer/verifier

Maps runnerType -> fn; verifier status derives from protocol.hasBlocking.
New-agent runner bodies land in phases.mjs next; tests go green after.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Manual Tests Checklist producer body in `phases.mjs`

Add `runManualTestsChecklist(ctx, {planPath, checklistPath})` — a `producer` that writes a markdown checklist artifact. Mirrors `runImplementer`'s structure (header + body + MOCK markers); emits new mock role `manual-tests-checklist` (wired in Task 3).

**Files:**
- `src/core/phases.mjs` (modify — add exported runner near `runReviewer`, `:274`)
- `test/runners.test.mjs` (modify — add a producer(manualTestsChecklist) case)

- [ ] **Step 1: Add the failing test case to `test/runners.test.mjs`** (append before the `unknown producer` test):
```javascript
test('producer(manualTestsChecklist) writes a checklist and returns ok', async () => {
  const dir = await makeTmpDir();
  const node = { nodeId: 's4_0', key: 'manualTestsChecklist', runnerType: 'producer', loopSource: false };
  const res = await runners.producer(ctxFor(dir, node, {
    planPath: join(dir, 'plan.md'),
    checklistPath: join(dir, 'manual-tests-checklist.md'),
  }));
  assert.equal(res.status, 'ok');
  assert.equal(res.checklistPath, join(dir, 'manual-tests-checklist.md'));
  const body = await import('node:fs/promises').then((fs) => fs.readFile(res.checklistPath, 'utf8'));
  assert.match(body, /Manual Test/i);
});
```

- [ ] **Step 2: Run — expect FAIL (export missing).**
```bash
MAESTRO_MOCK=1 node --test test/runners.test.mjs 2>&1 | grep -m1 "runManualTestsChecklist"
```
Expect a `does not provide an export named 'runManualTestsChecklist'` line (also `runManualWebUiTesting` until Task 3).

- [ ] **Step 3: Implement `runManualTestsChecklist` in `phases.mjs`.** Insert this exported function immediately after `runReviewer` (after `phases.mjs:313`):
```javascript
/**
 * Manual Tests Checklist — producer. Reads the plan (and any implementation diff)
 * and writes a markdown checklist of manual test cases as a pipeline artifact.
 * Returns { checklistPath, summary }.
 * @param {import('./phases.mjs').PhaseContext} ctx
 * @param {{ planPath: string, checklistPath: string }} opts
 */
export async function runManualTestsChecklist(ctx, opts) {
  const { planPath, checklistPath } = opts || {};
  const role = 'manual-tests-checklist';
  const systemPrompt = buildSystemPrompt(
    ctx.toolInstruction,
    ctx.agentPrompts?.manualTestsChecklist,
    role,
  );
  const prompt =
    taskHeader(ctx, 'Draft a manual test checklist') +
    '\n## What to do\n\n' +
    'Read the implementation plan and the implemented changes (via `git diff` in your cwd), ' +
    'then write a markdown checklist of concrete manual test cases a human can run against the ' +
    'app. Each case: a `- [ ]` line with steps and the expected result.\n\n' +
    `Plan: ${planPath}\n` +
    `Write the checklist markdown to: ${checklistPath}\n\n` +
    mockMarkers({ MOCK_ROLE: role, MOCK_OUT: checklistPath, MOCK_IN: planPath });

  const { text } = await runClaude(
    runOpts(ctx, { role, prompt, systemPrompt, allowedTools: READ_WRITE_TOOLS }),
  );

  const summary = (text || '').trim() || 'Manual test checklist written.';
  return { checklistPath, summary };
}
```
Add the inline fallback so a missing `.md` body never yields an empty system prompt — extend `FALLBACK_PROMPTS` (`phases.mjs:27`) with:
```javascript
  'manual-tests-checklist':
    'You are the Manual Tests author. Read the plan and the implemented diff, then write a ' +
    'markdown checklist of manual test cases (each a `- [ ]` line with steps + expected result) ' +
    'to the path given in the task.',
```

- [ ] **Step 4: Run — still FAILs only on `runManualWebUiTesting`.**
```bash
MAESTRO_MOCK=1 node --test test/runners.test.mjs 2>&1 | grep -m1 "runManualWebUiTesting"
```
Expect the missing-export line for `runManualWebUiTesting` (Task 3). The checklist test itself cannot pass until the mock role exists (Task 3 adds it) — that is expected; this task only adds the runner + fallback.

- [ ] **Step 5: Commit.**
```bash
git add src/core/phases.mjs test/runners.test.mjs
git commit -m "feat(phases): add Manual Tests Checklist producer body

Writes a markdown manual-test checklist artifact via the shared runClaude path;
emits new mock role manual-tests-checklist (wired next).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Manual web UI testing verifier body + mock roles for both new agents

Add `runManualWebUiTesting(ctx, ...)` — a `verifier` (loopSource) emitting the `protocol.mjs` review verdict. Then teach the offline mock (`claude-runner.mjs`) the two new roles so both new-agent nodes are deterministic under `MAESTRO_MOCK=1` (checklist writes a file; web-ui emits a cycle-decreasing verdict like `mockReviewer`). This re-greens `test/runners.test.mjs` end-to-end.

**Files:**
- `src/core/phases.mjs` (modify — add `runManualWebUiTesting` after Task 2's runner)
- `src/core/claude-runner.mjs` (modify — add 2 mock roles: `:342-361` switch + 2 mock fns)

- [ ] **Step 1: Add the failing verifier test to `test/runners.test.mjs`** (append before `unknown producer`):
```javascript
test('verifier(manualWebUiTesting) cycle 1 blocked, cycle 2 ok (mock decreases severity)', async () => {
  const dir = await makeTmpDir();
  const node = { nodeId: 's5_0', key: 'manualWebUiTesting', runnerType: 'verifier', loopSource: true };
  const c1 = await runners.verifier(ctxFor(dir, node, {
    checklistPath: join(dir, 'checklist.md'),
    reviewMdPath: join(dir, 'webui.md'),
    reviewJsonPath: join(dir, 'webui-c1.json'),
    cycle: 1,
  }));
  assert.equal(c1.status, 'blocked');
  const c2 = await runners.verifier(ctxFor(dir, node, {
    checklistPath: join(dir, 'checklist.md'),
    reviewMdPath: join(dir, 'webui.md'),
    reviewJsonPath: join(dir, 'webui-c2.json'),
    cycle: 2,
  }));
  assert.equal(c2.status, 'ok');
});
```

- [ ] **Step 2: Run — expect FAIL (export missing).**
```bash
MAESTRO_MOCK=1 node --test test/runners.test.mjs 2>&1 | grep -m1 "runManualWebUiTesting"
```
Expect `does not provide an export named 'runManualWebUiTesting'`.

- [ ] **Step 3: Implement `runManualWebUiTesting` in `phases.mjs`** (insert right after `runManualTestsChecklist`):
```javascript
/**
 * Manual web UI testing — verifier (loopSource). Drives the running web UI through
 * the manual checklist (Playwright MCP, declared in the agent frontmatter) and
 * emits the protocol review verdict JSON. Returns { review }.
 * @param {import('./phases.mjs').PhaseContext} ctx
 * @param {{ checklistPath: string, reviewMdPath: string, reviewJsonPath: string, cycle: number }} opts
 */
export async function runManualWebUiTesting(ctx, opts) {
  const { checklistPath, reviewMdPath, reviewJsonPath, cycle } = opts || {};
  const role = 'manual-web-ui-testing';
  const systemPrompt = buildSystemPrompt(
    ctx.toolInstruction,
    ctx.agentPrompts?.manualWebUiTesting,
    role,
  );
  const prompt =
    taskHeader(ctx, `Run the manual web UI tests (cycle ${cycle})`) +
    '\n## What to do\n\n' +
    'Execute the manual test checklist against the running web UI using the Playwright tools. ' +
    'Write a human-readable result markdown AND a machine-readable review JSON.\n\n' +
    `Checklist to run: ${checklistPath}\n` +
    `Write the result markdown to: ${reviewMdPath}\n` +
    `Write the review JSON to: ${reviewJsonPath}\n\n` +
    'The review JSON shape is { "issues": [ { "severity", "title", "detail", "location" } ], ' +
    '"summary" }. Use severities critical|major|minor|suggestion; only critical/major block the ' +
    'pipeline (a failing manual case is at least major).\n\n' +
    mockMarkers({
      MOCK_ROLE: role,
      MOCK_OUT: reviewMdPath,
      MOCK_JSON: reviewJsonPath,
      MOCK_CYCLE: cycle,
    });

  await runClaude(runOpts(ctx, { role, prompt, systemPrompt, allowedTools: READ_WRITE_TOOLS }));

  const review = await readReview(reviewJsonPath);
  return { review };
}
```
Extend `FALLBACK_PROMPTS` (`phases.mjs:27`) with:
```javascript
  'manual-web-ui-testing':
    'You are the Manual Web UI Tester. Run each case in the manual checklist against the live ' +
    'web UI using the Playwright tools, then write a result markdown AND a review JSON ' +
    '({ "issues": [ { "severity", "title", "detail", "location" } ], "summary" }). Use severities ' +
    'critical|major|minor|suggestion; a failing case is at least major.',
```

- [ ] **Step 4: Add the two mock roles to `claude-runner.mjs`.** Extend the `switch (role)` in `runMock` (`claude-runner.mjs:342-361`) — insert before `default:`:
```javascript
    case 'manual-tests-checklist':
      text = await mockManualTestsChecklist(m, onEvent);
      break;
    case 'manual-web-ui-testing':
      text = await mockManualWebUiTesting(m, cycle, onEvent);
      break;
```
Then add the two mock functions (place after `mockReviewer`, after `claude-runner.mjs:617`):
```javascript
async function mockManualTestsChecklist(m, onEvent) {
  const out = m.MOCK_OUT;
  await emitLog(onEvent, '[mock] manual-tests author drafting checklist');
  if (!out) return '[mock] manual-tests-checklist: no MOCK_OUT given';
  const md =
    `# Manual Test Checklist\n\n` +
    `- [ ] App boots without errors — open the app; expect no console errors.\n` +
    `- [ ] Core flow works — exercise the new feature; expect the documented result.\n` +
    `- [ ] Invalid input is handled — submit bad input; expect a clear error.\n`;
  await ensureDir(out);
  await writeFile(out, md, 'utf8');
  safeEmit(onEvent, { type: 'tool_use', text: `wrote ${out}`, raw: { mock: true, file: out } });
  return `[mock] manual checklist written to ${out}`;
}

async function mockManualWebUiTesting(m, cycle, onEvent) {
  const mdPath = m.MOCK_OUT;
  const jsonPath = m.MOCK_JSON;
  await emitLog(onEvent, `[mock] manual web UI testing run (cycle ${cycle})`);
  // Cycle 1: one major (a case fails). Cycle >=2: only a suggestion. Terminates by cycle 2.
  const review =
    cycle <= 1
      ? {
          summary: 'One manual case failed in the live UI.',
          issues: [
            {
              severity: 'major',
              title: 'Core flow case failed',
              detail: 'The documented result did not appear when exercising the feature.',
              location: 'manual-tests-checklist.md',
            },
          ],
        }
      : {
          summary: 'All manual cases passed.',
          issues: [
            {
              severity: 'suggestion',
              title: 'Add an accessibility pass',
              detail: 'Consider a keyboard-only walkthrough next time.',
              location: 'manual-tests-checklist.md',
            },
          ],
        };
  if (mdPath) {
    const md =
      `# Manual Web UI Test Result (cycle ${cycle})\n\n## Summary\n\n${review.summary}\n\n## Issues\n\n` +
      review.issues.map((i) => `- **[${i.severity}]** ${i.title} — ${i.detail} (\`${i.location}\`)`).join('\n') +
      '\n';
    await ensureDir(mdPath);
    await writeFile(mdPath, md, 'utf8');
    safeEmit(onEvent, { type: 'tool_use', text: `wrote ${mdPath}`, raw: { mock: true, file: mdPath } });
  }
  if (jsonPath) {
    await ensureDir(jsonPath);
    await writeFile(jsonPath, JSON.stringify(review, null, 2) + '\n', 'utf8');
    safeEmit(onEvent, { type: 'tool_use', text: `wrote ${jsonPath}`, raw: { mock: true, file: jsonPath } });
  }
  return JSON.stringify(review);
}
```

- [ ] **Step 5: Run the FULL runners suite — expect PASS.**
```bash
MAESTRO_MOCK=1 node --test test/runners.test.mjs
```
Expect: all tests pass (registry shape, producer plan/implementer/checklist, verifier reviewer/web-ui cycle gating, unknown-key error).

- [ ] **Step 6: Commit.**
```bash
git add src/core/phases.mjs src/core/claude-runner.mjs test/runners.test.mjs
git commit -m "feat(phases): Manual web UI testing verifier + offline mock roles

Adds runManualWebUiTesting (loopSource verifier) and deterministic MAESTRO_MOCK
roles for both new agents; runners.test.mjs now green end-to-end.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Node-aware ctx + cost/step attribution (foundation for parallel)

Before the dispatcher can run parallel groups, the per-step cost/clock machinery must stop assuming a single active step. Refactor `orchestrator.mjs` so a node's events are attributed by a **node-derived step key** carried on the ctx, not by the live `state.phase`/`state.cycle`. Add `_nodeCtx(node, {stepIndex, cycle})` extending `_phaseCtx`, and make `_onAgentEvent`/`_recordCost` accept an explicit step key.

**Files:**
- `src/core/orchestrator.mjs` (modify — `_phaseCtx` `:525-547`, `_onAgentEvent` `:550-578`, `_recordCost` `:753-765`)
- `test/dispatcher.test.mjs` (create — start it here with the cost-attribution unit; grows in Task 6)

- [ ] **Step 1: Write the failing foundation test `test/dispatcher.test.mjs`.** Asserts a node ctx tags emits and attributes cost to the node's own step key even when it is NOT the live phase.
```javascript
// test/dispatcher.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from '../src/core/orchestrator.mjs';

const tmpDirs = [];
async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-dispatch-'));
  tmpDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

test('_nodeCtx tags every emit with nodeId/stepIndex/cycle', () => {
  const orch = createOrchestrator({ projectDir: '/tmp/proj' });
  orch.pipeline = { id: 'x', dir: '/tmp/proj', promptText: 'demo' };
  const node = { nodeId: 's2_1', key: 'implementer', runnerType: 'producer' };
  const tagged = [];
  orch.on('log', (l) => tagged.push(l));
  const ctx = orch._nodeCtx(node, { stepIndex: 2, cycle: 3 });
  ctx.onEvent({ type: 'assistant', text: 'hi', raw: {} });
  assert.equal(tagged.length, 1);
  assert.equal(tagged[0].nodeId, 's2_1');
  assert.equal(tagged[0].stepIndex, 2);
  assert.equal(tagged[0].cycle, 3);
});

test('cost is attributed to the node step key, not the live phase', () => {
  const orch = createOrchestrator({ projectDir: '/tmp/proj' });
  orch.pipeline = { id: 'x', dir: '/tmp/proj', promptText: 'demo' };
  // Open TWO node steps (simulating an in-flight parallel group).
  const nodeA = { nodeId: 'p_a', key: 'implementer', runnerType: 'producer' };
  const nodeB = { nodeId: 'p_b', key: 'reviewer', runnerType: 'verifier' };
  orch._nodeStep(nodeA, 0, 1, 'start');
  orch._nodeStep(nodeB, 0, 1, 'start');
  const ctxA = orch._nodeCtx(nodeA, { stepIndex: 0, cycle: 1 });
  const ctxB = orch._nodeCtx(nodeB, { stepIndex: 0, cycle: 1 });
  // Interleaved result events — must land on their OWN node, not whoever is "live".
  ctxB.onEvent({ type: 'result', costUsd: 0.05, raw: { type: 'result' } });
  ctxA.onEvent({ type: 'result', costUsd: 0.02, raw: { type: 'result' } });
  const st = orch.getState();
  const keyA = orch._stepKeyFor(nodeA, 0, 1);
  const keyB = orch._stepKeyFor(nodeB, 0, 1);
  assert.equal(st.steps.find((s) => s.key === keyA).costUsd, 0.02);
  assert.equal(st.steps.find((s) => s.key === keyB).costUsd, 0.05);
  assert.equal(st.totalCostUsd, 0.07);
});
```

- [ ] **Step 2: Run — expect FAIL.**
```bash
node --test test/dispatcher.test.mjs 2>&1 | grep -m1 "_nodeCtx\|_nodeStep\|is not a function"
```
Expect: `orch._nodeCtx is not a function` (and `_nodeStep`/`_stepKeyFor`).

- [ ] **Step 3: Add node-aware helpers to `orchestrator.mjs`.** Keep `_phaseCtx` intact (the parity wrapper for the default workflow uses it indirectly via `_nodeCtx`). Insert after `_phaseCtx` (`:547`):
```javascript
  /**
   * Stable step key for a node occurrence. Parallel nodes in the same step share
   * stepIndex but differ by nodeId; loop re-runs differ by cycle. Format keeps the
   * legacy `phase#cycle` readability while staying unique per node:
   *   "<stepIndex>:<nodeId>#<cycle>"  (cycle omitted when 1 and not a loop re-run)
   */
  _stepKeyFor(node, stepIndex, cycle) {
    const c = Number(cycle) > 1 ? `#${cycle}` : '';
    return `${stepIndex}:${node.nodeId}${c}`;
  }

  /**
   * Node execution context. Extends the legacy _phaseCtx shape but is keyed by the
   * node (model/effort come from the resolved plan node, not a role lookup) and
   * tags every emit + cost with { nodeId, stepIndex, cycle } so parallel/looped
   * emits are attributable. `node.agentKeyForPrompt` lets a node reuse an existing
   * agent's prompt body (the default-workflow nodes set this to their role).
   * @param {object} node    plan Node { nodeId, key, runnerType, model, effort, ... }
   * @param {{stepIndex:number, cycle:number}} pos
   */
  _nodeCtx(node, pos = {}) {
    const stepIndex = Number(pos.stepIndex) || 0;
    const cycle = Number(pos.cycle) > 0 ? Number(pos.cycle) : 1;
    const stepKey = this._stepKeyFor(node, stepIndex, cycle);
    return {
      projectDir: this.projectDir,
      pipelineDir: this.pipeline.dir,
      taskPrompt: this.pipeline.promptText,
      toolInstruction: this.toolInstruction,
      agentPrompts: this.agentPrompts,
      checkpointRef: this.checkpointRef,
      signal: this.abort.signal,
      node,
      nodeId: node.nodeId,
      stepIndex,
      cycle,
      onEvent: (e) => this._onAgentEvent(node.key, e, { nodeId: node.nodeId, stepIndex, cycle, stepKey }),
      claudeOpts: {
        bin: this.claude.bin,
        permissionMode: this.claude.permissionMode,
        model: node.model || this.claude.model, // per-node, falling back to global
        effort: node.effort,                     // per-node effort (undefined when unset)
        mock: this.claude.mock,
      },
    };
  }

  /**
   * Record/transition a node's step (parallel-safe analogue of _recordStep). The
   * key is the node-derived stepKey so concurrent nodes never collide. On 'start'
   * it does NOT pause sibling clocks (parallel nodes run simultaneously); on a
   * terminal marker it folds just this node's clock.
   */
  _nodeStep(node, stepIndex, cycle, status) {
    const key = this._stepKeyFor(node, stepIndex, cycle);
    const now = new Date().toISOString();
    let step = this.state.steps.find((s) => s.key === key);
    if (!step) {
      step = {
        key, phase: node.key, nodeId: node.nodeId, stepIndex, cycle,
        status, startedAt: now, updatedAt: now, activeMs: 0, runningSince: null,
      };
      this.state.steps.push(step);
    } else {
      step.status = status;
      step.updatedAt = now;
    }
    if (status === 'start') this._clockResume(key);
    else this._clockPause(key);
    this.state.totalActiveMs = sumStepActive(this.state.steps);
  }
```
Update `_onAgentEvent` (`:550`) to accept an attribution arg and tag the cost/log emits. Replace its signature + the two emit points:
```javascript
  /** Translate a low-level claude/mock event into a pipeline 'log' event. */
  _onAgentEvent(role, e, attr = null) {
    if (!e) return;
    const cost = e.costUsd != null
      ? Number(e.costUsd)
      : (e.raw && e.raw.type === 'result' ? Number(e.raw.total_cost_usd ?? e.raw.cost_usd) : NaN);
    if (Number.isFinite(cost)) this._recordCost(cost, attr?.stepKey);
    else if (e.raw && e.raw.type === 'result' && !this.claude.mock) {
      this._log('orchestrator', 'warn', 'result event carried no cost estimate (total_cost_usd absent)', attr);
    }

    const text = (e.text || '').trim();
    if (text) {
      this._log(role, 'info', text, attr);
      return;
    }
    for (const call of describeToolUses(e.raw, this.projectDir)) {
      this._log(role, 'debug', `→ ${call}`, attr);
    }
  }
```
Update `_recordCost` (`:753`) to take an explicit key (falling back to the legacy live-phase key so existing cost-tracking tests stay green):
```javascript
  _recordCost(costUsd, stepKey = null) {
    if (!Number.isFinite(costUsd) || costUsd < 0) return;
    const key = stepKey
      || (this.state.cycle ? `${this.state.phase}#${this.state.cycle}` : this.state.phase);
    const step = this.state.steps.find((s) => s.key === key);
    if (step) step.costUsd = roundUsd((step.costUsd || 0) + costUsd);
    this.state.totalCostUsd = sumStepCosts(this.state.steps);
    this.state.updatedAt = new Date().toISOString();
    this._emit('state', this.getState());
    this._persist().catch(() => {});
  }
```
Finally extend `_log` (`:814`) to merge optional attribution tags (every engine event gains `{nodeId,stepIndex,cycle}` per the CONTRACT; absent for non-node logs):
```javascript
  _log(source, level, text, attr = null) {
    const evt = { source, level, text, ts: new Date().toISOString() };
    if (attr) {
      if (attr.nodeId != null) evt.nodeId = attr.nodeId;
      if (attr.stepIndex != null) evt.stepIndex = attr.stepIndex;
      if (attr.cycle != null) evt.cycle = attr.cycle;
    }
    this._emit('log', evt);
  }
```

- [ ] **Step 4: Run the dispatcher foundation + the existing cost suite — expect PASS (no regressions).**
```bash
node --test test/dispatcher.test.mjs test/cost-tracking.test.mjs test/agent-log.test.mjs
```
Expect: all pass. The cost-tracking tests still call `_onAgentEvent(role, evt)` with no `attr`, so cost falls back to the live-phase key exactly as before; the new node tests pass via explicit keys.

- [ ] **Step 5: Commit.**
```bash
git add src/core/orchestrator.mjs test/dispatcher.test.mjs
git commit -m "refactor(orchestrator): node-aware ctx + cost/step attribution

Adds _nodeCtx/_nodeStep/_stepKeyFor; cost+log emits carry nodeId/stepIndex/cycle
and attribute to a node-derived key (parallel-safe). Legacy phase path unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The dispatcher + generic `_runLoop` replacing `run()`'s hardcoded sequence

Replace `run()` steps 5–8 (`orchestrator.mjs:220-256`) and delete `_refineLoop`/`_reviewLoop` (`:331-459`) with: `resolveWorkflow(...) -> plan`, then `_dispatch(plan)`. `_dispatch` walks `plan.steps`, runs a single node directly or a parallel group via `Promise.all`, and after each step checks whether any **active loop** whose `from` step just completed fired (a `loopSource` node returned `blocked` and `cycle < maxCycles`) — if so it rewinds the pointer to the loop's `to` step (incrementing that loop's cycle); when exhausted it gates the user via `_gate` exactly as `_reviewLoop` did.

**Files:**
- `src/core/orchestrator.mjs` (modify — imports `:33-41`; `run()` `:168-292`; delete `:331-459`; add `_dispatch`/`_runStep`/`_runNode`; thread per-node IO paths)
- `src/cli/maestro.mjs` (modify — pass `workflowId` `:335-349`)

- [ ] **Step 1: Add the failing dispatch tests to `test/dispatcher.test.mjs`** — a parallel 2-node step (both run, both emit, both complete) and a feedback loop that fires on a blocked verifier then stops at maxCycles. These use a **plan injected directly** (bypassing `resolveWorkflow`) and a **stubbed runner registry** so the loop/parallel mechanics are tested in isolation, deterministically. Append:
```javascript
import { createOrchestrator as makeOrch } from '../src/core/orchestrator.mjs';

// Build a minimally-initialized orchestrator ready to dispatch: pipeline dir +
// prompts stubbed, git/preflight skipped. We call _dispatch directly.
async function primed(projectDir) {
  const orch = makeOrch({ projectDir, prompt: 'demo', auto: true, claude: { mock: true } });
  orch.pipeline = { id: 'p1', dir: projectDir, promptText: 'demo' };
  orch.state.id = 'p1';
  orch.state.pipelineDir = projectDir;
  orch.baseName = 'feature';
  orch.agentPrompts = {};
  orch.toolInstruction = '';
  orch.checkpointRef = null;
  orch._setStatus('running');
  return orch;
}

test('parallel step: both nodes run, both emit (tagged), both complete', async () => {
  const dir = await makeTmpDir();
  const orch = await primed(dir);
  const ran = [];
  const emits = [];
  orch.on('log', (l) => { if (l.nodeId) emits.push(l.nodeId); });
  // Stub the registry the dispatcher consults.
  orch._runners = {
    producer: async (ctx) => {
      ran.push(ctx.node.nodeId);
      ctx.onEvent({ type: 'assistant', text: `did ${ctx.node.nodeId}`, raw: {} });
      return { status: 'ok', summary: ctx.node.nodeId };
    },
    verifier: async () => ({ status: 'ok', issues: [], review: { issues: [], summary: '' } }),
  };
  const plan = {
    id: 'wf_x', name: 'X',
    steps: [[
      { nodeId: 'a', key: 'implementer', runnerType: 'producer' },
      { nodeId: 'b', key: 'implementer', runnerType: 'producer' },
    ]],
    feedbacks: [],
  };
  await orch._dispatch(plan);
  assert.deepEqual(ran.sort(), ['a', 'b'], 'both parallel nodes ran');
  assert.deepEqual([...new Set(emits)].sort(), ['a', 'b'], 'both emitted node-tagged events');
  const st = orch.getState();
  assert.ok(st.steps.find((s) => s.nodeId === 'a' && s.status === 'done'));
  assert.ok(st.steps.find((s) => s.nodeId === 'b' && s.status === 'done'));
});

test('feedback loop fires on blocked verifier, then stops at maxCycles and gates', async () => {
  const dir = await makeTmpDir();
  const orch = await primed(dir);
  // Verifier ALWAYS blocks -> the loop can only stop at maxCycles.
  let implRuns = 0;
  let gateAsks = 0;
  orch._runners = {
    producer: async (ctx) => { if (ctx.node.key === 'implementer') implRuns += 1; return { status: 'ok', summary: 'impl' }; },
    verifier: async () => ({ status: 'blocked', issues: [{ severity: 'major', title: 't', detail: 'd', location: 'l' }], review: { issues: [{ severity: 'major' }], summary: 's' } }),
  };
  orch.on('question', ({ kind }) => { if (kind === 'gate') gateAsks += 1; });
  const plan = {
    id: 'wf_loop', name: 'Loop',
    steps: [
      [{ nodeId: 'impl', key: 'implementer', runnerType: 'producer' }],
      [{ nodeId: 'rev', key: 'reviewer', runnerType: 'verifier', loopSource: true }],
    ],
    feedbacks: [{ id: 'fb0', from: 'rev', to: 0, maxCycles: 3, gate: 'hasBlocking' }],
  };
  await orch._dispatch(plan);
  // cycle starts at 1; loop re-runs to step 0 while cycle<maxCycles=3 -> impl runs at
  // cycles 1,2,3 = 3 times; the 3rd review is still blocked so it gates once (auto->continue).
  assert.equal(implRuns, 3, 'implementer re-ran up to maxCycles');
  assert.equal(gateAsks, 1, 'gated the user exactly once at maxCycles');
});

test('feedback loop does NOT fire when verifier passes', async () => {
  const dir = await makeTmpDir();
  const orch = await primed(dir);
  let implRuns = 0;
  orch._runners = {
    producer: async (ctx) => { if (ctx.node.key === 'implementer') implRuns += 1; return { status: 'ok', summary: 'impl' }; },
    verifier: async () => ({ status: 'ok', issues: [], review: { issues: [], summary: '' } }),
  };
  const plan = {
    id: 'wf_ok', name: 'OK',
    steps: [
      [{ nodeId: 'impl', key: 'implementer', runnerType: 'producer' }],
      [{ nodeId: 'rev', key: 'reviewer', runnerType: 'verifier', loopSource: true }],
    ],
    feedbacks: [{ id: 'fb0', from: 'rev', to: 0, maxCycles: 3, gate: 'hasBlocking' }],
  };
  await orch._dispatch(plan);
  assert.equal(implRuns, 1, 'no loop -> implementer runs once');
});
```

- [ ] **Step 2: Run — expect FAIL.**
```bash
node --test test/dispatcher.test.mjs 2>&1 | grep -m1 "_dispatch is not a function"
```
Expect: `orch._dispatch is not a function`.

- [ ] **Step 3: Wire the dispatcher into `orchestrator.mjs`.** First, swap imports (`:33-41`) — drop the direct phase-runner imports, add the registry, workflow resolver, registry loader, and run-config IO path builders:
```javascript
import { detectTools } from './preflight.mjs';
import { resolveStepModels } from './config.mjs';
import { hasBlocking, blockingIssues } from './protocol.mjs';
import { runPlannerClarify } from './phases.mjs';
import { runners as defaultRunners } from './runners.mjs';
import { resolveWorkflow } from './workflows.mjs';
import { loadAgentRegistry } from './agent-registry.mjs';
```
In the constructor (after `:90`), capture the workflow id + an overridable registry (tests stub `_runners`):
```javascript
    this.workflowId = this.opts.workflowId || 'wf_default';
    this._runners = this.opts.runners || defaultRunners;
```
Replace `run()` steps 5–8 (the block from `// 5) Planner plan.` at `:220` through the end of step 8 `await this._reviewLoop(finalPlanPath);` + its `_checkAbort()` at `:257`) with a resolve-then-dispatch:
```javascript
      // 5) Resolve the workflow topology + per-project run-config -> ExecutablePlan,
      //    then dispatch it. The default workflow (wf_default) routes through the
      //    SAME dispatcher and reproduces today's Plan->Refine->Implement->Review.
      const registry = await loadAgentRegistry();
      const plan = resolveWorkflow(this.projectDir, this.workflowId, registry);
      await appendAudit(this.pipeline.dir, `Workflow: **${plan.name}** (${plan.id}).`);
      await this._dispatch(plan, { answers });
      this._checkAbort();
```
> Note: clarify (step 4, `:217`) stays as-is — it precedes the workflow and is not modelled as a plan node (the planner-clarify role is a pre-step, mirroring today). The planner *plan* node IS the first plan step.

Now add the dispatcher + generic loop. Insert this block where `_refineLoop`/`_reviewLoop` were (replace `:331-459` entirely):
```javascript
  // ── data-driven dispatcher ─────────────────────────────────────────────────

  /**
   * Walk the resolved plan's steps in order. A single-node step runs directly; a
   * multi-node step runs concurrently (Promise.all). After each step completes,
   * check active feedback loops whose `from` step just ran: if a loopSource node
   * in that step returned blocking issues and the loop's cycle < maxCycles, rewind
   * the pointer to the loop's `to` step (incrementing the loop cycle) and re-run
   * forward. When a loop's cycles are exhausted, gate the user (continue/stop)
   * exactly as the legacy _reviewLoop did.
   *
   * Per-loop state lives in `loopState[fb.id] = { cycle }`; the per-step run cycle
   * passed to nodes is the max cycle of any loop currently re-running through it
   * (so a node's artifacts/keys are unique per re-run), defaulting to 1.
   * @param {object} plan ExecutablePlan
   * @param {{answers?:Array}} runArgs
   */
  async _dispatch(plan, runArgs = {}) {
    const steps = Array.isArray(plan?.steps) ? plan.steps : [];
    const feedbacks = Array.isArray(plan?.feedbacks) ? plan.feedbacks : [];
    // Map: source step index -> feedbacks originating there. `from` resolves to the
    // index of the step containing the from-node; `to` is a step index (per CONTRACT
    // resolveWorkflow already lowered node ids to indices, but tolerate either).
    const nodeStepIndex = new Map();
    steps.forEach((group, i) => group.forEach((n) => nodeStepIndex.set(n.nodeId, i)));
    const toIndex = (ref) =>
      typeof ref === 'number' ? ref : (nodeStepIndex.has(ref) ? nodeStepIndex.get(ref) : Number(ref) || 0);
    const fbByFrom = new Map();
    for (const fb of feedbacks) {
      const fromIdx = toIndex(fb.from);
      if (!fbByFrom.has(fromIdx)) fbByFrom.set(fromIdx, []);
      fbByFrom.get(fromIdx).push({ ...fb, fromIdx, toIdx: toIndex(fb.to), maxCycles: numOr(fb.maxCycles, 1) });
    }
    const loopState = {}; // fb.id -> { cycle }
    // The active run cycle per step index while a loop is replaying through it.
    const stepCycle = new Array(steps.length).fill(1);

    // Shared run state threaded between nodes (the plan/checklist/review paths).
    const io = {
      planPath: planPath(this.projectDir, this.baseName, 1, this.planDatePrefix),
      checklistPath: join(this.pipeline.dir, 'manual-tests-checklist.md'),
      answers: runArgs.answers || [],
    };

    let i = 0;
    while (i < steps.length) {
      this._checkAbort();
      const cycle = stepCycle[i];
      const results = await this._runStep(steps[i], i, cycle, io);

      // Did any feedback originating in THIS step fire?
      const loops = fbByFrom.get(i) || [];
      let rewound = false;
      for (const fb of loops) {
        const fired = this._loopFired(fb, steps[i], results);
        if (!fired) continue;
        const st = (loopState[fb.id] ||= { cycle: 1 });
        if (st.cycle < fb.maxCycles) {
          st.cycle += 1;
          stepCycle[fb.toIdx] = st.cycle;     // re-runs of the to..from range bump cycle
          for (let k = fb.toIdx; k <= i; k++) stepCycle[k] = st.cycle;
          await appendAudit(
            this.pipeline.dir,
            `Loop ${fb.id}: blocking issues at step ${i}; rewind to step ${fb.toIdx} (cycle ${st.cycle}).`,
          );
          i = fb.toIdx;
          rewound = true;
          break;
        }
        // Cycles exhausted -> gate the user exactly like the old review loop.
        const decision = await this._gate(fb.id, st.cycle, blockingIssues(this._reviewOf(results, steps[i])));
        this._checkAbort();
        if (decision === 'another') {
          st.cycle += 1;
          for (let k = fb.toIdx; k <= i; k++) stepCycle[k] = st.cycle;
          await appendAudit(this.pipeline.dir, `Loop ${fb.id} gate at cycle ${st.cycle - 1}: user approved another cycle.`);
          i = fb.toIdx;
          rewound = true;
          break;
        }
        await appendAudit(this.pipeline.dir, `Loop ${fb.id} gate at cycle ${st.cycle}: user chose to continue with open issue(s).`);
      }
      if (!rewound) i += 1;
    }
  }

  /**
   * Run one step. Single node -> direct; >1 node -> Promise.all (PARALLEL).
   * Returns an array of { node, result } in node order.
   */
  async _runStep(group, stepIndex, cycle, io) {
    if (group.length === 1) {
      return [await this._runNode(group[0], stepIndex, cycle, io)];
    }
    return Promise.all(group.map((node) => this._runNode(node, stepIndex, cycle, io)));
  }

  /**
   * Execute a single plan node through its runnerType, threading the shared IO
   * paths in/out. Records the node step (parallel-safe) and tags all emits.
   */
  async _runNode(node, stepIndex, cycle, io) {
    this._nodeStep(node, stepIndex, cycle, 'start');
    // Per-cycle artifact paths so loop re-runs never clobber prior outputs.
    const ctx = this._nodeCtx(node, { stepIndex, cycle });
    Object.assign(ctx, this._nodeIo(node, cycle, io));
    let result;
    try {
      const runner = this._runners[node.runnerType];
      if (typeof runner !== 'function') throw new Error(`no runner for type "${node.runnerType}"`);
      result = await runner(ctx);
    } finally {
      this._nodeStep(node, stepIndex, cycle, 'done');
    }
    this._afterNode(node, result, io);
    return { node, result };
  }

  /** Compute the per-node IO fields the runners read, from the shared run state. */
  _nodeIo(node, cycle, io) {
    switch (node.key) {
      case 'planner':
        return { planFilePath: io.planPath, baseName: this.baseName, answers: io.answers };
      case 'refiner': {
        const outPlanPath = planPath(this.projectDir, this.baseName, cycle + 1, this.planDatePrefix);
        return {
          inPlanPath: io.planPath,
          outPlanPath,
          reviewJsonPath: join(this.pipeline.dir, `refine-review-cycle${cycle}.json`),
          cycle,
        };
      }
      case 'implementer':
        return {
          planPath: io.planPath,
          reviewPath: io.reviewMdPath,
          mode: io.reviewMdPath ? 'fix' : 'implement',
          cycle,
        };
      case 'manualTestsChecklist':
        return { planPath: io.planPath, checklistPath: io.checklistPath };
      case 'reviewer':
        return {
          planPath: io.planPath,
          reviewMdPath: reviewPath(this.projectDir, this.baseName, this.planDatePrefix),
          reviewJsonPath: join(this.pipeline.dir, `impl-review-cycle${cycle}.json`),
          cycle,
        };
      case 'manualWebUiTesting':
        return {
          checklistPath: io.checklistPath,
          reviewMdPath: join(this.pipeline.dir, `webui-review-cycle${cycle}.md`),
          reviewJsonPath: join(this.pipeline.dir, `webui-review-cycle${cycle}.json`),
          cycle,
        };
      default:
        return { cycle };
    }
  }

  /** Fold a node's result back into shared run state + emit artifacts. */
  _afterNode(node, result, io) {
    if (!result) return;
    if (result.planPath) { io.planPath = result.planPath; this._artifact('plan', result.planPath); }
    if (result.outPlanPath) { io.planPath = result.outPlanPath; this._artifact('plan', result.outPlanPath); }
    if (result.checklistPath) { io.checklistPath = result.checklistPath; this._artifact('checklist', result.checklistPath); }
    if (result.review) {
      // A reviewer/web-ui verdict: expose its md/json + remember the md for the
      // implementer's fix pass on a loop re-run.
      io.reviewMdPath = result.reviewMdPath || io.reviewMdPath;
    }
    // Stage the working tree after any producer that may have written code, so a
    // following reviewer's `git diff` sees new/untracked files (mirrors the old
    // post-implement / post-fix staging).
    if (node.runnerType === 'producer' && (node.key === 'implementer')) {
      // fire-and-forget; never throws
      this._stageWorkingTree();
    }
  }

  /** True if any loopSource node in `group` returned blocking issues. */
  _loopFired(fb, group, results) {
    const review = this._reviewOf(results, group);
    return review ? hasBlocking(review) : false;
  }

  /** The review verdict of the loopSource node in this step (or the first verifier). */
  _reviewOf(results, group) {
    const r = results.find((x) => x.node.loopSource) || results.find((x) => x.node.runnerType === 'verifier');
    return r?.result?.review || (r?.result?.status === 'blocked'
      ? { issues: (r.result.issues || []).map((i) => ({ severity: i.severity || 'major' })), summary: r.result.summary || '' }
      : null);
  }
```
Delete the now-dead direct-import phase calls in `run()` if any remain (the plan node path replaces `runPlannerPlan`/`runImplementer`/`runRefiner`/`runReviewer` direct calls; only `runPlannerClarify` stays, used by `_clarify`). Confirm no other references to `_refineLoop`/`_reviewLoop` exist:
```bash
grep -n "_refineLoop\|_reviewLoop\|runPlannerPlan\|runImplementer\|runRefiner\|runReviewer" src/core/orchestrator.mjs
```
Expect: no matches (clarify-only imports remain).

- [ ] **Step 4: Thread `workflowId` through the CLI** (`src/cli/maestro.mjs:335-349`) so a future `--workflow` flag and the API agree. Add to the `createOrchestrator({...})` options object:
```javascript
    workflowId: flags.workflow || undefined,
```
(`flags.workflow` is undefined today → defaults to `wf_default` in the constructor; the API server passes its own `workflowId` in Phase 7. No flag parsing change required for parity.)

- [ ] **Step 5: Run the dispatcher unit tests — expect PASS.**
```bash
node --test test/dispatcher.test.mjs
```
Expect: parallel step (both ran/emitted/done), loop-fires-then-gates (implRuns===3, gateAsks===1), no-loop (implRuns===1), plus the Task 4 foundation tests all pass.

- [ ] **Step 6: Commit.**
```bash
git add src/core/orchestrator.mjs src/cli/maestro.mjs test/dispatcher.test.mjs
git commit -m "feat(orchestrator): data-driven dispatcher + generic feedback loop

run() resolves a workflow to an ExecutablePlan and dispatches it: sequential
walk, Promise.all for parallel groups, one generic loop (pointer rewind on a
blocked loopSource, gate at maxCycles). Replaces _refineLoop/_reviewLoop.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: DEFAULT_WORKFLOW parity regression test (same phase order + loop gating)

A regression test that pins the default workflow's behavior to today's: under `MAESTRO_MOCK=1`, dispatching `wf_default` produces the same node/phase order (plan → refine → implement → review …) and the same loop gating (refine loop and review loop terminate by their mock convergence; gates fire only at maxCycles). This is the contract guarding §6.5 parity.

**Files:**
- `test/dispatcher.test.mjs` (modify — add the parity test using the REAL registry + resolver + runners)

- [ ] **Step 1: Add the parity test.** It runs a full `orch.run()` in auto+mock mode against the default workflow and asserts the emitted phase/node sequence + gate behavior match the legacy pipeline. Append to `test/dispatcher.test.mjs`:
```javascript
import { DEFAULT_WORKFLOW } from '../src/core/workflows.mjs';

test('DEFAULT_WORKFLOW dispatch reproduces the legacy phase order + loop gating (mock)', async () => {
  const dir = await makeTmpDir();
  const orch = makeOrch({
    projectDir: dir,
    prompt: 'demo task',
    auto: true,
    claude: { mock: true },
    // default workflowId -> wf_default
  });

  // Capture the node-tagged step order (dedupe consecutive duplicates from start/done).
  const order = [];
  orch.on('log', (l) => { /* keep logs flowing; no-op */ });
  orch.on('state', () => {});
  const phases = [];
  orch.on('phase', ({ phase, cycle, status }) => {
    if (status === 'start') phases.push(cycle ? `${phase}#${cycle}` : phase);
  });
  const nodeStarts = [];
  // node steps are recorded in state.steps with nodeId; snapshot their first-seen order.
  const seen = new Set();
  orch.on('state', (st) => {
    for (const s of st.steps) {
      if (s.nodeId && !seen.has(s.key)) { seen.add(s.key); nodeStarts.push(s.phase); }
    }
  });
  let gateAsks = 0;
  orch.on('question', ({ kind }) => { if (kind === 'gate') gateAsks += 1; });

  const res = await orch.run();
  assert.equal(res.status, 'done', 'mock default pipeline finishes');

  // Legacy order: preflight, clarify, then the 4 plan nodes in sequence with the
  // refine + review loops converging by mock cycle 2 (no extra cycles, no gate).
  // The node-phase order (by key) must start planner -> refiner -> implementer -> reviewer.
  const firstFour = nodeStarts.slice(0, 4);
  assert.deepEqual(
    firstFour,
    ['planner', 'refiner', 'implementer', 'reviewer'],
    `default node order must be plan->refine->implement->review, saw ${nodeStarts.join(',')}`,
  );
  // Mock convergence: refiner cycle1 major -> cycle2 minor; reviewer cycle1 major ->
  // implementer fix -> reviewer cycle2 suggestion. So the reviewer node runs twice
  // and the implementer runs twice (initial + one fix), with NO gate (maxCycles=5).
  const reviewerRuns = nodeStarts.filter((p) => p === 'reviewer').length;
  const implementerRuns = nodeStarts.filter((p) => p === 'implementer').length;
  assert.equal(reviewerRuns, 2, 'review loop runs the reviewer exactly twice (mock converges at cycle 2)');
  assert.equal(implementerRuns, 2, 'implement + one fix pass');
  assert.equal(gateAsks, 0, 'no gate fires under default maxCycles with the converging mock');
});

test('DEFAULT_WORKFLOW is the wf_default 4-step Plan->Refine->Implement->Review topology', () => {
  assert.equal(DEFAULT_WORKFLOW.id, 'wf_default');
  const keys = DEFAULT_WORKFLOW.steps.map((g) => g.map((n) => n.key));
  assert.deepEqual(keys, [['planner'], ['refiner'], ['implementer'], ['reviewer']]);
  // Two feedbacks reproduce the refine loop (refiner self-loop) and review loop (reviewer->implementer).
  assert.ok(DEFAULT_WORKFLOW.feedbacks.length >= 1, 'default carries the legacy loop(s)');
});
```
> **If the parity test reveals a behavioral mismatch** (e.g. the refiner self-loop or the reviewer→implementer rewind doesn't reproduce because `DEFAULT_WORKFLOW.feedbacks` or `resolveWorkflow`'s maxCycles don't match `maxRefineCycles`/`maxReviewCycles`): that is a **Phase 2 contract bug**, not a dispatcher bug. Fix it where the default template/feedbacks are defined (`workflows.mjs`), then re-run. The dispatcher must stay generic — do NOT special-case `wf_default` in `orchestrator.mjs`.

- [ ] **Step 2: Run the parity test under mock — expect PASS.**
```bash
MAESTRO_MOCK=1 node --test test/dispatcher.test.mjs
```
Expect: parity test green (node order plan→refine→implement→review; reviewer×2, implementer×2; no gate), plus all earlier dispatcher tests.

- [ ] **Step 3: Run the FULL suite — expect all green (no regressions in clarify/cost/duration/ui tests that exercise `run()`).**
```bash
MAESTRO_MOCK=1 node --test test/*.mjs
```
Expect: every test passes. Pay attention to `test/clarify.test.mjs` ("clarify runs exactly one round", "mock pipeline should finish") and any duration/cost test that drives a full `run()` — they assert on the phase/step machinery the dispatcher now drives.

- [ ] **Step 4: Commit.**
```bash
git add test/dispatcher.test.mjs
git commit -m "test(dispatcher): pin DEFAULT_WORKFLOW parity (phase order + loop gating)

Regression test: wf_default dispatch reproduces plan->refine->implement->review
with the refine/review loops converging by the mock's cycle-2 and no gate, all
under MAESTRO_MOCK=1. Guards the §6.5 parity contract.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Smoke parity verification + audit of legacy-loop references

Verify the end-to-end CLI smoke run is still green offline (the headline acceptance gate) and that no stale references to the deleted loops/direct phase calls remain anywhere in the engine or CLI.

**Files:**
- (verification only — no new source unless a smoke failure surfaces a bug to fix)

- [ ] **Step 1: Run the offline smoke — expect a clean `done`.** This is the headline verification step for the whole phase (`package.json` `smoke` script → `MAESTRO_MOCK=1 ... maestro.mjs --project examples/sandbox --prompt "demo task" --mock --yes`):
```bash
MAESTRO_MOCK=1 npm run smoke
```
Expect: the run reaches `done` (phases preflight → clarify → plan → refine → implement → review → done), writes the plan/-vN/review artifacts under `examples/sandbox/ai-artifacts/pipelines/...`, and exits 0. If it fails, debug the dispatcher/`workflows.mjs` parity (NOT by re-adding a hardcoded path) before proceeding.

- [ ] **Step 2: Confirm the legacy hardcoded sequence is fully gone.**
```bash
grep -rn "_refineLoop\|_reviewLoop" src/ || echo "OK: no legacy loop methods"
grep -n "runPlannerPlan\|runRefiner\|runImplementer\|runReviewer" src/core/orchestrator.mjs || echo "OK: orchestrator no longer calls phase runners directly"
```
Expect: both print their `OK:` lines (the only surviving phase import in `orchestrator.mjs` is `runPlannerClarify`).

- [ ] **Step 3: Confirm every engine event is attributable (CONTRACT: emits carry nodeId/stepIndex/cycle).** Spot-check that node logs in a mock run carry the tags:
```bash
MAESTRO_MOCK=1 node -e "import('./src/core/orchestrator.mjs').then(async ({createOrchestrator})=>{const o=createOrchestrator({projectDir:'examples/sandbox',prompt:'demo',auto:true,claude:{mock:true}});let tagged=0,total=0;o.on('log',l=>{total++;if(l.nodeId!=null)tagged++;});const r=await o.run();console.log('status',r.status,'tagged/total logs',tagged+'/'+total);if(tagged===0)process.exit(1);})"
```
Expect: `status done` and `tagged/total` with `tagged > 0` (node-phase logs are attributed; pre-step preflight/clarify logs may be untagged, which is fine).

- [ ] **Step 4: Final full-suite run + commit a no-op marker only if any fix was needed.** If Steps 1–3 required a code change, re-run the full suite and commit; otherwise nothing to commit (verification only).
```bash
MAESTRO_MOCK=1 node --test test/*.mjs && MAESTRO_MOCK=1 npm run smoke && echo "PHASE 3 GREEN"
```
Expect: `PHASE 3 GREEN`. (No commit if the working tree is clean.)

## Phase 4: Server API + persistence wiring

This phase exposes the workflow store, agent registry, and run-config through Maestro's Express server (`ui/server.mjs`) and wires `POST /api/run` to pass the chosen `workflowId` into the orchestrator. It depends on the Phase 1/2 core modules whose **exact** signatures are fixed by the SHARED INTERFACE CONTRACT:

- `src/core/workflows.mjs` — `DEFAULT_WORKFLOW`, `listWorkflows()`, `readWorkflow(id)`, `writeWorkflow(tpl)`, `deleteWorkflow(id)` (templates at `~/.maestro/workflows/<id>.json`, honoring `MAESTRO_HOME`).
- `src/core/workflow-validator.mjs` — `validateWorkflow(tpl, registry) -> { ok, errors }`.
- `src/core/agent-registry.mjs` — `loadAgentRegistry(agentsDir) -> { [key]: AgentMeta }` (sorted by `.order`).
- `src/core/config.mjs` additions — `readRunConfig`, `setNodeModel`, `setFeedbackCycles`, `setActiveWorkflow`, `resolveRunConfig`.

These four modules are created/extended in Phases 1–2. This phase's tests import them; if a phase ran out of order the import simply fails loudly. **Before implementing each task below, re-open the real Phase 1/2 file and confirm the named export matches the CONTRACT** (the plan cites the contract, not yet-unwritten line numbers).

**Current server facts (read and cited):**
- `ui/server.mjs` imports core modules at `ui/server.mjs:18-24` (note the existing `import { ... } from '../src/core/config.mjs'` block at L21-24 — new config exports are added there).
- In-memory `runs` Map declared at `ui/server.mjs:51`.
- `POST /api/run` at `ui/server.mjs:216-286`; it builds the orchestrator via `createOrchestrator({ ... })` at L248-257 and the per-run `entry` at L259-268.
- `GET /api/config` at `ui/server.mjs:422-439`; `POST /api/config` at `ui/server.mjs:441-452`; custom-model routes at L454-478.
- Helpers: `badRequest(res, message)` at `ui/server.mjs:203`; `resolveProjectDir(input)` at `ui/server.mjs:208`; `AGENTS_DIR` constant at `ui/server.mjs:30`.
- Module exports `{ app, server, runs }` at `ui/server.mjs:626` and binds a port only when run as main (`isMain` guard L613-624) — so an imported `app` never listens, which the tests rely on.
- `createOrchestrator(opts)` stores `opts` wholesale as `this.opts` (`src/core/orchestrator.mjs:72-80`); Phase 3 reads `this.opts.workflowId`, so this phase only needs to forward it.

**Test harness pattern (from `test/projects-api.test.mjs:1-25` and `test/config-api.test.mjs:1-22`):** import `{ app }` from `../ui/server.mjs`, wrap in `http.createServer(app)`, `await listen(0,'127.0.0.1')`, hit it with `fetch`. Set `process.env.MAESTRO_HOME` to a temp dir in `before` so the global workflow store writes under the sandbox, and `delete` it in `after`. `MAESTRO_MOCK=1` keeps `/api/run` offline (the run never spawns `claude`).

---

### Task 1: GET /api/workflows + GET /api/workflows/:id (list + fetch one)

**Files:**
- Modify: `ui/server.mjs` (add import from `../src/core/workflows.mjs`; add two routes after the `/api/config` block, ~`ui/server.mjs:478`)
- Test: `test/api-workflows.test.mjs` (new)

- [ ] **Step 1: Write the failing test (new file)**

Create `test/api-workflows.test.mjs`:

```javascript
// test/api-workflows.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let homeDir, srv, base;
const JSONH = { 'Content-Type': 'application/json' };

before(async () => {
  // Redirect the global ~/.maestro (workflow store) into a sandbox.
  homeDir = await mkdtemp(join(tmpdir(), 'maestro-wfapi-'));
  process.env.MAESTRO_HOME = homeDir;
  process.env.MAESTRO_MOCK = '1'; // keep /api/run offline
  const { app } = await import('../ui/server.mjs'); // imported => no port bind
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => {
  if (srv) await new Promise((r) => srv.close(r));
  delete process.env.MAESTRO_HOME;
  delete process.env.MAESTRO_MOCK;
  await rm(homeDir, { recursive: true, force: true });
});

test('GET /api/workflows lists the built-in default first', async () => {
  const r = await fetch(`${base}/api/workflows`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.workflows));
  assert.equal(j.workflows[0].id, 'wf_default');
  assert.equal(j.workflows[0].name, 'Default');
  // The default template carries a real 4-step topology.
  assert.ok(Array.isArray(j.workflows[0].steps) && j.workflows[0].steps.length === 4);
});

test('GET /api/workflows/:id returns the default template', async () => {
  const r = await fetch(`${base}/api/workflows/wf_default`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.id, 'wf_default');
  assert.ok(Array.isArray(j.feedbacks));
});

test('GET /api/workflows/:id is 404 for an unknown id', async () => {
  const r = await fetch(`${base}/api/workflows/wf_does_not_exist`);
  assert.equal(r.status, 404);
  assert.ok((await r.json()).error);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/api-workflows.test.mjs`
Expected: FAIL — the three workflow tests error (routes do not exist; `GET /api/workflows` falls through to the SPA fallback at `ui/server.mjs:603` returning `index.html`, so `r.json()` throws / status is 200 with HTML; `/api/workflows/wf_default` is 404 already but with no JSON body matching the default shape).

- [ ] **Step 3: Add the workflows import**

In `ui/server.mjs`, immediately after the config import block (ends `ui/server.mjs:24`), add:

```javascript
import {
  DEFAULT_WORKFLOW, listWorkflows, readWorkflow, writeWorkflow, deleteWorkflow,
} from '../src/core/workflows.mjs';
import { validateWorkflow } from '../src/core/workflow-validator.mjs';
import { loadAgentRegistry } from '../src/core/agent-registry.mjs';
```

- [ ] **Step 4: Add the two GET routes**

In `ui/server.mjs`, immediately after the `DELETE /api/config/models` handler (ends `ui/server.mjs:478`), add the workflows section header + the two GET routes:

```javascript
// ---------------------------------------------------------------------------
// Workflow templates (global store at ~/.maestro/workflows). Topology only;
// model/effort/cycles live in per-project run-config. CRUD mirrors the
// /api/projects + /api/config delegation pattern: thin handlers, validation and
// atomic persistence owned by src/core/workflows.mjs + workflow-validator.mjs.
// ---------------------------------------------------------------------------
app.get('/api/workflows', (_req, res) => {
  try {
    // The built-in default is never persisted to the user store; callers
    // prepend it (CONTRACT: GET -> { workflows: [DEFAULT_WORKFLOW, ...listWorkflows()] }).
    res.json({ workflows: [DEFAULT_WORKFLOW, ...listWorkflows()] });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

app.get('/api/workflows/:id', (req, res) => {
  try {
    const tpl = readWorkflow(req.params.id); // returns DEFAULT_WORKFLOW for "wf_default"
    if (!tpl) return res.status(404).json({ error: 'workflow not found' });
    res.json(tpl);
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/api-workflows.test.mjs`
Expected: PASS for the three list/fetch tests (the create/delete/run/agents tests added in later tasks are not yet present in this file).

- [ ] **Step 6: Commit**

```bash
git add ui/server.mjs test/api-workflows.test.mjs
git commit -m "feat(api): GET /api/workflows list (default-first) + GET /api/workflows/:id

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: POST /api/workflows (validate → 400, else writeWorkflow → 201)

**Files:**
- Modify: `ui/server.mjs` (add POST route after the GET routes from Task 1)
- Test: `test/api-workflows.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/api-workflows.test.mjs` (after the GET tests):

```javascript
test('POST /api/workflows validates and rejects an empty-steps template -> 400', async () => {
  const r = await fetch(`${base}/api/workflows`, {
    method: 'POST', headers: JSONH,
    body: JSON.stringify({ name: 'Bad', steps: [], feedbacks: [] }),
  });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.ok(Array.isArray(j.errors) && j.errors.length >= 1, 'returns validator errors');
});

test('POST /api/workflows rejects a node with an unknown agent key -> 400', async () => {
  const r = await fetch(`${base}/api/workflows`, {
    method: 'POST', headers: JSONH,
    body: JSON.stringify({
      name: 'Bogus',
      steps: [[{ id: 's0_0', key: 'notAnAgent' }]],
      feedbacks: [],
    }),
  });
  assert.equal(r.status, 400);
  assert.ok((await r.json()).errors.length >= 1);
});

test('POST /api/workflows creates a valid template -> 201, then it lists', async () => {
  const r = await fetch(`${base}/api/workflows`, {
    method: 'POST', headers: JSONH,
    body: JSON.stringify({
      name: 'Quick Fix',
      steps: [
        [{ id: 's0_0', key: 'planner' }],
        [{ id: 's1_0', key: 'implementer' }],
        [{ id: 's2_0', key: 'reviewer' }],
      ],
      feedbacks: [{ id: 'fb_0', from: 's2_0', to: 's1_0' }],
    }),
  });
  assert.equal(r.status, 201);
  const { workflow } = await r.json();
  assert.equal(workflow.name, 'Quick Fix');
  assert.match(workflow.id, /^wf_/);
  assert.ok(workflow.createdAt && workflow.updatedAt, 'stamped on write');

  // It now appears in the list (after the always-present default).
  const list = await (await fetch(`${base}/api/workflows`)).json();
  assert.ok(list.workflows.some((w) => w.id === workflow.id && w.name === 'Quick Fix'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern='POST /api/workflows' test/api-workflows.test.mjs`
Expected: FAIL — there is no `POST /api/workflows` route; Express returns 404 (not 400/201) and the bodies have no `errors`/`workflow`.

- [ ] **Step 3: Add the POST route**

In `ui/server.mjs`, immediately after the `GET /api/workflows/:id` handler from Task 1, add:

```javascript
app.post('/api/workflows', (req, res) => {
  const body = req.body || {};
  // Build the candidate template from the editor payload (topology only).
  const tpl = {
    name: typeof body.name === 'string' ? body.name.trim() : '',
    steps: Array.isArray(body.steps) ? body.steps : [],
    feedbacks: Array.isArray(body.feedbacks) ? body.feedbacks : [],
  };
  if (!tpl.name) return badRequest(res, 'name is required');
  try {
    const registry = loadAgentRegistry(AGENTS_DIR);
    const { ok, errors } = validateWorkflow(tpl, registry);
    if (!ok) return res.status(400).json({ error: 'invalid workflow', errors });
    // writeWorkflow stamps id/createdAt/updatedAt and writes atomically (temp+rename).
    const workflow = writeWorkflow(tpl);
    res.status(201).json({ workflow });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern='POST /api/workflows' test/api-workflows.test.mjs`
Expected: PASS — empty steps and unknown-key bodies return 400 with `errors[]`; the valid body returns 201 with a stamped `workflow` that subsequently lists.

- [ ] **Step 5: Commit**

```bash
git add ui/server.mjs test/api-workflows.test.mjs
git commit -m "feat(api): POST /api/workflows validates then atomically writes (201)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: DELETE /api/workflows/:id (refuse wf_default → 400, 404 missing)

**Files:**
- Modify: `ui/server.mjs` (add DELETE route after the POST route from Task 2)
- Test: `test/api-workflows.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/api-workflows.test.mjs`:

```javascript
test('DELETE /api/workflows/wf_default is refused -> 400', async () => {
  const r = await fetch(`${base}/api/workflows/wf_default`, { method: 'DELETE' });
  assert.equal(r.status, 400);
  assert.ok((await r.json()).error);
});

test('DELETE /api/workflows/:id is 404 for an unknown id', async () => {
  const r = await fetch(`${base}/api/workflows/wf_missing_xyz`, { method: 'DELETE' });
  assert.equal(r.status, 404);
});

test('DELETE /api/workflows/:id removes a created template', async () => {
  // Create one to delete.
  const created = await (await fetch(`${base}/api/workflows`, {
    method: 'POST', headers: JSONH,
    body: JSON.stringify({
      name: 'Disposable',
      steps: [[{ id: 's0_0', key: 'planner' }], [{ id: 's1_0', key: 'reviewer' }]],
      feedbacks: [],
    }),
  })).json();
  const id = created.workflow.id;

  const del = await fetch(`${base}/api/workflows/${id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true });

  // Gone from the list (default still present).
  const list = await (await fetch(`${base}/api/workflows`)).json();
  assert.ok(!list.workflows.some((w) => w.id === id));
  assert.ok(list.workflows.some((w) => w.id === 'wf_default'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern='DELETE /api/workflows' test/api-workflows.test.mjs`
Expected: FAIL — no `DELETE /api/workflows/:id` route (Express returns 404 for every case, so the wf_default-refusal expectation of 400 and the successful-delete expectation of `{ ok: true }` both fail).

- [ ] **Step 3: Add the DELETE route**

In `ui/server.mjs`, immediately after the `POST /api/workflows` handler from Task 2, add:

```javascript
app.delete('/api/workflows/:id', (req, res) => {
  const id = req.params.id;
  // The built-in default is not in the user store and must never be deleted.
  if (id === 'wf_default') return badRequest(res, 'the default workflow cannot be deleted');
  try {
    const removed = deleteWorkflow(id);
    if (!removed) return res.status(404).json({ error: 'workflow not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern='DELETE /api/workflows' test/api-workflows.test.mjs`
Expected: PASS — wf_default → 400, unknown id → 404, created id → `{ ok: true }` then absent from the list.

- [ ] **Step 5: Commit**

```bash
git add ui/server.mjs test/api-workflows.test.mjs
git commit -m "feat(api): DELETE /api/workflows/:id (refuse default 400, 404 missing)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: GET /api/agents (registry for the composer palette)

**Files:**
- Modify: `ui/server.mjs` (add route after the workflows DELETE route)
- Test: `test/api-workflows.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/api-workflows.test.mjs`:

```javascript
test('GET /api/agents returns the palette registry as an ordered array', async () => {
  const r = await fetch(`${base}/api/agents`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.agents), 'agents is an array (palette render order)');
  // The 4 legacy + 2 new agents from the CONTRACT are present.
  const keys = j.agents.map((a) => a.key);
  for (const k of ['planner', 'refiner', 'implementer', 'reviewer',
                   'manualTestsChecklist', 'manualWebUiTesting']) {
    assert.ok(keys.includes(k), `registry includes ${k}`);
  }
  // Each pill carries what the palette needs to render.
  const planner = j.agents.find((a) => a.key === 'planner');
  assert.ok(planner.displayName, 'has a displayName');
  assert.ok(planner.color, 'has a color token');
  // Sorted ascending by .order (palette render order).
  const orders = j.agents.map((a) => a.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'ordered by .order');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern='GET /api/agents' test/api-workflows.test.mjs`
Expected: FAIL — no `/api/agents` route; the SPA fallback (`ui/server.mjs:603-609`) serves `index.html`, so `r.json()` throws on HTML.

- [ ] **Step 3: Add the GET /api/agents route**

In `ui/server.mjs`, immediately after the `DELETE /api/workflows/:id` handler from Task 3, add:

```javascript
// ---------------------------------------------------------------------------
// GET /api/agents -> the agent registry for the Composer palette. Scanned from
// agents/*.meta.json by src/core/agent-registry.mjs and returned as an array in
// palette render order (.order ascending). The client builds draggable pills
// (colored dot + displayName + icon) from this.
// ---------------------------------------------------------------------------
app.get('/api/agents', (_req, res) => {
  try {
    const registry = loadAgentRegistry(AGENTS_DIR); // { [key]: AgentMeta }, sorted by .order
    res.json({ agents: Object.values(registry) });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern='GET /api/agents' test/api-workflows.test.mjs`
Expected: PASS — `agents` is an array containing the 6 keys, each with `displayName`/`color`, in ascending `.order`.

> Note: `loadAgentRegistry` returns an object keyed by agent key, **already sorted by `.order`** (CONTRACT). `Object.values()` preserves that insertion order in V8, so the array is render-ordered without an extra sort. Confirm against the real `agent-registry.mjs` once Phase 1 lands; if it returns a plain unsorted object, sort here with `.sort((a,b)=>a.order-b.order)`.

- [ ] **Step 5: Commit**

```bash
git add ui/server.mjs test/api-workflows.test.mjs
git commit -m "feat(api): GET /api/agents serves the registry for the composer palette

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: POST /api/run accepts workflowId (default "wf_default")

**Files:**
- Modify: `ui/server.mjs` — `POST /api/run` handler (`ui/server.mjs:216-286`); add `workflowId` parse near L237 and forward it into `createOrchestrator(...)` at L248-257
- Test: `test/api-workflows.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/api-workflows.test.mjs`. The test starts an offline (mock) run and asserts the server accepts an explicit `workflowId`; it reads the run's WebSocket-buffered state through `/api/runs/:id` is not available pre-disk, so instead it asserts the run starts (HTTP 200 + a `runId`) for both the default and an explicit workflow, and that the run does not error out due to an unknown-workflow rejection.

```javascript
test('POST /api/run starts with the implicit default workflow', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'maestro-run-'));
  const r = await fetch(`${base}/api/run`, {
    method: 'POST', headers: JSONH,
    body: JSON.stringify({ projectDir, prompt: 'demo task', mock: true }),
  });
  assert.equal(r.status, 200);
  assert.match((await r.json()).runId, /[0-9a-f-]{8,}/);
  await rm(projectDir, { recursive: true, force: true });
});

test('POST /api/run accepts an explicit workflowId', async () => {
  // Create a custom workflow, then run it.
  const wf = await (await fetch(`${base}/api/workflows`, {
    method: 'POST', headers: JSONH,
    body: JSON.stringify({
      name: 'Run Me',
      steps: [[{ id: 's0_0', key: 'planner' }], [{ id: 's1_0', key: 'reviewer' }]],
      feedbacks: [],
    }),
  })).json();

  const projectDir = await mkdtemp(join(tmpdir(), 'maestro-run-'));
  const r = await fetch(`${base}/api/run`, {
    method: 'POST', headers: JSONH,
    body: JSON.stringify({ projectDir, prompt: 'demo task', mock: true, workflowId: wf.workflow.id }),
  });
  assert.equal(r.status, 200, 'a known workflowId is accepted');
  assert.ok((await r.json()).runId);
  await rm(projectDir, { recursive: true, force: true });
});

test('POST /api/run rejects an unknown workflowId -> 400', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'maestro-run-'));
  const r = await fetch(`${base}/api/run`, {
    method: 'POST', headers: JSONH,
    body: JSON.stringify({ projectDir, prompt: 'demo task', mock: true, workflowId: 'wf_nope' }),
  });
  assert.equal(r.status, 400, 'an unknown workflow is a client error before the run starts');
  await rm(projectDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern='POST /api/run' test/api-workflows.test.mjs`
Expected: FAIL — the unknown-workflowId test fails: today `/api/run` ignores `workflowId` entirely, so `wf_nope` returns 200 (no pre-flight existence check) instead of 400. (The default + explicit-known runs may pass already since `workflowId` is currently ignored; the new code must keep them passing while adding the 400.)

- [ ] **Step 3: Parse + validate workflowId in the handler**

In `ui/server.mjs`, inside `POST /api/run`, immediately after the `mock` line (`ui/server.mjs:239`), add the workflow resolution + existence guard:

```javascript
    // Optional workflowId selects a saved (or built-in default) topology. The
    // orchestrator resolves topology + per-project run-config into an executable
    // plan at run start; here we only normalize + reject an unknown id up front
    // so the client gets a clean 400 instead of a mid-run error event.
    const workflowId =
      typeof body.workflowId === 'string' && body.workflowId.trim() ? body.workflowId.trim() : 'wf_default';
    if (!readWorkflow(workflowId)) return badRequest(res, `unknown workflowId "${workflowId}"`);
```

- [ ] **Step 4: Forward workflowId into the orchestrator**

In `ui/server.mjs`, in the `createOrchestrator({ ... })` call (`ui/server.mjs:248-257`), add `workflowId` to the options object. Change the call FROM:

```javascript
    const orch = createOrchestrator({
      projectDir,
      prompt: effectivePrompt,
      title,
      extras,
      maxRefineCycles,
      maxReviewCycles,
      agentsDir: AGENTS_DIR,
      claude: { permissionMode: 'acceptEdits', mock },
    });
```

TO:

```javascript
    const orch = createOrchestrator({
      projectDir,
      prompt: effectivePrompt,
      title,
      extras,
      maxRefineCycles,
      maxReviewCycles,
      agentsDir: AGENTS_DIR,
      workflowId,
      claude: { permissionMode: 'acceptEdits', mock },
    });
```

> The orchestrator stores `opts` as `this.opts` (`src/core/orchestrator.mjs:72-80`) and Phase 3's `run()` reads `this.opts.workflowId` (default `"wf_default"`) to call `resolveWorkflow(projectDir, workflowId, registry)`. This phase only forwards the value; the dispatcher wiring is Phase 3.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test --test-name-pattern='POST /api/run' test/api-workflows.test.mjs`
Expected: PASS — default + explicit-known runs return 200 with a `runId`; the unknown `wf_nope` returns 400 before any run is created.

- [ ] **Step 6: Run the existing run-path suites for no regression**

Run: `node --test test/ui-runs-live-id.test.mjs test/clarify.test.mjs`
Expected: PASS — the `/api/run` change is additive (a new accepted field + an early 400 only for a genuinely unknown id); existing runs that send no `workflowId` default to `wf_default`, which `readWorkflow` resolves, so they are unaffected.

- [ ] **Step 7: Commit**

```bash
git add ui/server.mjs test/api-workflows.test.mjs
git commit -m "feat(api): POST /api/run accepts workflowId (default wf_default), 400 on unknown

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Extend GET/PATCH /api/config for run-config (nodes/feedbacks + activeWorkflowId)

**Files:**
- Modify: `ui/server.mjs` — extend `GET /api/config` (`ui/server.mjs:422-439`) to surface run-config; add a `PATCH /api/config` handler after `POST /api/config` (`ui/server.mjs:452`)
- Modify: `ui/server.mjs` — config import block (`ui/server.mjs:21-24`) to pull the new `config.mjs` exports
- Test: `test/api-workflows.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/api-workflows.test.mjs`. These exercise the per-project run-config (model/effort per node, cycles per feedback, active workflow) through the config API. They use a fresh project dir.

```javascript
test('PATCH /api/config sets a node model+effort and a feedback cycle count', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'maestro-rc-'));
  const wfId = 'wf_quickfix';

  let r = await fetch(`${base}/api/config`, {
    method: 'PATCH', headers: JSONH,
    body: JSON.stringify({
      projectDir, workflowId: wfId,
      nodes: { s1_0: { model: 'claude-opus-4-8', effort: 'high' } },
      feedbacks: { fb_0: { maxCycles: 3 } },
      activeWorkflowId: wfId,
    }),
  });
  assert.equal(r.status, 200);

  // GET reflects the run-config under config.workflows[wfId] + activeWorkflowId.
  r = await fetch(`${base}/api/config?${new URLSearchParams({ projectDir })}`);
  const j = await r.json();
  assert.deepEqual(j.config.workflows[wfId].nodes.s1_0, { model: 'claude-opus-4-8', effort: 'high' });
  assert.equal(j.config.workflows[wfId].feedbacks.fb_0.maxCycles, 3);
  assert.equal(j.config.activeWorkflowId, wfId);

  await rm(projectDir, { recursive: true, force: true });
});

test('PATCH /api/config preserves legacy steps alongside workflows', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'maestro-rc-'));
  // Set a legacy per-role step via the existing POST route.
  await fetch(`${base}/api/config`, {
    method: 'POST', headers: JSONH,
    body: JSON.stringify({ projectDir, step: 'reviewer', model: 'claude-opus-4-8', effort: 'max' }),
  });
  // Then a run-config node via PATCH.
  await fetch(`${base}/api/config`, {
    method: 'PATCH', headers: JSONH,
    body: JSON.stringify({
      projectDir, workflowId: 'wf_default',
      nodes: { s0_0: { model: 'claude-sonnet-4-6', effort: 'high' } },
    }),
  });
  const j = await (await fetch(`${base}/api/config?${new URLSearchParams({ projectDir })}`)).json();
  // Both coexist (backward-compatible: legacy steps untouched).
  assert.deepEqual(j.config.steps.reviewer, { model: 'claude-opus-4-8', effort: 'max' });
  assert.deepEqual(j.config.workflows.wf_default.nodes.s0_0, { model: 'claude-sonnet-4-6', effort: 'high' });
  await rm(projectDir, { recursive: true, force: true });
});

test('PATCH /api/config without projectDir -> 400', async () => {
  const r = await fetch(`${base}/api/config`, {
    method: 'PATCH', headers: JSONH,
    body: JSON.stringify({ workflowId: 'wf_default', nodes: {} }),
  });
  assert.equal(r.status, 400);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern='PATCH /api/config' test/api-workflows.test.mjs`
Expected: FAIL — there is no `PATCH /api/config` route (Express 404s the method), and `GET /api/config` does not yet include `config.workflows` / `config.activeWorkflowId` (it returns the legacy `readConfig` shape from `ui/server.mjs:434`).

- [ ] **Step 3: Pull the new config.mjs exports**

In `ui/server.mjs`, extend the existing config import block (`ui/server.mjs:21-24`) to add the run-config functions. Change FROM:

```javascript
import {
  readConfig, setStep, addCustomModel, removeCustomModel, listModels,
  PREDEFINED_MODELS, AGENT_STEPS, EFFORTS,
} from '../src/core/config.mjs';
```

TO:

```javascript
import {
  readConfig, setStep, addCustomModel, removeCustomModel, listModels,
  PREDEFINED_MODELS, AGENT_STEPS, EFFORTS,
  readRunConfig, setNodeModel, setFeedbackCycles, setActiveWorkflow,
} from '../src/core/config.mjs';
```

- [ ] **Step 4: Surface run-config in GET /api/config**

In `ui/server.mjs`, in the `GET /api/config` handler, change the project-backed response (`ui/server.mjs:433-438`) so the returned `config` is the full RunConfig (legacy `steps`/`customModels` plus `workflows`/`activeWorkflowId`). Change FROM:

```javascript
  const projectDir = resolveProjectDir(raw);
  if (!projectDir) return badRequest(res, 'projectDir is required');
  try {
    const [config, models] = await Promise.all([readConfig(projectDir), listModels(projectDir)]);
    res.json({ config, models, steps: AGENT_STEPS, efforts: EFFORTS });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
```

TO:

```javascript
  const projectDir = resolveProjectDir(raw);
  if (!projectDir) return badRequest(res, 'projectDir is required');
  try {
    // readRunConfig returns the full per-project config: legacy steps/customModels
    // PLUS the run-config workflows{} (node model/effort, feedback cycles) and
    // activeWorkflowId. It is a superset of readConfig, so the client keeps using
    // config.steps unchanged while gaining config.workflows / config.activeWorkflowId.
    const [config, models] = await Promise.all([readRunConfig(projectDir), listModels(projectDir)]);
    res.json({ config, models, steps: AGENT_STEPS, efforts: EFFORTS });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
```

> Confirm against the real `config.mjs`: the CONTRACT says `readRunConfig(projectDir) -> RunConfig` where RunConfig extends the legacy `{ steps, customModels }` with `workflows` + optional `activeWorkflowId`. If Phase 2 instead keeps `readConfig` returning only legacy keys and `readRunConfig` returning only the workflows slice, merge them here: `const base = await readConfig(...); const rc = await readRunConfig(...); const config = { ...base, ...rc };`. Re-read before implementing.

- [ ] **Step 5: Add the PATCH /api/config handler**

In `ui/server.mjs`, immediately after the `POST /api/config` handler (ends `ui/server.mjs:452`), add:

```javascript
// ---------------------------------------------------------------------------
// PATCH /api/config -> write run-config: per-node model/effort, per-feedback
// cycle counts, and the active workflow id. Keyed by workflowId + node/feedback
// instance ids (see RunConfig in the design). Legacy per-role `steps` are
// written via POST /api/config and are left untouched here. Validation (unknown
// model/effort, maxCycles >= 1) lives in src/core/config.mjs.
// body: { projectDir, workflowId, nodes?:{[id]:{model,effort}}, feedbacks?:{[id]:{maxCycles}}, activeWorkflowId? }
// ---------------------------------------------------------------------------
app.patch('/api/config', async (req, res) => {
  const body = req.body || {};
  const projectDir = resolveProjectDir(body.projectDir);
  if (!projectDir) return badRequest(res, 'projectDir is required');
  const workflowId = typeof body.workflowId === 'string' ? body.workflowId.trim() : '';
  try {
    if (body.nodes && typeof body.nodes === 'object') {
      if (!workflowId) return badRequest(res, 'workflowId is required to set node config');
      for (const [nodeId, sel] of Object.entries(body.nodes)) {
        await setNodeModel(projectDir, workflowId, nodeId, {
          model: sel && sel.model, effort: sel && sel.effort,
        });
      }
    }
    if (body.feedbacks && typeof body.feedbacks === 'object') {
      if (!workflowId) return badRequest(res, 'workflowId is required to set feedback config');
      for (const [fbId, sel] of Object.entries(body.feedbacks)) {
        await setFeedbackCycles(projectDir, workflowId, fbId, sel && sel.maxCycles);
      }
    }
    if (typeof body.activeWorkflowId === 'string' && body.activeWorkflowId.trim()) {
      await setActiveWorkflow(projectDir, body.activeWorkflowId.trim());
    }
    const config = await readRunConfig(projectDir);
    res.json({ config });
  } catch (err) {
    // The config.mjs setters throw only on validation (unknown model/effort,
    // maxCycles < 1) -> client error, mirroring POST /api/config.
    return badRequest(res, err && err.message ? err.message : String(err));
  }
});
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test --test-name-pattern='PATCH /api/config' test/api-workflows.test.mjs`
Expected: PASS — PATCH writes node model/effort + feedback cycles + activeWorkflowId; GET reflects them under `config.workflows[wfId]` / `config.activeWorkflowId`; legacy `config.steps` is preserved; missing `projectDir` → 400.

- [ ] **Step 7: Run the existing config suites for no regression**

Run: `node --test test/config-api.test.mjs test/config.test.mjs`
Expected: PASS — `GET /api/config` still returns `config.steps`/`config.customModels` (now a superset), `config.models`, `config.steps` defs and `config.efforts`; `POST /api/config` is unchanged. The existing assertions read `j.config.steps.*` and `j.models`, which remain present.

- [ ] **Step 8: Commit**

```bash
git add ui/server.mjs test/api-workflows.test.mjs
git commit -m "feat(api): extend GET/PATCH /api/config for run-config nodes/feedbacks + activeWorkflowId

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Phase verification

- [ ] **Run the full new API suite**

Run: `MAESTRO_MOCK=1 node --test test/api-workflows.test.mjs`
Expected: PASS — all workflow CRUD, `/api/agents`, `/api/run` workflowId, and run-config PATCH/GET tests green.

- [ ] **Run the whole test suite for cross-suite regressions**

Run: `npm test`
Expected: PASS — every suite green (the `/api/run` and `/api/config` changes are additive supersets; the new core-module imports resolve because Phases 1–2 created `workflows.mjs`, `workflow-validator.mjs`, `agent-registry.mjs` and the `config.mjs` additions).

- [ ] **Run the offline smoke pipeline (end-to-end sanity, default workflow)**

Run: `MAESTRO_MOCK=1 npm run smoke`
Expected: completes a full mock pipeline with the implicit `wf_default` workflow (no `workflowId` passed from the CLI path), confirming the server change did not disturb the default run.

## Phase 5: Pipeline Composer view: canvas, drag/drop, wires, save, saved list

Ports the standalone mockup's drag/drop canvas into the real SPA, wired to the server: palette from the agent registry, **Save → `POST /api/workflows`**, saved list from **`GET /api/workflows`**, delete via **`DELETE /api/workflows/:id`**, **Reset to default** from **`GET /api/workflows/wf_default`** (`DEFAULT_WORKFLOW`). The view is a new router target (`data-view="composer"`) reached by a sidebar + topnav link (`data-nav="composer"`).

**Architecture decision (testability):** `ui/public/app.js` is a `type="module"` script with no exports that touches the DOM at import time, so its internals are only reachable through the full jsdom boot used by the other `test/ui-*.test.mjs` files. To unit-test the composer's pure logic without a DOM, this phase extracts the framework-free helpers into a new **`ui/public/composer-core.mjs`** (zero DOM access at import time, only `export`ed pure functions). `app.js` `import`s those helpers and keeps **only DOM wiring** (drag/drop listeners, element creation, fetch calls). `test/composer-ui.test.mjs` imports `composer-core.mjs` directly — no jsdom, no network (verified: a pure ESM module imports and tests cleanly under `node --test`).

**Unit-tested (this phase):** `topology()` snapshot serializer (contract `s{stepIdx}_{memberIdx}` node ids + remapped feedback `from`/`to`), `metaLine()` formatter (`"N steps · M agents · K feedback loops"`), `distinctAgents()` chip computation, `defaultTopologyFromTemplate()` (server `DEFAULT_WORKFLOW` → canvas `{steps,feedbacks}` with fresh local ids), `mergePalette()` (registry/agents response → ordered palette descriptors with embedded fallback). **Manually verified (not unit-tested — jsdom has no real layout/HTML5 drag-and-drop):** drag a palette pill onto a gap strip (new sequential step) and onto a column (parallel member); `paintWires` SVG bezier/arc geometry; hover-loop → linking-mode banner → click-target feedback creation; feedback delete-X hit target; read-only preview rendering. These are exercised by `MAESTRO_MOCK=1 npm run smoke` + a browser smoke pass noted at the end.

**Source of truth:** `docs/pipeline-composer/mockups/maestro-standalone-mockup.html` — decode its `<script type="__bundler/template">` line with `JSON.parse` to read the real CSS (mockup lines 581–699), the composer markup (mockup lines 1115–1163, there under the legacy `data-view="settings"`), and the JS IIFE (mockup lines 1255–1636: `buildPalette`/`buildDefault`/`nodeEl`/`makeStrip`/`makeCol`/`refresh`/`paintWires`/`toggleLink`/`enterLink`/`exitLink`/`addFeedback`/`removeNode`/`snapshot`/`renderRO`/`renderList`). The product view id is `composer` (not `settings`), uses the `.hidden` **class** (`style.css:47`) not `[hidden]`, default topology is the **4-step** Plan→Refine→Implement→Review (not the mockup's 8-step), and the palette is the **6** registry agents (not 11).

**Contract anchors verified:** router `VIEW_NAMES` (`app.js:2074`), `showView` (`app.js:2076`), `navLinks` (`app.js:2073`), `navLinks` click→hash + `hashchange` (`app.js:2088`,`app.js:2095`), boot `showView` (`app.js:2136`); `safeJson` (`app.js:1793`), `selectedProjectPath` (`app.js:1165`), `option()` (`app.js:473`), `renderStepConfigs` (`app.js:480`); sidebar `nav` (`index.html:23-38`), topnav (`index.html:55-59`), history view shape (`index.html:257-289`), `<script src="/app.js" type="module">` (`index.html:304`); CSS tokens (`style.css:10-34`), `.hidden` (`style.css:47`), `.topnav` (`style.css:500-507`). API per the contract: `GET /api/workflows` → `{ workflows:[DEFAULT_WORKFLOW, ...] }`, `GET /api/workflows/:id`, `POST /api/workflows` body `{name,steps,feedbacks}` → `201 {workflow}`, `DELETE /api/workflows/:id` → `{ok:true}`; `GET /api/agents` (registry; tolerated-absent → embedded fallback). `WorkflowTemplate` shape `{id,name,version,steps:Array<Array<{id,key}>>,feedbacks:Array<{id,from,to}>,createdAt,updatedAt}`.

---

### Task 1: Extract pure composer helpers into `composer-core.mjs` (snapshot/topology serializer)

**Files:**
- Create: `ui/public/composer-core.mjs`
- Create (test): `test/composer-ui.test.mjs`

- [ ] **Step 1: Write the failing test for `topology()`.** This is the contract serializer: it walks the canvas model (`steps: Array<Array<{id,key}>>` with arbitrary local ids like `n7`, `feedbacks: Array<{from,to}>`) and produces contract node ids `s{stepIdx}_{memberIdx}`, remapping every feedback's `from`/`to` from the old local id to the new contract id. Create `test/composer-ui.test.mjs`:

```js
// test/composer-ui.test.mjs — pure-helper unit tests for the Pipeline Composer.
// No jsdom / no network: composer-core.mjs is DOM-free by construction, so these
// run as plain ESM under `node --test`. DOM wiring (drag/drop, paintWires SVG,
// link-mode) is verified manually + by `MAESTRO_MOCK=1 npm run smoke`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  topology,
  metaLine,
  distinctAgents,
  defaultTopologyFromTemplate,
  mergePalette,
  EMBEDDED_AGENTS,
} from '../ui/public/composer-core.mjs';

test('topology() reindexes node ids to s{step}_{member} and remaps feedbacks', () => {
  const steps = [
    [{ id: 'n1', key: 'planner' }],
    [{ id: 'n2', key: 'implementer' }, { id: 'n3', key: 'manualTestsChecklist' }],
    [{ id: 'n4', key: 'reviewer' }],
  ];
  const feedbacks = [{ from: 'n4', to: 'n2' }];
  const out = topology(steps, feedbacks);
  assert.deepEqual(
    out.steps,
    [
      [{ id: 's0_0', key: 'planner' }],
      [{ id: 's1_0', key: 'implementer' }, { id: 's1_1', key: 'manualTestsChecklist' }],
      [{ id: 's2_0', key: 'reviewer' }],
    ],
  );
  assert.deepEqual(out.feedbacks, [{ id: 'fb_0', from: 's2_0', to: 's1_0' }]);
});

test('topology() drops a feedback whose endpoint no longer exists', () => {
  const steps = [[{ id: 'a', key: 'planner' }], [{ id: 'b', key: 'reviewer' }]];
  const feedbacks = [{ from: 'b', to: 'a' }, { from: 'b', to: 'ghost' }];
  const out = topology(steps, feedbacks);
  assert.equal(out.feedbacks.length, 1);
  assert.deepEqual(out.feedbacks[0], { id: 'fb_0', from: 's1_0', to: 's0_0' });
});

test('topology() returns empty arrays for an empty canvas', () => {
  assert.deepEqual(topology([], []), { steps: [], feedbacks: [] });
});
```

- [ ] **Step 2: Run the test — expect FAIL (module missing).**
  - Command: `node --test test/composer-ui.test.mjs`
  - Expected: FAILs — `Cannot find module '.../ui/public/composer-core.mjs'`.

- [ ] **Step 3: Create `ui/public/composer-core.mjs` with `topology()` (and the symbols the test imports, stubbed minimally so the file imports).** Implement `topology()` fully now; add real bodies for the other exports in later tasks (they have their own failing tests). Write `ui/public/composer-core.mjs`:

```js
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
```

- [ ] **Step 4: Run the test — expect the `topology()` cases to PASS** (other exports are stubbed; their tests don't exist yet).
  - Command: `node --test test/composer-ui.test.mjs`
  - Expected: 3 passing `topology()` tests, 0 fail.

- [ ] **Step 5: Commit.**
  - `git add ui/public/composer-core.mjs test/composer-ui.test.mjs`
  - `git commit -m "feat(composer): add DOM-free composer-core with topology() serializer"`

---

### Task 2: `metaLine()` + `distinctAgents()` pure helpers

**Files:**
- Modify: `ui/public/composer-core.mjs`
- Modify (test): `test/composer-ui.test.mjs`

- [ ] **Step 1: Add failing tests** for the saved-card meta formatter and the distinct-agent chip computation. Append to `test/composer-ui.test.mjs`:

```js
test('metaLine() formats "N steps · M agents" with no loops', () => {
  const steps = [[{ id: 's0_0', key: 'planner' }], [{ id: 's1_0', key: 'reviewer' }]];
  assert.equal(metaLine(steps, []), '2 steps · 2 agents');
});

test('metaLine() singularises one feedback loop', () => {
  const steps = [[{ id: 's0_0', key: 'planner' }], [{ id: 's1_0', key: 'reviewer' }]];
  assert.equal(metaLine(steps, [{ id: 'fb_0', from: 's1_0', to: 's0_0' }]), '2 steps · 2 agents · 1 feedback loop');
});

test('metaLine() pluralises multiple feedback loops and counts parallel members as agents', () => {
  const steps = [
    [{ id: 's0_0', key: 'planner' }],
    [{ id: 's1_0', key: 'implementer' }, { id: 's1_1', key: 'manualTestsChecklist' }],
    [{ id: 's2_0', key: 'reviewer' }],
  ];
  const fbs = [{ id: 'fb_0', from: 's2_0', to: 's1_0' }, { id: 'fb_1', from: 's2_0', to: 's0_0' }];
  assert.equal(metaLine(steps, fbs), '3 steps · 4 agents · 2 feedback loops');
});

test('distinctAgents() returns first-seen-ordered unique keys', () => {
  const steps = [
    [{ id: 's0_0', key: 'planner' }],
    [{ id: 's1_0', key: 'implementer' }, { id: 's1_1', key: 'implementer' }],
    [{ id: 's2_0', key: 'reviewer' }],
    [{ id: 's3_0', key: 'planner' }],
  ];
  assert.deepEqual(distinctAgents(steps), ['planner', 'implementer', 'reviewer']);
});
```

- [ ] **Step 2: Run — expect FAIL.**
  - Command: `node --test test/composer-ui.test.mjs`
  - Expected: the 4 new tests FAIL (`metaLine` returns `''`, `distinctAgents` returns `[]`).

- [ ] **Step 3: Implement both helpers.** Replace the stubs in `ui/public/composer-core.mjs`:

```js
// metaLine(steps, feedbacks) -> "N steps · M agents[ · K feedback loop(s)]"
// (saved-pipelines card meta line). Mirrors the mockup's renderList meta string.
export function metaLine(steps, feedbacks) {
  const nSteps = steps.length;
  const nAgents = steps.reduce((sum, col) => sum + col.length, 0);
  const nLoops = (feedbacks || []).length;
  let s = `${nSteps} steps · ${nAgents} agents`;
  if (nLoops) s += ` · ${nLoops} feedback loop${nLoops > 1 ? 's' : ''}`;
  return s;
}

// distinctAgents(steps) -> ordered unique role keys (for the chip row).
export function distinctAgents(steps) {
  const seen = [];
  steps.forEach((col) => col.forEach((node) => {
    if (!seen.includes(node.key)) seen.push(node.key);
  }));
  return seen;
}
```

- [ ] **Step 4: Run — expect PASS** (all Task 1 + Task 2 tests green).
  - Command: `node --test test/composer-ui.test.mjs`

- [ ] **Step 5: Commit.**
  - `git add ui/public/composer-core.mjs test/composer-ui.test.mjs`
  - `git commit -m "feat(composer): add metaLine + distinctAgents helpers"`

---

### Task 3: Embedded registry + `mergePalette()` + `defaultTopologyFromTemplate()`

**Files:**
- Modify: `ui/public/composer-core.mjs`
- Modify (test): `test/composer-ui.test.mjs`

- [ ] **Step 1: Add failing tests** for the palette merge (registry response → ordered descriptors, with embedded fallback) and the default-topology converter (server `DEFAULT_WORKFLOW` template → canvas model with fresh local ids). Append to `test/composer-ui.test.mjs`:

```js
test('EMBEDDED_AGENTS covers the six canonical keys with color + icon', () => {
  const keys = ['planner', 'refiner', 'implementer', 'reviewer', 'manualTestsChecklist', 'manualWebUiTesting'];
  for (const k of keys) {
    assert.ok(EMBEDDED_AGENTS[k], `missing embedded agent ${k}`);
    assert.equal(typeof EMBEDDED_AGENTS[k].displayName, 'string');
    assert.equal(typeof EMBEDDED_AGENTS[k].color, 'string');
    assert.equal(typeof EMBEDDED_AGENTS[k].icon, 'string');
  }
});

test('mergePalette() falls back to the embedded registry, ordered by .order', () => {
  const pal = mergePalette(null);
  assert.equal(pal.length, 6);
  assert.deepEqual(pal.map((a) => a.key), [
    'planner', 'refiner', 'implementer', 'reviewer', 'manualTestsChecklist', 'manualWebUiTesting',
  ]);
  assert.equal(pal[0].displayName, 'Plan');
});

test('mergePalette() prefers the server agents array and sorts by order', () => {
  const agents = [
    { key: 'reviewer', displayName: 'Review', color: 'blue', icon: '<path/>', order: 4 },
    { key: 'planner', displayName: 'Plan', color: 'violet', icon: '<path/>', order: 1 },
  ];
  const pal = mergePalette({ agents });
  assert.deepEqual(pal.map((a) => a.key), ['planner', 'reviewer']);
  assert.equal(pal[0].color, 'violet');
});

test('defaultTopologyFromTemplate() converts a server template to a canvas model with fresh local ids', () => {
  const tpl = {
    id: 'wf_default',
    name: 'Default',
    steps: [
      [{ id: 's0_0', key: 'planner' }],
      [{ id: 's1_0', key: 'refiner' }],
      [{ id: 's2_0', key: 'implementer' }],
      [{ id: 's3_0', key: 'reviewer' }],
    ],
    feedbacks: [
      { id: 'fb_0', from: 's1_0', to: 's0_0' },
      { id: 'fb_1', from: 's3_0', to: 's2_0' },
    ],
  };
  let n = 0;
  const mk = (key) => ({ id: `L${n++}`, key }); // deterministic local-id factory
  const model = defaultTopologyFromTemplate(tpl, mk);
  assert.deepEqual(model.steps.map((c) => c.map((x) => x.key)),
    [['planner'], ['refiner'], ['implementer'], ['reviewer']]);
  // local ids are fresh (from mk), NOT the server s*_* ids
  assert.equal(model.steps[0][0].id, 'L0');
  assert.equal(model.steps[3][0].id, 'L3');
  // feedbacks reference the fresh local ids (refine->plan, review->implement)
  assert.deepEqual(model.feedbacks, [
    { from: 'L1', to: 'L0' },
    { from: 'L3', to: 'L2' },
  ]);
});

test('defaultTopologyFromTemplate() tolerates a missing/empty template', () => {
  const model = defaultTopologyFromTemplate(null, (key) => ({ id: 'x', key }));
  assert.deepEqual(model, { steps: [], feedbacks: [] });
});
```

- [ ] **Step 2: Run — expect FAIL.**
  - Command: `node --test test/composer-ui.test.mjs`
  - Expected: the 5 new tests FAIL.

- [ ] **Step 3: Implement `EMBEDDED_AGENTS`, `mergePalette()`, `defaultTopologyFromTemplate()`.** The embedded descriptors mirror the design spec §4.1 colors (planner=violet, refiner=green, implementer=peach, reviewer=blue, manualTestsChecklist=blue, manualWebUiTesting=violet) and reuse the mockup ICON glyphs (`plan`/`refine`/`implement`/`review`/`manualChecklist`; `manualWebUiTesting` reuses the mockup's `testsExec` play-glyph). Replace the stubs in `ui/public/composer-core.mjs`:

```js
// Embedded agent registry — fallback for the palette when /api/agents is
// unavailable (e.g. a sibling phase's endpoint not yet wired). Keys are the
// canonical camelCase agent keys; icon = inner SVG markup, viewBox "0 0 24 24"
// (glyphs copied from the standalone mockup's ICON map). The live registry from
// GET /api/agents overrides this whenever present (see mergePalette).
export const EMBEDDED_AGENTS = {
  planner: {
    key: 'planner', displayName: 'Plan', description: 'architecture & breakdown',
    color: 'violet', order: 1,
    icon: '<path d="M8 6h11M8 12h11M8 18h8" stroke-linecap="round"/><circle cx="4" cy="6" r="1.1"/><circle cx="4" cy="12" r="1.1"/><circle cx="4" cy="18" r="1.1"/>',
  },
  refiner: {
    key: 'refiner', displayName: 'Refine Plan', description: 'tighten the plan',
    color: 'green', order: 2,
    icon: '<path d="M12 3v3M12 18v3M4.5 7.5l2 1M17.5 15.5l2 1M4.5 16.5l2-1M17.5 8.5l2-1" stroke-linecap="round"/><path d="M12 8.2l1.2 2.6L16 12l-2.8 1.2L12 15.8l-1.2-2.6L8 12l2.8-1.2L12 8.2Z" stroke-linejoin="round"/>',
  },
  implementer: {
    key: 'implementer', displayName: 'Implementation', description: 'write the code',
    color: 'peach', order: 3,
    icon: '<path d="M9 8l-4 4 4 4M15 8l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  reviewer: {
    key: 'reviewer', displayName: 'Review Implementation', description: 'verify & report',
    color: 'blue', order: 4,
    icon: '<path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6l7-3Z" stroke-linejoin="round"/><path d="M9 12l2 2 4-4" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  manualTestsChecklist: {
    key: 'manualTestsChecklist', displayName: 'Manual Tests Checklist', description: 'draft manual cases',
    color: 'blue', order: 5,
    icon: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9.5 4V2.8h5V4" stroke-linejoin="round"/><path d="M8.8 12l1.6 1.6L13.4 10" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  manualWebUiTesting: {
    key: 'manualWebUiTesting', displayName: 'Manual web UI testing', description: 'run cases via Playwright',
    color: 'violet', order: 6,
    icon: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l5 3.5-5 3.5V8.5Z" fill="currentColor" stroke="none"/>',
  },
};

// mergePalette(agentsResponse) -> ordered Array<{key,displayName,description,color,icon,order}>.
// Prefers the live registry (GET /api/agents -> { agents:[…] } or a bare array);
// falls back to EMBEDDED_AGENTS. Always sorted by .order so the palette is stable.
export function mergePalette(agentsResponse) {
  let list = null;
  if (Array.isArray(agentsResponse)) list = agentsResponse;
  else if (agentsResponse && Array.isArray(agentsResponse.agents)) list = agentsResponse.agents;
  if (!list || !list.length) list = Object.values(EMBEDDED_AGENTS);
  return list
    .map((a) => ({
      key: a.key,
      displayName: a.displayName || a.key,
      description: a.description || '',
      color: a.color || 'blue',
      icon: a.icon || '',
      order: typeof a.order === 'number' ? a.order : 99,
    }))
    .sort((x, y) => x.order - y.order);
}

// defaultTopologyFromTemplate(tpl, mk) -> canvas model {steps,feedbacks} with
// FRESH local ids (mk(key) -> {id,key}). The server template's instance ids
// (s*_*) are deliberately discarded: once on the canvas, nodes get throwaway
// local ids and topology() re-stamps contract ids on save. Feedback edges are
// rewired from server ids to the new local ids by walking the same order.
export function defaultTopologyFromTemplate(tpl, mk) {
  if (!tpl || !Array.isArray(tpl.steps) || !tpl.steps.length) {
    return { steps: [], feedbacks: [] };
  }
  const remap = {}; // serverId -> localId
  const steps = tpl.steps.map((col) =>
    col.map((node) => {
      const local = mk(node.key);
      remap[node.id] = local.id;
      return local;
    }),
  );
  const feedbacks = (tpl.feedbacks || [])
    .filter((fb) => remap[fb.from] && remap[fb.to])
    .map((fb) => ({ from: remap[fb.from], to: remap[fb.to] }));
  return { steps, feedbacks };
}
```

- [ ] **Step 4: Run — expect PASS** (all composer-core tests green).
  - Command: `node --test test/composer-ui.test.mjs`

- [ ] **Step 5: Commit.**
  - `git add ui/public/composer-core.mjs test/composer-ui.test.mjs`
  - `git commit -m "feat(composer): embedded registry + mergePalette + default-topology converter"`

---

### Task 4: Composer nav links + view markup in `index.html`

**Files:**
- Modify: `ui/public/index.html` (sidebar nav `index.html:23-38`; topnav `index.html:55-59`; add a `data-view="composer"` section before `</main>` at `index.html:290`)

- [ ] **Step 1: Add the sidebar nav link.** After the History `<a>` block (the one ending at `index.html:37`, just before `</nav>` at `index.html:38`) insert the Composer link (icon = the mockup's "settings"/blocks glyph from mockup line 729):

```html
          <a href="#composer" data-nav="composer">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="9" width="6" height="6" rx="1.6"></rect><rect x="15" y="4" width="6" height="5.5" rx="1.6"></rect><rect x="15" y="14.5" width="6" height="5.5" rx="1.6"></rect><path d="M9 12h2.5M11.5 12V6.8H15M11.5 12v5.3H15"></path></svg>
            <span>Pipeline Composer</span>
          </a>
```

- [ ] **Step 2: Add the topnav link.** After the History topnav `<a>` (`index.html:58`, before `</nav>` at `index.html:59`) insert:

```html
          <a href="#composer" data-nav="composer">Composer</a>
```

- [ ] **Step 3: Add the composer view section.** Immediately before `</main>` (`index.html:290`), after the history view's closing comment (`index.html:289`), insert the full section. Markup is ported from the mockup (lines 1115–1162) but: view id `composer` with the `.hidden` **class**; ids namespaced `composer-*` to avoid colliding with the New-pipeline form (`#mock`, `#seg`, etc.); legend/banner/toolbar/saved-card preserved verbatim in structure:

```html
        <!-- ===== VIEW: PIPELINE COMPOSER ===== -->
        <section class="view hidden" data-view="composer">
          <div class="topbar">
            <div>
              <h1>Pipeline Composer</h1>
              <div class="sub">Compose how your agents collaborate — drag, stack, and loop them into a pipeline</div>
            </div>
            <button type="button" class="btn-ghost" id="composer-reset" style="padding:11px 20px">Reset to default</button>
          </div>

          <section class="card builder-card">
            <div class="palette">
              <span class="p-label">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="2"></circle><circle cx="6" cy="18" r="2"></circle><circle cx="18" cy="6" r="2"></circle><circle cx="18" cy="18" r="2"></circle></svg>
                Agents · drag onto the canvas to build your pipeline
              </span>
              <div id="composer-palette" style="display:contents"></div>
            </div>

            <div class="canvas-wrap" id="composer-canvas-wrap">
              <div class="flow" id="composer-flow">
                <svg class="wires" id="composer-wires"></svg>
              </div>
            </div>

            <div class="builder-foot">
              <div class="legend">
                <span class="lg"><span class="ll"></span> sequential — runs in order</span>
                <span class="lg"><span class="ll fb"></span> feedback loop</span>
              </div>
              <span class="link-banner" id="composer-link-banner" hidden>
                <span id="composer-link-text">Click a target agent to draw a feedback loop</span>
                <button type="button" id="composer-link-cancel">Cancel</button>
              </span>
              <span class="sp"></span>
              <button type="button" class="btn-ghost" id="composer-clear" style="padding:10px 18px">Clear canvas</button>
              <button type="button" class="btn-go" id="composer-save">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"></path></svg>
                Save pipeline
              </button>
            </div>
          </section>

          <section class="card saved-card">
            <div class="saved-head">
              <div><b>Saved pipelines</b><span class="cnt" id="composer-saved-count"></span></div>
            </div>
            <div class="saved-list" id="composer-saved-list"></div>
          </section>
        </section>
        <!-- /view composer -->
```

- [ ] **Step 4: Sanity-check the markup parses** (jsdom must still boot for the existing UI tests).
  - Command: `node --test test/ui-shell.test.mjs test/ui-boot.test.mjs`
  - Expected: PASS (the new section is `.hidden` and inert until the composer module wires it next; nothing references the new ids yet).

- [ ] **Step 5: Commit.**
  - `git add ui/public/index.html`
  - `git commit -m "feat(composer): add Pipeline Composer nav links + view markup"`

---

### Task 5: Composer CSS in `style.css`

**Files:**
- Modify: `ui/public/style.css` (append composer block; reuse existing tokens `style.css:10-34`)

- [ ] **Step 1: Append the composer styles.** Ported verbatim (geometry/colors) from the mockup CSS (lines 581–699) — `.builder-card`, `.palette`/`.agent-pill`/`.p-label`, `.canvas-wrap`/`.flow`/`.wires`, `.strip`/`.col`/`.node` (+ `.nx`/`.loop`/`.linking`/`.link-target`), `.builder-foot`/`.legend`/`.link-banner`/`.empty-flow`, `.saved-card`/`.saved-head`/`.saved-list`/`.pl-item`/`.pl-row`/`.pl-chip`/`.pl-del`/`.pl-body`/`.pl-readonly-tag`/`.ro-scroll`/`.ro-flow`. All `var(--…)` already exist in `:root`. Append to the end of `ui/public/style.css`:

```css
/* ========================================================================== */
/* Pipeline Composer — drag/drop canvas, wires, palette, saved list           */
/* (ported from docs/pipeline-composer/mockups; reuses :root tokens)          */
/* ========================================================================== */
.builder-card{padding:0;overflow:hidden;}
.palette{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:20px 24px;border-bottom:1px solid var(--line);background:var(--panel);}
.palette .p-label{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);width:100%;margin-bottom:4px;}
.palette .p-label svg{width:14px;height:14px;stroke:var(--ink-3);stroke-width:2;}
.agent-pill{display:inline-flex;align-items:center;gap:9px;background:#fff;border:1.5px solid var(--line-2);border-radius:999px;padding:8px 15px 8px 11px;font-weight:600;font-size:12.5px;color:var(--ink);cursor:grab;box-shadow:var(--shadow-soft);transition:transform .12s,box-shadow .12s,border-color .12s;user-select:none;}
.agent-pill:hover{transform:translateY(-1px);box-shadow:var(--shadow);}
.agent-pill:active{cursor:grabbing;}
.agent-pill.dragging{opacity:.35;}
.agent-pill .pdotc{width:11px;height:11px;border-radius:50%;flex:0 0 auto;}

.canvas-wrap{position:relative;overflow:auto;background-color:#FBFBF9;min-height:500px;max-height:640px;background-image:radial-gradient(circle, var(--line-2) 1.1px, transparent 1.1px);background-size:22px 22px;}
.flow{position:relative;display:flex;align-items:center;gap:0;padding:70px 30px 50px;min-height:500px;width:max-content;min-width:100%;}
.wires{position:absolute;top:0;left:0;overflow:visible;pointer-events:none;}

.strip{flex:0 0 16px;align-self:stretch;border-radius:12px;margin:40px 0;position:relative;transition:flex-basis .14s,background .14s;}
.strip.full{flex:1;}
.strip.over{flex-basis:78px;background:rgba(140,127,214,.12);outline:2px dashed var(--violet);outline-offset:-5px;}
.strip.over::after{content:"+ step";position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:10.5px;font-weight:700;letter-spacing:.05em;color:var(--violet-ink);white-space:nowrap;text-transform:uppercase;}

.col{display:flex;flex-direction:column;gap:18px;align-items:center;justify-content:center;align-self:center;padding:14px 10px;border-radius:20px;position:relative;z-index:1;transition:background .14s,outline-color .14s;outline:2px dashed transparent;outline-offset:0;}
.col.over{background:rgba(91,166,204,.10);outline-color:var(--blue);}
.col .col-tag{position:absolute;top:8px;left:50%;transform:translate(-50%,-100%);font-size:10px;font-weight:700;letter-spacing:.07em;color:var(--ink-3);text-transform:uppercase;white-space:nowrap;}
.col .col-tag em{font-style:normal;color:var(--blue-ink);}
.col .par-hint{position:absolute;bottom:6px;left:50%;transform:translate(-50%,100%);font-size:10.5px;font-weight:700;letter-spacing:.05em;color:var(--blue-ink);text-transform:uppercase;opacity:0;transition:opacity .14s;white-space:nowrap;}
.col.over .par-hint{opacity:1;}

.node{position:relative;width:230px;background:#fff;border:1.5px solid var(--line-2);border-radius:16px;box-shadow:var(--shadow-soft);padding:13px 14px 13px 18px;display:flex;align-items:center;gap:12px;z-index:2;transition:box-shadow .12s,transform .12s;}
.node:hover{box-shadow:var(--shadow);}
.node::before{content:"";position:absolute;left:0;top:11px;bottom:11px;width:5px;border-radius:0 5px 5px 0;background:var(--c,#ccc);}
.node .nic{width:36px;height:36px;border-radius:11px;display:grid;place-items:center;flex:0 0 auto;}
.node .nic svg{width:19px;height:19px;stroke-width:1.85;}
.node .nmeta{min-width:0;flex:1;}
.node .nmeta b{display:block;font-weight:600;font-size:13.5px;line-height:1.2;letter-spacing:-.01em;}
.node .nmeta small{display:block;color:var(--ink-3);font-size:11px;margin-top:1px;}
.node .nx,.node .loop{position:absolute;border-radius:50%;background:#fff;border:1.5px solid var(--line-2);display:grid;place-items:center;cursor:pointer;opacity:0;transition:.12s;box-shadow:var(--shadow-soft);z-index:3;}
.node .nx{top:-9px;right:-9px;width:22px;height:22px;color:var(--ink-3);font-size:12px;}
.node .loop{right:-10px;bottom:-10px;width:25px;height:25px;}
.node:hover .nx,.node:hover .loop{opacity:1;}
.node .nx:hover{color:var(--red-ink);border-color:var(--red);}
.node .loop svg{width:13px;height:13px;stroke:var(--ink-2);stroke-width:2;}
.node .loop:hover{border-color:var(--amber);}
.node .loop:hover svg{stroke:var(--amber-ink);}
.node.linking{outline:2px solid var(--amber);outline-offset:3px;}
.node.linking .loop{opacity:1;border-color:var(--amber);background:var(--amber-bg);}
.node.link-target{outline:2px dashed var(--amber);outline-offset:3px;cursor:pointer;}
.node.link-target:hover{background:var(--amber-bg);}

.builder-foot{display:flex;align-items:center;gap:14px;padding:16px 24px;border-top:1px solid var(--line);background:var(--panel);flex-wrap:wrap;}
.legend{display:flex;align-items:center;gap:20px;font-size:12px;color:var(--ink-2);font-weight:600;}
.legend .lg{display:flex;align-items:center;gap:8px;}
.legend .ll{width:28px;border-top:2.5px dashed var(--ink-3);}
.legend .ll.fb{border-top:2.5px dashed var(--amber);}
.builder-foot .sp{flex:1;}
.link-banner{display:inline-flex;align-items:center;gap:11px;background:var(--amber-bg);color:var(--amber-ink);font-weight:600;font-size:12.5px;padding:8px 9px 8px 15px;border-radius:999px;}
.link-banner[hidden]{display:none;}
.link-banner button{background:#fff;border:none;border-radius:999px;padding:5px 12px;font-family:inherit;font-weight:600;font-size:11.5px;color:var(--amber-ink);cursor:pointer;}
.empty-flow{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--ink-3);font-weight:600;font-size:14px;pointer-events:none;text-align:center;}
.empty-flow svg{width:36px;height:36px;stroke:var(--line-2);stroke-width:1.6;}
.empty-flow small{font-weight:500;font-size:12.5px;}

.saved-card{margin-top:22px;padding:0;overflow:hidden;}
.saved-head{display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid var(--line);}
.saved-head b{font-size:15px;font-weight:600;letter-spacing:-.01em;}
.saved-head .cnt{color:var(--ink-3);font-size:12.5px;font-weight:600;margin-left:9px;}
.saved-list{display:flex;flex-direction:column;}
.pl-empty{padding:34px 24px;text-align:center;color:var(--ink-3);font-size:13px;font-weight:500;}
.pl-item{border-bottom:1px solid var(--line);}
.pl-item:last-child{border-bottom:none;}
.pl-row{display:flex;align-items:center;gap:15px;padding:16px 22px;cursor:pointer;transition:background .12s;}
.pl-row:hover{background:var(--panel);}
.pl-caret{width:17px;height:17px;flex:0 0 auto;color:var(--ink-3);transition:transform .18s;margin-top:2px;align-self:flex-start;}
.pl-item.open .pl-caret{transform:rotate(90deg);}
.pl-main{flex:1;min-width:0;}
.pl-name{font-weight:600;font-size:14px;letter-spacing:-.01em;color:var(--ink);}
.pl-meta{font-size:11px;font-weight:600;color:var(--ink-3);text-transform:uppercase;letter-spacing:.05em;margin-top:5px;}
.pl-meta em{font-style:normal;color:var(--amber-ink);}
.pl-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:9px;}
.pl-chip{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:var(--ink-2);background:var(--field);border:1px solid var(--line);border-radius:999px;padding:3px 9px 3px 7px;}
.pl-chip .d{width:8px;height:8px;border-radius:50%;flex:0 0 auto;}
.pl-del{flex:0 0 auto;width:34px;height:34px;border-radius:10px;border:1.5px solid var(--line-2);background:#fff;display:grid;place-items:center;cursor:pointer;color:var(--ink-3);transition:.12s;align-self:flex-start;}
.pl-del:hover{border-color:var(--red);color:var(--red-ink);background:var(--red-bg);}
.pl-del svg{width:16px;height:16px;stroke-width:1.9;}
.pl-body{display:none;border-top:1px dashed var(--line-2);}
.pl-item.open .pl-body{display:block;}
.pl-readonly-tag{display:flex;align-items:center;gap:8px;padding:9px 24px;background:var(--panel);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);border-top:1px dashed var(--line-2);}
.pl-readonly-tag svg{width:13px;height:13px;stroke:var(--ink-3);stroke-width:2;}
.ro-scroll{overflow:auto;background-color:#FBFBF9;background-image:radial-gradient(circle, var(--line-2) 1.1px, transparent 1.1px);background-size:22px 22px;max-height:520px;}
.ro-flow{position:relative;display:flex;align-items:center;padding:26px 30px;min-height:360px;width:max-content;min-width:100%;}
.ro-flow .strip{flex:0 0 58px;align-self:stretch;margin:40px 0;}
.ro-flow .col{pointer-events:none;}
.ro-flow .node{width:218px;}
```

- [ ] **Step 2: Verify the stylesheet still loads** (existing CSS-touching UI tests stay green; this is additive).
  - Command: `node --test test/ui-theme.test.mjs test/ui-shell.test.mjs`
  - Expected: PASS.

- [ ] **Step 3: Commit.**
  - `git add ui/public/style.css`
  - `git commit -m "style(composer): port canvas/node/wire/palette/saved-list styles"`

---

### Task 6: Register `composer` in the router + `/api/workflows` + `/api/agents` client wrappers

**Files:**
- Modify: `ui/public/app.js` (`VIEW_NAMES` at `app.js:2074`; `showView` at `app.js:2076`; add wrappers near `loadConfig` `app.js:452`; import `composer-core.mjs` at top, near `app.js:22`)

- [ ] **Step 1: Add a failing jsdom router test** proving the composer view toggles into place via the hash router (reuses the existing `boot()` harness pattern from `test/ui-cost.test.mjs`). Create `test/ui-composer.test.mjs`:

```js
// test/ui-composer.test.mjs — jsdom boot test: the composer view is wired into
// the SPA router and its DOM shell renders. (Pure logic is in
// test/composer-ui.test.mjs; drag/drop + paintWires are manual-only.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));

const DEFAULT_WF = {
  id: 'wf_default', name: 'Default', version: 1,
  steps: [
    [{ id: 's0_0', key: 'planner' }],
    [{ id: 's1_0', key: 'refiner' }],
    [{ id: 's2_0', key: 'implementer' }],
    [{ id: 's3_0', key: 'reviewer' }],
  ],
  feedbacks: [{ id: 'fb_0', from: 's1_0', to: 's0_0' }, { id: 'fb_1', from: 's3_0', to: 's2_0' }],
  createdAt: 'x', updatedAt: 'x',
};

async function boot() {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  // jsdom has no layout: force offsetParent truthy so paintWires doesn't early-return on errors.
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', { get() { return window.document.body; }, configurable: true });
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} addEventListener() {} };
  window.fetch = (url) => {
    const u = String(url);
    if (u.includes('/api/workflows/wf_default')) return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_WF });
    if (u.includes('/api/workflows')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ workflows: [DEFAULT_WF] }) });
    if (u.includes('/api/agents')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ agents: [] }) });
    if (u.includes('/api/projects')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [] }) });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator', 'requestAnimationFrame']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(appPath + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  return window;
}

test('composer is a router view: hash #composer reveals the canvas section', async () => {
  const window = await boot();
  window.location.hash = 'composer';
  window.dispatchEvent(new window.Event('hashchange'));
  await new Promise((r) => setTimeout(r, 0));
  const view = window.document.querySelector('.view[data-view="composer"]');
  assert.ok(view, 'composer section exists');
  assert.equal(view.classList.contains('hidden'), false, 'composer view is shown');
  const others = [...window.document.querySelectorAll('.view')].filter((v) => v.dataset.view !== 'composer');
  assert.ok(others.every((v) => v.classList.contains('hidden')), 'other views hidden');
});

test('opening the composer builds the palette from the agents/embedded registry', async () => {
  const window = await boot();
  window.location.hash = 'composer';
  window.dispatchEvent(new window.Event('hashchange'));
  await new Promise((r) => setTimeout(r, 10));
  const pills = window.document.querySelectorAll('#composer-palette .agent-pill');
  assert.equal(pills.length, 6, 'six agent pills (embedded fallback)');
  assert.match(pills[0].textContent, /Plan/);
});
```

- [ ] **Step 2: Run — expect FAIL.**
  - Command: `node --test test/ui-composer.test.mjs`
  - Expected: FAIL — `'composer'` is not in `VIEW_NAMES`, so `hashchange` ignores it and the view stays `.hidden`; `#composer-palette` is empty (no module yet).

- [ ] **Step 3: Wire the router + add API wrappers + import the core helpers.** Three edits to `ui/public/app.js`:

  (a) After `STEP_ROLES` (`app.js:22`), add the import + a tiny composer state slot:

```js
import {
  topology,
  metaLine,
  distinctAgents,
  defaultTopologyFromTemplate,
  mergePalette,
} from './composer-core.mjs';
```

  (b) Change `VIEW_NAMES` (`app.js:2074`) to include `composer`, and extend `showView` (`app.js:2076`) to init the composer on first reveal:

```js
const VIEW_NAMES = ['new', 'running', 'history', 'composer'];

function showView(name) {
  views.forEach((v) => v.classList.toggle('hidden', v.dataset.view !== name));
  navLinks.forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
  if (name === 'running') renderRunningView();
  if (name === 'history') {
    const d = selectedProjectPath();
    if (d) loadHistory(d);
  }
  if (name === 'composer') initComposer();
}
```

  (c) Add the `/api/workflows` + `/api/agents` client wrappers next to `loadConfig` (after `app.js:467`). These reuse the existing `safeJson` (`app.js:1793`) helper and the project's `fetch` style:

```js
// ---------------------------------------------------------------------------
// Pipeline Composer — /api/workflows + /api/agents client wrappers
// ---------------------------------------------------------------------------
async function fetchAgents() {
  try {
    const res = await fetch('/api/agents');
    if (!res.ok) return null;
    return await safeJson(res);
  } catch {
    return null; // composer falls back to the embedded registry
  }
}

async function listWorkflows() {
  try {
    const res = await fetch('/api/workflows');
    const data = await safeJson(res);
    if (!res.ok) return [];
    return Array.isArray(data.workflows) ? data.workflows : [];
  } catch {
    return [];
  }
}

async function getWorkflow(id) {
  try {
    const res = await fetch(`/api/workflows/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return await safeJson(res);
  } catch {
    return null;
  }
}

async function saveWorkflow({ name, steps, feedbacks }) {
  const res = await fetch('/api/workflows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, steps, feedbacks }),
  });
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data.error || `save failed (${res.status})`);
  return data.workflow;
}

async function deleteWorkflow(id) {
  const res = await fetch(`/api/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data.error || `delete failed (${res.status})`);
  return true;
}
```

  Note: `initComposer()` is defined in Task 7 (idempotent, called here on first reveal). To keep this task self-contained and green, add a temporary minimal stub right after the wrappers — Task 7 replaces it:

```js
// Replaced by the full composer module in the next task.
let _composerStubInit = false;
function initComposer() {
  if (_composerStubInit) return;
  _composerStubInit = true;
  const palette = document.getElementById('composer-palette');
  if (!palette) return;
  fetchAgents().then((res) => {
    palette.innerHTML = '';
    mergePalette(res).forEach((ag) => {
      const p = document.createElement('div');
      p.className = 'agent-pill';
      p.dataset.key = ag.key;
      p.textContent = ag.displayName;
      palette.appendChild(p);
    });
  });
}
```

- [ ] **Step 4: Run — expect PASS** (router reveals the view; palette has 6 pills).
  - Command: `node --test test/ui-composer.test.mjs`

- [ ] **Step 5: Run the full UI suite to confirm no regression** (new view added to `VIEW_NAMES`, new import).
  - Command: `node --test test/ui-*.mjs`
  - Expected: all PASS.

- [ ] **Step 6: Commit.**
  - `git add ui/public/app.js test/ui-composer.test.mjs`
  - `git commit -m "feat(composer): register composer route + /api/workflows + /api/agents client wrappers"`

---

### Task 7: Full composer module — palette, drag/drop canvas, wires, link mode, Reset/Clear/Save

**Files:**
- Modify: `ui/public/app.js` (replace the `initComposer` stub from Task 6 with the full module)

- [ ] **Step 1: Extend the jsdom test** to assert Save serializes via `topology()` and POSTs the contract body, and Reset rebuilds the 4-step default. Append to `test/ui-composer.test.mjs` (the `boot()` harness above already mocks the endpoints; capture POSTs by overriding `window.fetch` after boot is awkward, so add a capture hook):

```js
test('Save serializes the canvas to contract topology and POSTs {name,steps,feedbacks}', async () => {
  const posted = [];
  // Re-run boot but intercept POST /api/workflows.
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', { get() { return window.document.body; }, configurable: true });
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  window.prompt = () => 'My Flow';
  window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} addEventListener() {} };
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('/api/workflows/wf_default')) return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_WF });
    if (u.endsWith('/api/workflows') && opts && opts.method === 'POST') {
      posted.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ workflow: { id: 'wf_x', name: JSON.parse(opts.body).name, ...JSON.parse(opts.body), version: 1, createdAt: 'x', updatedAt: 'x' } }) });
    }
    if (u.includes('/api/workflows')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ workflows: [DEFAULT_WF] }) });
    if (u.includes('/api/agents')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ agents: [] }) });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [], config: { steps: {}, customModels: [] }, models: [], efforts: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator', 'requestAnimationFrame']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(appPath + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  window.location.hash = 'composer';
  window.dispatchEvent(new window.Event('hashchange'));
  await new Promise((r) => setTimeout(r, 20)); // initComposer awaits Reset -> wf_default

  // The default render must produce 4 columns (Plan/Refine/Implement/Review).
  const cols = window.document.querySelectorAll('#composer-flow > .col');
  assert.equal(cols.length, 4, 'default = 4 steps');

  window.document.getElementById('composer-save').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(posted.length, 1, 'one POST');
  assert.equal(posted[0].name, 'My Flow');
  assert.deepEqual(posted[0].steps.map((c) => c.map((x) => x.key)),
    [['planner'], ['refiner'], ['implementer'], ['reviewer']]);
  assert.equal(posted[0].steps[0][0].id, 's0_0', 'contract instance ids');
  assert.equal(posted[0].feedbacks.length, 2, 'two default feedback loops');
});
```

- [ ] **Step 2: Run — expect FAIL** (the stub builds palette only; it never renders the default columns or wires Save).
  - Command: `node --test test/ui-composer.test.mjs`
  - Expected: the new test FAILs (`#composer-flow > .col` is empty; no POST).

- [ ] **Step 3: Replace the `initComposer` stub with the full composer module.** Remove the `_composerStubInit`/`initComposer` stub added in Task 6 and insert the module below in its place. It is the mockup IIFE (lines 1257–1636) re-expressed as named functions scoped under a single `initComposer()` guard, with the wiring changes called out in comments: palette from `fetchAgents()` via `mergePalette`; **Reset** loads `GET /api/workflows/wf_default` → `defaultTopologyFromTemplate`; **Save** serializes via `topology()` → `saveWorkflow` → reload list; saved list from `listWorkflows()`; delete via `deleteWorkflow()`. The DOM-free serialization (`topology`/`metaLine`/`distinctAgents`/`defaultTopologyFromTemplate`/`mergePalette`) is imported from `composer-core.mjs` (Tasks 1–3).

```js
// ---------------------------------------------------------------------------
// Pipeline Composer module (ported from docs/pipeline-composer/mockups).
// Pure serialization lives in composer-core.mjs; this is DOM wiring only.
// Manual-only behaviors (no jsdom layout / no HTML5 DnD): paintWires geometry,
// drag pills onto strips/cols, hover-loop link mode, read-only preview paint.
// ---------------------------------------------------------------------------
const COMPOSER_COLORS = { green: '#5BAE5B', peach: '#EFA63C', red: '#E76A5A', blue: '#5BA6CC', violet: '#8C7FD6', amber: '#E6962A' };
const COMPOSER_TINTS = { green: '#E2F3DF', peach: '#FCEEDA', red: '#FBE3E0', blue: '#DEEFF7', violet: '#EAE6F8', amber: '#FCE8C8' };
const COMPOSER_SEQ = '#B7B7BC';

let _composerReady = false;
const composer = {
  agents: {},          // key -> {key,displayName,description,color,icon}
  steps: [],           // Array<Array<{id,key}>> (local ids)
  feedbacks: [],       // Array<{from,to}> (local ids)
  saved: [],           // WorkflowTemplate[] from the server
  linkFrom: null,
  dragKey: null,
  uid: 1,
  els: {},
};
const composerMk = (key) => ({ id: 'n' + composer.uid++, key });
const composerAgent = (key) => composer.agents[key] || { displayName: key, description: '', color: 'blue', icon: '' };

async function initComposer() {
  if (_composerReady) { composerDrawWires(); return; }
  _composerReady = true;
  composer.els = {
    flow: document.getElementById('composer-flow'),
    wires: document.getElementById('composer-wires'),
    palette: document.getElementById('composer-palette'),
    banner: document.getElementById('composer-link-banner'),
    linkText: document.getElementById('composer-link-text'),
    list: document.getElementById('composer-saved-list'),
    count: document.getElementById('composer-saved-count'),
  };
  if (!composer.els.flow) return;

  // toolbar + global listeners (bound once)
  document.getElementById('composer-reset').addEventListener('click', () => { composerExitLink(); composerReset(); });
  document.getElementById('composer-clear').addEventListener('click', () => { composerExitLink(); composer.steps = []; composer.feedbacks = []; composerRefresh(); });
  document.getElementById('composer-save').addEventListener('click', composerSave);
  document.getElementById('composer-link-cancel').addEventListener('click', composerExitLink);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') composerExitLink(); });
  composer.els.wires.addEventListener('click', (e) => {
    const g = e.target.closest('.fb-del'); if (!g) return;
    composer.feedbacks.splice(+g.dataset.fb, 1); composerRefresh();
  });
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(composerDrawWires, 80); });
  if (window.ResizeObserver) new window.ResizeObserver(() => composerDrawWires()).observe(composer.els.flow);

  // palette from the registry (or embedded fallback)
  const agentsRes = await fetchAgents();
  const pal = mergePalette(agentsRes);
  composer.agents = {};
  pal.forEach((a) => { composer.agents[a.key] = a; });
  composerBuildPalette(pal);

  // initial canvas = the saved default workflow (4-step)
  await composerReset();
  await composerLoadSaved();
}

/* ---- palette ---- */
function composerBuildPalette(pal) {
  const palette = composer.els.palette;
  palette.innerHTML = '';
  pal.forEach((ag) => {
    const p = document.createElement('div');
    p.className = 'agent-pill';
    p.draggable = true;
    p.dataset.key = ag.key;
    p.innerHTML = `<span class="pdotc" style="background:${COMPOSER_COLORS[ag.color] || '#ccc'}"></span>${ag.displayName}`;
    p.addEventListener('dragstart', (e) => {
      composer.dragKey = ag.key; p.classList.add('dragging');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', ag.key); }
    });
    p.addEventListener('dragend', () => {
      composer.dragKey = null; p.classList.remove('dragging');
      document.querySelectorAll('.over').forEach((x) => x.classList.remove('over'));
    });
    palette.appendChild(p);
  });
}

/* ---- node ---- */
function composerNodeEl(a) {
  const ag = composerAgent(a.key);
  const d = document.createElement('div');
  d.className = 'node'; d.dataset.id = a.id; d.style.setProperty('--c', COMPOSER_COLORS[ag.color] || '#ccc');
  d.innerHTML =
    `<div class="nic" style="background:${COMPOSER_TINTS[ag.color] || '#eee'};color:${COMPOSER_COLORS[ag.color] || '#888'}">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">${ag.icon}</svg></div>` +
    `<div class="nmeta"><b>${ag.displayName}</b><small>${ag.description}</small></div>` +
    `<div class="nx" title="Remove agent">✕</div>` +
    `<div class="loop" title="Draw a feedback loop from this agent">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 9a5 5 0 0 1 5-5h9" stroke-linecap="round"/><path d="M14 1l3 3-3 3" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 15a5 5 0 0 1-5 5H7" stroke-linecap="round"/><path d="M10 23l-3-3 3-3" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;
  d.querySelector('.nx').addEventListener('click', (e) => { e.stopPropagation(); composerRemoveNode(a.id); });
  d.querySelector('.loop').addEventListener('click', (e) => { e.stopPropagation(); composerToggleLink(a.id); });
  d.addEventListener('click', () => { if (composer.linkFrom && composer.linkFrom !== a.id) { composerAddFeedback(composer.linkFrom, a.id); composerExitLink(); } });
  return d;
}

/* ---- drop helpers ---- */
function composerAllow(e) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; }
function composerMakeStrip(index, full) {
  const s = document.createElement('div');
  s.className = 'strip' + (full ? ' full' : '');
  s.addEventListener('dragover', (e) => { composerAllow(e); s.classList.add('over'); });
  s.addEventListener('dragleave', () => s.classList.remove('over'));
  s.addEventListener('drop', (e) => {
    e.preventDefault(); s.classList.remove('over');
    if (!composer.dragKey) return;
    composer.steps.splice(index, 0, [composerMk(composer.dragKey)]); composer.dragKey = null; composerRefresh();
  });
  return s;
}
function composerMakeCol(stepIdx) {
  const col = document.createElement('div');
  col.className = 'col';
  const tag = document.createElement('div'); tag.className = 'col-tag';
  tag.innerHTML = `Step ${stepIdx + 1}` + (composer.steps[stepIdx].length > 1 ? ' · <em>parallel</em>' : '');
  col.appendChild(tag);
  composer.steps[stepIdx].forEach((a) => col.appendChild(composerNodeEl(a)));
  const hint = document.createElement('div'); hint.className = 'par-hint'; hint.textContent = '+ run in parallel';
  col.appendChild(hint);
  col.addEventListener('dragover', (e) => { composerAllow(e); col.classList.add('over'); });
  col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); });
  col.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation(); col.classList.remove('over');
    if (!composer.dragKey) return;
    composer.steps[stepIdx].push(composerMk(composer.dragKey)); composer.dragKey = null; composerRefresh();
  });
  return col;
}

/* ---- render ---- */
function composerRefresh() {
  const flow = composer.els.flow;
  [...flow.querySelectorAll(':scope > .strip, :scope > .col, :scope > .empty-flow')].forEach((e) => e.remove());
  if (composer.steps.length === 0) {
    flow.appendChild(composerMakeStrip(0, true));
    const empty = document.createElement('div'); empty.className = 'empty-flow';
    empty.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 12h14M12 5v14" stroke-linecap="round"/></svg>' +
      'Drag an agent here to begin<small>Place agents left-to-right for sequence · stack them for parallel steps</small>';
    flow.appendChild(empty);
  } else {
    for (let i = 0; i < composer.steps.length; i++) { flow.appendChild(composerMakeStrip(i)); flow.appendChild(composerMakeCol(i)); }
    flow.appendChild(composerMakeStrip(composer.steps.length));
  }
  requestAnimationFrame(composerDrawWires);
}

/* ---- mutations ---- */
function composerRemoveNode(id) {
  for (let i = 0; i < composer.steps.length; i++) {
    const j = composer.steps[i].findIndex((a) => a.id === id);
    if (j >= 0) { composer.steps[i].splice(j, 1); if (composer.steps[i].length === 0) composer.steps.splice(i, 1); break; }
  }
  composer.feedbacks = composer.feedbacks.filter((f) => f.from !== id && f.to !== id);
  if (composer.linkFrom === id) composerExitLink();
  composerRefresh();
}
function composerAddFeedback(from, to) {
  if (from === to) return;
  if (!composer.feedbacks.some((f) => f.from === from && f.to === to)) composer.feedbacks.push({ from, to });
  composerRefresh();
}

/* ---- feedback linking mode ---- */
function composerToggleLink(id) { if (composer.linkFrom === id) composerExitLink(); else composerEnterLink(id); }
function composerEnterLink(id) {
  composer.linkFrom = id;
  composer.els.banner.hidden = false;
  const a = composer.steps.flat().find((n) => n.id === id);
  composer.els.linkText.textContent = `Loop from "${composerAgent(a.key).displayName}" → click a target agent`;
  composer.els.flow.querySelectorAll('.node').forEach((n) => {
    n.classList.toggle('linking', n.dataset.id === id);
    n.classList.toggle('link-target', n.dataset.id !== id);
  });
}
function composerExitLink() {
  composer.linkFrom = null;
  if (composer.els.banner) composer.els.banner.hidden = true;
  if (composer.els.flow) composer.els.flow.querySelectorAll('.node').forEach((n) => n.classList.remove('linking', 'link-target'));
}

/* ---- wires (shared renderer; ns-namespaced markers) ---- */
function composerPaintWires(flowEl, wiresEl, steps, feedbacks, opts) {
  opts = opts || {};
  const ns = opts.ns || 'main';
  if (flowEl.offsetParent === null) return; // view hidden — skip
  const rect = (id) => {
    const el = flowEl.querySelector(`.node[data-id="${id}"]`); if (!el) return null;
    const fr = flowEl.getBoundingClientRect(), r = el.getBoundingClientRect();
    return { x: r.left - fr.left, y: r.top - fr.top, w: r.width, h: r.height };
  };
  const W = flowEl.scrollWidth, H = flowEl.scrollHeight;
  wiresEl.setAttribute('width', W); wiresEl.setAttribute('height', H);
  wiresEl.style.width = W + 'px'; wiresEl.style.height = H + 'px';
  let s = `<defs>` +
    `<marker id="arrSeq-${ns}" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0 0L9 4.5L0 9z" fill="${COMPOSER_SEQ}"/></marker>` +
    `<marker id="arrFb-${ns}" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0 0L9 4.5L0 9z" fill="${COMPOSER_COLORS.amber}"/></marker></defs>`;
  for (let i = 0; i < steps.length - 1; i++) {
    steps[i].forEach((a) => {
      steps[i + 1].forEach((b) => {
        const ra = rect(a.id), rb = rect(b.id); if (!ra || !rb) return;
        const x1 = ra.x + ra.w, y1 = ra.y + ra.h / 2, x2 = rb.x, y2 = rb.y + rb.h / 2;
        const dx = Math.max(36, (x2 - x1) * 0.5);
        s += `<path d="M${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}" fill="none" stroke="${COMPOSER_SEQ}" stroke-width="2" stroke-dasharray="6 7" marker-end="url(#arrSeq-${ns})"/>`;
      });
    });
  }
  const posOf = (id) => { for (const st of steps) { const i = st.findIndex((a) => a.id === id); if (i >= 0) return { len: st.length, i }; } return { len: 1, i: 0 }; };
  let maxBottom = 0;
  steps.flat().forEach((a) => { const r = rect(a.id); if (r) maxBottom = Math.max(maxBottom, r.y + r.h); });
  feedbacks.forEach((fb, idx) => {
    const ra = rect(fb.from), rb = rect(fb.to); if (!ra || !rb) return;
    const p = posOf(fb.from);
    const below = p.len > 1 && p.i === p.len - 1;
    let sx, sy, tx, ty, rail, mx, my;
    if (below) {
      sx = ra.x + ra.w / 2; sy = ra.y + ra.h; tx = rb.x + rb.w / 2; ty = rb.y + rb.h;
      rail = maxBottom + Math.max(46, Math.abs(sx - tx) * 0.12);
      my = rail - (rail - Math.max(sy, ty)) * 0.18;
    } else {
      sx = ra.x + ra.w / 2; sy = ra.y; tx = rb.x + rb.w / 2; ty = rb.y;
      rail = Math.min(sy, ty) - Math.max(46, Math.abs(sx - tx) * 0.16);
      my = rail + (Math.min(sy, ty) - rail) * 0.18;
    }
    mx = (sx + tx) / 2;
    s += `<path d="M${sx} ${sy} C ${sx} ${rail}, ${tx} ${rail}, ${tx} ${ty}" fill="none" stroke="${COMPOSER_COLORS.amber}" stroke-width="2" stroke-dasharray="2 7" stroke-linecap="round" marker-end="url(#arrFb-${ns})"/>`;
    if (opts.del) {
      s += `<g class="fb-del" data-fb="${idx}" style="cursor:pointer;pointer-events:auto">` +
        `<circle cx="${mx}" cy="${my}" r="9.5" fill="#fff" stroke="${COMPOSER_COLORS.amber}" stroke-width="1.5"/>` +
        `<path d="M${mx - 3.2} ${my - 3.2}L${mx + 3.2} ${my + 3.2}M${mx + 3.2} ${my - 3.2}L${mx - 3.2} ${my + 3.2}" stroke="${COMPOSER_COLORS.amber}" stroke-width="1.7" stroke-linecap="round"/></g>`;
    }
  });
  wiresEl.innerHTML = s;
}
function composerDrawWires() {
  if (!composer.els.flow) return;
  composerPaintWires(composer.els.flow, composer.els.wires, composer.steps, composer.feedbacks, { ns: 'main', del: true });
}

/* ---- toolbar actions (server-wired) ---- */
async function composerReset() {
  const tpl = await getWorkflow('wf_default');
  const model = defaultTopologyFromTemplate(tpl, composerMk);
  composer.steps = model.steps;
  composer.feedbacks = model.feedbacks;
  composerRefresh();
}
async function composerSave() {
  if (!composer.steps.length) return;
  composerExitLink();
  const name = (window.prompt('Name this pipeline:', '') || '').trim();
  if (!name) return;
  const body = topology(composer.steps, composer.feedbacks); // {steps,feedbacks} with contract ids
  const saveBtn = document.getElementById('composer-save');
  try {
    await saveWorkflow({ name, steps: body.steps, feedbacks: body.feedbacks });
  } catch (e) {
    appendLog({ source: 'ui', level: 'error', text: `save pipeline: ${e.message}`, ts: Date.now() });
    return;
  }
  await composerLoadSaved();
  const first = composer.els.list.querySelector('.pl-item');
  if (first) first.querySelector('.pl-row').click();
  const html = saveBtn.innerHTML;
  saveBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg> Saved';
  saveBtn.style.background = 'var(--green-ink)';
  setTimeout(() => { saveBtn.innerHTML = html; saveBtn.style.background = ''; }, 1400);
}
```

  (The saved-list rendering — `composerLoadSaved`/`composerRenderList`/`composerRenderRO` — is added in Task 8; add this temporary stub right after `composerSave` so this task compiles and the default-render/Save tests pass; Task 8 replaces it):

```js
async function composerLoadSaved() {
  composer.saved = await listWorkflows();
  if (composer.els.count) composer.els.count.textContent = composer.saved.length + (composer.saved.length === 1 ? ' pipeline' : ' pipelines');
}
```

- [ ] **Step 4: Run — expect PASS** (default = 4 cols; Save POSTs contract topology).
  - Command: `node --test test/ui-composer.test.mjs`

- [ ] **Step 5: Confirm pure-helper + UI suites stay green.**
  - Command: `node --test test/composer-ui.test.mjs test/ui-*.mjs`
  - Expected: all PASS.

- [ ] **Step 6: Commit.**
  - `git add ui/public/app.js test/ui-composer.test.mjs`
  - `git commit -m "feat(composer): full canvas module — palette, drag/drop, wires, link mode, reset/clear/save"`

---

### Task 8: Saved-pipelines list — collapsible rows, meta line, chips, delete, read-only preview

**Files:**
- Modify: `ui/public/app.js` (replace the `composerLoadSaved` stub with the full saved-list renderer)

- [ ] **Step 1: Extend the jsdom test** to assert the saved list renders one row per server workflow with the correct meta line + distinct-agent chips, that expanding a row builds a read-only preview, and that delete calls `DELETE` and removes the row. Append to `test/ui-composer.test.mjs`:

```js
test('saved list renders rows with meta line + chips; expand builds a read-only preview; delete removes the row', async () => {
  const WF_QUICK = {
    id: 'wf_quickfix', name: 'Quick Fix', version: 1,
    steps: [
      [{ id: 's0_0', key: 'planner' }],
      [{ id: 's1_0', key: 'implementer' }],
      [{ id: 's2_0', key: 'reviewer' }],
    ],
    feedbacks: [{ id: 'fb_0', from: 's2_0', to: 's1_0' }],
    createdAt: 'x', updatedAt: 'x',
  };
  const deleted = [];
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', { get() { return window.document.body; }, configurable: true });
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  window.confirm = () => true;
  window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} addEventListener() {} };
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('/api/workflows/wf_default')) return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_WF });
    if (u.match(/\/api\/workflows\/wf_quickfix$/) && opts && opts.method === 'DELETE') { deleted.push('wf_quickfix'); return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) }); }
    if (u.endsWith('/api/workflows')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ workflows: [DEFAULT_WF, WF_QUICK] }) });
    if (u.includes('/api/agents')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ agents: [] }) });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [], config: { steps: {}, customModels: [] }, models: [], efforts: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator', 'requestAnimationFrame']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(appPath + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  window.location.hash = 'composer';
  window.dispatchEvent(new window.Event('hashchange'));
  await new Promise((r) => setTimeout(r, 30));

  const rows = window.document.querySelectorAll('#composer-saved-list .pl-item');
  assert.equal(rows.length, 2, 'Default + Quick Fix');
  const quick = [...rows].find((r) => r.querySelector('.pl-name').textContent === 'Quick Fix');
  assert.ok(quick, 'Quick Fix row present');
  assert.equal(quick.querySelector('.pl-meta').textContent.replace(/\s+/g, ' ').trim(), '3 steps · 3 agents · 1 feedback loop');
  assert.equal(quick.querySelectorAll('.pl-chip').length, 3, 'three distinct-agent chips');

  quick.querySelector('.pl-row').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(quick.classList.contains('open'), 'row expands');
  assert.ok(quick.querySelector('.pl-body .ro-flow'), 'read-only preview rendered');
  assert.equal(quick.querySelectorAll('.pl-body .ro-flow .node').length, 3, 'preview has 3 nodes');

  quick.querySelector('.pl-del').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(deleted, ['wf_quickfix'], 'DELETE called for the workflow id');
  assert.equal(window.document.querySelectorAll('#composer-saved-list .pl-item').length, 1, 'row removed after reload');
});
```

- [ ] **Step 2: Run — expect FAIL** (the stub sets the count but renders no rows / preview / delete).
  - Command: `node --test test/ui-composer.test.mjs`
  - Expected: the new test FAILs (`.pl-item` count is 0).

- [ ] **Step 3: Replace the `composerLoadSaved` stub with the full saved-list renderer.** Ported from the mockup's `renderList`/`renderRO`/`roNode`/`snapshot` (lines 1550–1629) but driven by the server `WorkflowTemplate[]`: meta line via `metaLine()`, chips via `distinctAgents()`, preview via `composerPaintWires`, delete via `deleteWorkflow(id)` → reload. Server templates already carry contract node ids, so the preview renders them directly (no re-snapshot). Replace the `composerLoadSaved` stub:

```js
async function composerLoadSaved() {
  composer.saved = await listWorkflows();
  composerRenderList();
}

function composerRoNode(a) {
  const ag = composerAgent(a.key);
  const d = document.createElement('div');
  d.className = 'node'; d.dataset.id = a.id; d.style.setProperty('--c', COMPOSER_COLORS[ag.color] || '#ccc');
  d.innerHTML =
    `<div class="nic" style="background:${COMPOSER_TINTS[ag.color] || '#eee'};color:${COMPOSER_COLORS[ag.color] || '#888'}">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">${ag.icon}</svg></div>` +
    `<div class="nmeta"><b>${ag.displayName}</b><small>${ag.description}</small></div>`;
  return d;
}

function composerRenderRO(host, item) {
  const tag = document.createElement('div'); tag.className = 'pl-readonly-tag';
  tag.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3" stroke-linecap="round"/></svg> Read-only preview';
  host.appendChild(tag);
  const scroll = document.createElement('div'); scroll.className = 'ro-scroll';
  const f = document.createElement('div'); f.className = 'flow ro-flow';
  const w = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); w.setAttribute('class', 'wires');
  f.appendChild(w);
  for (let i = 0; i < item.steps.length; i++) {
    f.appendChild(Object.assign(document.createElement('div'), { className: 'strip' }));
    const col = document.createElement('div'); col.className = 'col';
    const ct = document.createElement('div'); ct.className = 'col-tag';
    ct.innerHTML = `Step ${i + 1}` + (item.steps[i].length > 1 ? ' · <em>parallel</em>' : '');
    col.appendChild(ct);
    item.steps[i].forEach((a) => col.appendChild(composerRoNode(a)));
    f.appendChild(col);
  }
  f.appendChild(Object.assign(document.createElement('div'), { className: 'strip' }));
  scroll.appendChild(f); host.appendChild(scroll);
  const paint = () => composerPaintWires(f, w, item.steps, item.feedbacks, { ns: item.id });
  requestAnimationFrame(() => requestAnimationFrame(paint));
  setTimeout(paint, 60);
}

function composerRenderList() {
  const listEl = composer.els.list, cntEl = composer.els.count;
  listEl.innerHTML = '';
  cntEl.textContent = composer.saved.length + (composer.saved.length === 1 ? ' pipeline' : ' pipelines');
  if (!composer.saved.length) {
    listEl.innerHTML = '<div class="pl-empty">No saved pipelines yet — build one above and hit "Save pipeline".</div>';
    return;
  }
  composer.saved.forEach((item) => {
    const used = distinctAgents(item.steps);
    const chips = used.map((k) => {
      const ag = composerAgent(k);
      return `<span class="pl-chip"><span class="d" style="background:${COMPOSER_COLORS[ag.color] || '#ccc'}"></span>${ag.displayName}</span>`;
    }).join('');
    const nLoop = (item.feedbacks || []).length;
    const meta = metaLine(item.steps, item.feedbacks).replace(
      / · (\d+ feedback loops?)$/, ' · <em>$1</em>',
    );
    const wrap = document.createElement('div'); wrap.className = 'pl-item'; wrap.dataset.id = item.id;
    const isDefault = item.id === 'wf_default';
    wrap.innerHTML =
      `<div class="pl-row">` +
        `<svg class="pl-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
        `<div class="pl-main">` +
          `<div class="pl-name">${item.name}</div>` +
          `<div class="pl-meta">${meta}</div>` +
          `<div class="pl-chips">${chips}</div>` +
        `</div>` +
        (isDefault ? '' : `<button type="button" class="pl-del" title="Delete pipeline"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`) +
      `</div>` +
      `<div class="pl-body"></div>`;
    listEl.appendChild(wrap);
    const row = wrap.querySelector('.pl-row');
    const del = wrap.querySelector('.pl-del');
    const body = wrap.querySelector('.pl-body');
    if (del) del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!window.confirm(`Delete "${item.name}"? This cannot be undone.`)) return;
      try { await deleteWorkflow(item.id); } catch (err) {
        appendLog({ source: 'ui', level: 'error', text: `delete pipeline: ${err.message}`, ts: Date.now() }); return;
      }
      await composerLoadSaved();
    });
    row.addEventListener('click', () => {
      const open = wrap.classList.toggle('open');
      if (open) {
        if (!body.dataset.rendered) { composerRenderRO(body, item); body.dataset.rendered = '1'; }
        else {
          const f = body.querySelector('.ro-flow'), w = body.querySelector('.wires');
          if (f && w) requestAnimationFrame(() => composerPaintWires(f, w, item.steps, item.feedbacks, { ns: item.id }));
        }
      }
    });
  });
}
```

- [ ] **Step 4: Run — expect PASS** (rows, meta line, chips, preview, delete all assert green).
  - Command: `node --test test/ui-composer.test.mjs`

- [ ] **Step 5: Full regression — pure helpers + UI + the rest of the suite.**
  - Command: `node --test test/*.mjs`
  - Expected: all PASS (this phase adds `test/composer-ui.test.mjs` + `test/ui-composer.test.mjs`; touches only composer code + the additive `VIEW_NAMES`/import in `app.js`).

- [ ] **Step 6: Manual + smoke verification of the DnD/SVG behaviors that jsdom cannot cover.** Document the manual pass in the commit body.
  - Command: `MAESTRO_MOCK=1 npm run smoke` (must stay green — confirms the workflow plumbing the composer feeds).
  - Command: `npm start`, open `http://localhost:<port>/#composer`, and confirm against `docs/pipeline-composer/mockups/01-composer-overview.png` + `02-saved-and-readonly-preview.png`: (a) drag a palette pill onto a gap strip → new sequential step; (b) drag onto a column → parallel member, column tagged "Step N · parallel"; (c) grey dashed sequential wires + amber feedback arcs render and the circle-X deletes a loop; (d) hover a node → loop button → amber banner → click target creates a feedback; (e) Reset to default redraws the 4-step Plan→Refine→Implement→Review; (f) Save prompts for a name, the row appears with the right meta line + chips, expands to a locked read-only preview, and trash deletes it.

- [ ] **Step 7: Commit.**
  - `git add ui/public/app.js test/ui-composer.test.mjs`
  - `git commit -m "feat(composer): saved-pipelines list with meta line, chips, read-only preview, delete"`

## Phase 6: New Pipeline integration: workflow dropdown, per-agent model/effort, per-loop cycles

This phase wires saved workflows into the **New Pipeline** screen. The user picks a workflow from a `<select>` (Default + each saved name); the screen then renders one model+effort picker per workflow **node** (keyed by `nodeId`, not the fixed `STEP_ROLES`) and one cycle-count input per **feedback** loop, persists every change to per-project run-config via `POST /api/config`, and submits `{ projectDir, prompt, workflowId }` to `/api/run`.

**Depends on** (all delivered by earlier phases of this plan, per the CONTRACT — do not re-implement here):
- `src/core/config.mjs`: `readRunConfig`, `resolveRunConfig`, `setNodeModel`, `setFeedbackCycles`, `setActiveWorkflow` (Phase 5 run-config).
- `src/core/workflows.mjs`: `DEFAULT_WORKFLOW`, `listWorkflows`, `readWorkflow`, `resolveWorkflow` (Phases 2).
- `src/core/agent-registry.mjs`: `loadAgentRegistry(agentsDir) -> { [key]: AgentMeta }` (Phase 1).
- `ui/server.mjs` API (Phase 5): `GET /api/workflows -> { workflows:[DEFAULT_WORKFLOW, ...listWorkflows()] }`; `GET /api/workflows/:id -> WorkflowTemplate`; `GET /api/config?projectDir=… -> { config, models, steps, efforts }` **extended** so `config` carries `workflows:{[wfId]:{nodes,feedbacks}}` + `activeWorkflowId`; `POST /api/config` accepts the run-config write bodies added below; `GET /api/agents -> { agents:[AgentMeta…] }` (registry, Phase 1/5).
- `POST /api/run` accepts optional `{ workflowId }` (Phase 5; default `"wf_default"`).

**Anchors in current code (read before editing):**
- `ui/public/index.html` New-Pipeline view — run form L72-212; the four hardcoded `.stage-cfg` blocks **L156-194** (the DRY source for node rows); `#pipeline-config` container starts **L152**.
- `ui/public/app.js` — `state` **L9-18** (`state.config = { steps, customModels }` L15, `state.models` L16, `state.efforts` L17); `STEP_ROLES` **L22**; `el` cache **L27-68** (`el.pipelineConfig` L58); `loadConfig` **L452-467**; `option(value,text)` helper **L473-478**; `modelById` **L469-471**; `renderStepConfigs` **L480-516**; `saveStep` **L518-538**; the delegated change handler on `el.pipelineConfig` **L568-582**; the form submit handler **L1318-1388** (body built L1330-1336, `beginRun` L1372); `beginRun` **L1394-1401** (snapshots `state.config.steps` + `state.models`); `safeJson` **L1793-1799**; `appendLog` **L642-647**; `onProjectChanged` **L1217-1230** (calls `loadConfig`).

**Design principles for this phase:**
- **DRY:** refactor `renderStepConfigs` to iterate an explicit *node list* `[{nodeId, key, label, color, model, effort}]` instead of the fixed `STEP_ROLES`. The existing 4 stages become "the Default workflow's node list", so the legacy markup keeps working unchanged.
- **Pure core helpers** (no DOM, no fetch) are extracted so they unit-test under jsdom: `buildNodeConfigRows(workflow, registry, runConfig)`, `buildFeedbackRows(workflow, runConfig)`, and `defaultEffortFor`. Tests assert on the data they return; the renderers are thin and merely paint that data.
- **Backward-compat (load-bearing):** when the selected workflow is `wf_default`, `buildNodeConfigRows` must yield exactly the original 4 rows (planner/refiner/implementer/reviewer, in order, with the same labels/colors), and the submit payload with `workflowId:"wf_default"` must run identically to today.

---

### Task 1: Pure helper `buildNodeConfigRows` (workflow + registry + run-config -> per-node row data)

**Files:**
- modify: `ui/public/app.js` (add exported-via-window pure helpers near `renderStepConfigs`, ~L480)
- test: `test/newpipeline-config.test.mjs` (new)

This helper is the heart of the refactor: it flattens a workflow's `steps[][]` into an ordered list of node rows, joins each node's `key` to its registry metadata (label/color), and overlays the per-project run-config's saved `{model,effort}` for that `nodeId`. It is pure (no DOM), so it's unit-tested directly.

- [ ] **Step 1: Write the failing test.** Create `test/newpipeline-config.test.mjs`. It boots `app.js` under jsdom (mirroring `test/ui-cost.test.mjs`'s harness exactly), then reaches the helpers via `window.__np` (a debug namespace Step 3 attaches). Full file:

```js
// test/newpipeline-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));
const PROJECT = '/tmp/proj';

// Boot app.js in jsdom with a controllable fetch. Mirrors test/ui-cost.test.mjs.
async function boot({ fetchHandler } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4319/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.WebSocket = class {
    constructor() { this.readyState = 1; this._listeners = {}; }
    send() {} close() {}
    addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  };
  window.fetch = (url, opts) => {
    if (fetchHandler) { const r = fetchHandler(String(url), opts || {}); if (r) return r; }
    if (String(url).includes('/api/projects')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [{ name: 'proj', path: PROJECT, exists: true }] }) });
    }
    if (String(url).includes('/api/workflows')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ workflows: [] }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(appPath + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  return { window };
}

// A two-step workflow with one parallel member and one feedback loop.
const WF = {
  id: 'wf_x', name: 'Demo',
  steps: [
    [{ id: 's0_0', key: 'planner' }],
    [{ id: 's1_0', key: 'implementer' }, { id: 's1_1', key: 'manualTestsChecklist' }],
    [{ id: 's2_0', key: 'reviewer' }],
  ],
  feedbacks: [{ id: 'fb_0', from: 's2_0', to: 's1_0' }],
};
const REGISTRY = {
  planner: { key: 'planner', displayName: 'Plan', color: 'violet', order: 1 },
  implementer: { key: 'implementer', displayName: 'Implement', color: 'peach', order: 3 },
  manualTestsChecklist: { key: 'manualTestsChecklist', displayName: 'Manual Tests Checklist', color: 'blue', order: 5 },
  reviewer: { key: 'reviewer', displayName: 'Review', color: 'blue', order: 4 },
};

test('buildNodeConfigRows flattens steps in order, keyed by nodeId, with registry label+color', async () => {
  const { window } = await boot();
  const rows = window.__np.buildNodeConfigRows(WF, REGISTRY, { nodes: {}, feedbacks: {} });
  assert.deepEqual(rows.map((r) => r.nodeId), ['s0_0', 's1_0', 's1_1', 's2_0']);
  assert.deepEqual(rows.map((r) => r.key), ['planner', 'implementer', 'manualTestsChecklist', 'reviewer']);
  assert.deepEqual(rows.map((r) => r.label), ['Plan', 'Implement', 'Manual Tests Checklist', 'Review']);
  assert.deepEqual(rows.map((r) => r.color), ['violet', 'peach', 'amber', 'blue']);
  // step indices preserved (used for the "Step N · parallel" hint)
  assert.deepEqual(rows.map((r) => r.stepIndex), [0, 1, 1, 2]);
  // no run-config => empty model/effort
  assert.deepEqual(rows.map((r) => r.model), ['', '', '', '']);
  assert.deepEqual(rows.map((r) => r.effort), ['', '', '', '']);
});

test('buildNodeConfigRows overlays saved run-config model/effort per nodeId', async () => {
  const { window } = await boot();
  const rc = { nodes: { s1_0: { model: 'claude-opus-4-8', effort: 'high' }, s2_0: { model: 'claude-sonnet-4-6' } }, feedbacks: {} };
  const rows = window.__np.buildNodeConfigRows(WF, REGISTRY, rc);
  const byId = Object.fromEntries(rows.map((r) => [r.nodeId, r]));
  assert.equal(byId.s1_0.model, 'claude-opus-4-8');
  assert.equal(byId.s1_0.effort, 'high');
  assert.equal(byId.s2_0.model, 'claude-sonnet-4-6');
  assert.equal(byId.s2_0.effort, '');      // absent in run-config -> ''
  assert.equal(byId.s0_0.model, '');        // untouched node
});

test('buildNodeConfigRows tolerates a key missing from the registry (falls back to the key as label, no color)', async () => {
  const { window } = await boot();
  const wf = { id: 'w', steps: [[{ id: 'n0', key: 'ghost' }]], feedbacks: [] };
  const rows = window.__np.buildNodeConfigRows(wf, REGISTRY, { nodes: {}, feedbacks: {} });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'ghost');
  assert.equal(rows[0].color, '');
});

test('buildNodeConfigRows on the Default 4-step topology yields the original four rows in order', async () => {
  const { window } = await boot();
  const def = {
    id: 'wf_default', name: 'Default',
    steps: [
      [{ id: 's0_0', key: 'planner' }],
      [{ id: 's1_0', key: 'refiner' }],
      [{ id: 's2_0', key: 'implementer' }],
      [{ id: 's3_0', key: 'reviewer' }],
    ],
    feedbacks: [],
  };
  const reg = { ...REGISTRY, refiner: { key: 'refiner', displayName: 'Refine', color: 'green', order: 2 } };
  const rows = window.__np.buildNodeConfigRows(def, reg, { nodes: {}, feedbacks: {} });
  assert.deepEqual(rows.map((r) => r.key), ['planner', 'refiner', 'implementer', 'reviewer']);
  assert.deepEqual(rows.map((r) => r.label), ['Plan', 'Refine', 'Implement', 'Review']);
});
```

- [ ] **Step 2: Run the test — expect FAIL.** Run:

```
node --test test/newpipeline-config.test.mjs
```

Expected: fails with `TypeError: Cannot read properties of undefined (reading 'buildNodeConfigRows')` (because `window.__np` does not exist yet).

- [ ] **Step 3: Implement the pure helpers.** In `ui/public/app.js`, immediately **above** `function renderStepConfigs()` (currently L480), insert the helpers below. They are pure (no DOM/fetch) and get exposed on `window.__np` for tests:

```js
// ---------------------------------------------------------------------------
// New-Pipeline workflow config: PURE helpers (no DOM, no fetch). These flatten a
// workflow's topology + the per-project run-config into row data the renderers
// paint. Exposed on window.__np so jsdom unit tests can exercise them directly.
// ---------------------------------------------------------------------------

// Flatten workflow.steps[][] into an ordered list of node rows, joining each
// node's role `key` to its registry metadata (label/color) and overlaying the
// run-config's saved {model,effort} for that node-instance id. Order = outer
// (sequential) then inner (parallel) — exactly the dispatch order.
function buildNodeConfigRows(workflow, registry, runConfig) {
  const steps = Array.isArray(workflow && workflow.steps) ? workflow.steps : [];
  const reg = registry || {};
  const nodes = (runConfig && runConfig.nodes) || {};
  const rows = [];
  steps.forEach((group, stepIndex) => {
    const members = Array.isArray(group) ? group : [];
    members.forEach((node) => {
      if (!node || !node.id) return;
      const meta = reg[node.key] || null;
      const saved = nodes[node.id] || {};
      rows.push({
        nodeId: node.id,
        key: node.key,
        label: (meta && meta.displayName) || node.key || node.id,
        color: (meta && meta.color) || '',
        stepIndex,
        parallel: members.length > 1,
        model: typeof saved.model === 'string' ? saved.model : '',
        effort: typeof saved.effort === 'string' ? saved.effort : '',
      });
    });
  });
  return rows;
}

// Flatten workflow.feedbacks into row data for the per-loop cycle-count inputs,
// overlaying the run-config's saved maxCycles (default 3 when unset).
function buildFeedbackRows(workflow, runConfig) {
  const fbs = Array.isArray(workflow && workflow.feedbacks) ? workflow.feedbacks : [];
  const saved = (runConfig && runConfig.feedbacks) || {};
  return fbs.map((fb) => {
    const rc = saved[fb.id] || {};
    const n = Number(rc.maxCycles);
    return {
      fbId: fb.id,
      from: fb.from,
      to: fb.to,
      maxCycles: Number.isFinite(n) && n >= 1 ? n : 3,
    };
  });
}

// First effort a model supports (used to seed a node's effort caption when none
// is saved). '' when the model is unknown or advertises no efforts.
function defaultEffortFor(modelId) {
  const m = modelById(modelId);
  return m && Array.isArray(m.efforts) && m.efforts.length ? m.efforts[0] : '';
}

// Test hook: expose the pure helpers (and a couple of collaborators the tests
// reuse) without leaking them into the app's runtime contract.
if (typeof window !== 'undefined') {
  window.__np = Object.assign(window.__np || {}, {
    buildNodeConfigRows,
    buildFeedbackRows,
    defaultEffortFor,
  });
}
```

- [ ] **Step 4: Run the test — expect PASS.** Run:

```
node --test test/newpipeline-config.test.mjs
```

Expected: all four tests pass.

- [ ] **Step 5: Commit.** Run:

```
git add ui/public/app.js test/newpipeline-config.test.mjs
git commit -m "feat(newpipeline): pure helpers to flatten a workflow + run-config into node/feedback rows"
```

---

### Task 2: `index.html` — workflow `<select>` + dynamic node/feedback containers

**Files:**
- modify: `ui/public/index.html` New-Pipeline view (`#pipeline-config`, L152-195)
- test: `test/newpipeline-config.test.mjs` (append a markup assertion)

Add the workflow dropdown above the per-stage config, wrap the four hardcoded `.stage-cfg` blocks in a `#wf-default-stages` container (so they can be hidden when a non-default workflow is chosen), and add two empty containers the renderers fill: `#wf-node-config` (per-node pickers for non-default workflows) and `#wf-feedback-config` (per-loop cycle inputs). The four legacy blocks stay verbatim — they are the Default workflow's rows and keep backward-compat for the markup-shape tests in `config-ui.test.mjs`.

- [ ] **Step 1: Write the failing markup test.** Append to `test/newpipeline-config.test.mjs`:

```js
import { readFileSync as _rf } from 'node:fs';
const indexHtml = _rf(fileURLToPath(new URL('../ui/public/index.html', import.meta.url)), 'utf8');

test('index.html exposes the workflow select + dynamic node/feedback containers', () => {
  assert.ok(indexHtml.includes('id="workflowSelect"'), 'missing #workflowSelect');
  assert.ok(indexHtml.includes('id="wf-default-stages"'), 'missing #wf-default-stages wrapper');
  assert.ok(indexHtml.includes('id="wf-node-config"'), 'missing #wf-node-config container');
  assert.ok(indexHtml.includes('id="wf-feedback-config"'), 'missing #wf-feedback-config container');
  // the original four hardcoded stage rows must remain (Default backward-compat)
  for (const role of ['planner', 'refiner', 'implementer', 'reviewer']) {
    assert.ok(indexHtml.includes(`data-role="${role}"`), `lost default stage row for ${role}`);
  }
});
```

- [ ] **Step 2: Run — expect FAIL.** Run:

```
node --test test/newpipeline-config.test.mjs
```

Expected: the new test fails (`missing #workflowSelect`).

- [ ] **Step 3: Edit the markup.** In `ui/public/index.html`, replace the `#pipeline-config` block (the `<div id="pipeline-config" …>` opening through its closing `</div>` at L152-195) with the version below. It (a) adds the workflow `<select>`, (b) wraps the four existing `.stage-cfg` blocks **unchanged** inside `#wf-default-stages`, and (c) adds the two dynamic containers:

```html
                <!-- Pipeline configuration -->
                <div id="pipeline-config" style="margin-top:24px;padding-top:20px;border-top:1px solid var(--line)">
                  <h2 style="font-size:14.5px;font-weight:700;margin:0 0 6px">Pipeline configuration</h2>
                  <div class="hint" style="margin:0 0 6px">Choose a workflow, then set model and reasoning effort per agent.</div>

                  <!-- Workflow picker (Default + saved). app.js populates from GET /api/workflows. -->
                  <div class="field" style="margin-bottom:14px">
                    <label for="workflowSelect">Workflow</label>
                    <div class="select-wrap">
                      <select id="workflowSelect" class="select" aria-label="Workflow">
                        <option value="wf_default">Default</option>
                      </select>
                    </div>
                  </div>

                  <!-- Default-workflow stages: the original four rows, shown when the
                       Default workflow is selected (backward-compat). -->
                  <div id="wf-default-stages">
                    <div class="stage-cfg">
                      <div class="acc violet"></div>
                      <div class="meta"><b>Plan</b><small>architecture & task breakdown</small></div>
                      <div class="picks">
                        <div class="select-wrap"><select class="step-model select" data-role="planner" aria-label="Plan model"></select></div>
                        <div class="select-wrap"><select class="step-effort select" data-role="planner" aria-label="Plan effort"></select></div>
                      </div>
                      <small class="step-current" data-role="planner"></small>
                    </div>

                    <div class="stage-cfg">
                      <div class="acc green"></div>
                      <div class="meta"><b>Refine</b><small>tighten the plan</small></div>
                      <div class="picks">
                        <div class="select-wrap"><select class="step-model select" data-role="refiner" aria-label="Refine model"></select></div>
                        <div class="select-wrap"><select class="step-effort select" data-role="refiner" aria-label="Refine effort"></select></div>
                      </div>
                      <small class="step-current" data-role="refiner"></small>
                    </div>

                    <div class="stage-cfg">
                      <div class="acc peach"></div>
                      <div class="meta"><b>Implement</b><small>write the code</small></div>
                      <div class="picks">
                        <div class="select-wrap"><select class="step-model select" data-role="implementer" aria-label="Implement model"></select></div>
                        <div class="select-wrap"><select class="step-effort select" data-role="implementer" aria-label="Implement effort"></select></div>
                      </div>
                      <small class="step-current" data-role="implementer"></small>
                    </div>

                    <div class="stage-cfg">
                      <div class="acc blue"></div>
                      <div class="meta"><b>Review</b><small>verify & report</small></div>
                      <div class="picks">
                        <div class="select-wrap"><select class="step-model select" data-role="reviewer" aria-label="Review model"></select></div>
                        <div class="select-wrap"><select class="step-effort select" data-role="reviewer" aria-label="Review effort"></select></div>
                      </div>
                      <small class="step-current" data-role="reviewer"></small>
                    </div>
                  </div>

                  <!-- Per-node pickers for a non-default (saved) workflow. app.js fills this. -->
                  <div id="wf-node-config" class="hidden"></div>

                  <!-- Per-feedback cycle-count inputs. app.js fills this. -->
                  <div id="wf-feedback-config" class="hidden"></div>
                </div>
```

- [ ] **Step 4: Run — expect PASS.** Run:

```
node --test test/newpipeline-config.test.mjs
```

Expected: the markup test passes and the Task 1 tests still pass.

- [ ] **Step 5: Guard the legacy markup test still passes.** Run:

```
node --test test/config-ui.test.mjs
```

Expected: PASS (the four `data-role` rows and the `step-model`/`step-effort` classes are intact).

- [ ] **Step 6: Commit.** Run:

```
git add ui/public/index.html test/newpipeline-config.test.mjs
git commit -m "feat(newpipeline): add workflow select + dynamic node/feedback containers to the run form"
```

---

### Task 3: Refactor `renderStepConfigs` to render an arbitrary node list (DRY)

**Files:**
- modify: `ui/public/app.js` (`renderStepConfigs` L480-516; add `el` refs L58; add `renderModelEffortPair`)
- test: `test/newpipeline-config.test.mjs` (append a render test)

Extract the per-row model/effort painting from `renderStepConfigs` into `renderModelEffortPair(modelSel, effortSel, caption, sel)` so the **same** code paints both the legacy default-stage selects (keyed by `data-role`) and the dynamically-built node selects (keyed by `data-node-id`, Task 4). `renderStepConfigs` keeps painting the four default rows by calling the shared painter. No behavior change for Default.

- [ ] **Step 1: Write the failing render test.** Append to `test/newpipeline-config.test.mjs`:

```js
test('renderModelEffortPair fills a model dropdown (default + models + add) and filters efforts by model', async () => {
  const { window } = await boot();
  const doc = window.document;
  // build a bare pair of selects + caption
  const modelSel = doc.createElement('select');
  const effortSel = doc.createElement('select');
  const caption = doc.createElement('small');
  // seed app state with two models
  window.__np._setModels([
    { id: 'claude-opus-4-8', label: 'Opus 4.8', efforts: ['medium', 'high', 'max'] },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: ['medium', 'high'] },
  ]);
  window.__np.renderModelEffortPair(modelSel, effortSel, caption, { model: 'claude-haiku-4-5', effort: 'high' });
  // model dropdown: '(default model)' + 2 models + '+ Add model…' = 4 options
  assert.equal(modelSel.options.length, 4);
  assert.equal(modelSel.value, 'claude-haiku-4-5');
  // effort dropdown filtered to Haiku's two efforts + the '(default effort)' row
  assert.deepEqual([...effortSel.options].map((o) => o.value), ['', 'medium', 'high']);
  assert.equal(effortSel.value, 'high');
  assert.match(caption.textContent, /Haiku 4\.5 · high/);
});
```

- [ ] **Step 2: Run — expect FAIL.** Run:

```
node --test test/newpipeline-config.test.mjs
```

Expected: fails (`window.__np.renderModelEffortPair is not a function`).

- [ ] **Step 3: Refactor.** First add two element refs to the `el` cache in `ui/public/app.js` (inside the `el = { … }` object, after the `pipelineConfig: $('#pipeline-config'),` line at L58):

```js
  pipelineConfig: $('#pipeline-config'),
  workflowSelect: $('#workflowSelect'),
  wfDefaultStages: $('#wf-default-stages'),
  wfNodeConfig: $('#wf-node-config'),
  wfFeedbackConfig: $('#wf-feedback-config'),
```

Then replace `renderStepConfigs` (L480-516) with the refactored version plus the shared painter:

```js
// Paint one model+effort select pair (and its caption) from a saved selection
// {model,effort}. Shared by the legacy default-stage rows and the dynamic
// per-node rows so the dropdown contents + effort filtering live in one place.
function renderModelEffortPair(modelSel, effortSel, caption, sel = {}) {
  // Model dropdown: "(default model)" + every model + "+ Add model…".
  modelSel.innerHTML = '';
  modelSel.appendChild(option('', '(default model)'));
  state.models.forEach((m) => modelSel.appendChild(option(m.id, m.label + (m.custom ? ' ·custom' : ''))));
  modelSel.appendChild(option('__add__', '+ Add model…'));
  modelSel.value = sel.model || '';

  // Effort dropdown: filtered to the selected model's supported efforts.
  const model = modelById(modelSel.value);
  effortSel.innerHTML = '';
  effortSel.appendChild(option('', '(default effort)'));
  (model ? model.efforts : []).forEach((e) => effortSel.appendChild(option(e, e)));
  effortSel.value = sel.effort && model && model.efforts.includes(sel.effort) ? sel.effort : '';

  modelSel.disabled = false;
  effortSel.disabled = !model; // no model picked => effort is meaningless

  if (caption) {
    const mLabel = model ? model.label : 'default model';
    caption.textContent = `${mLabel} · ${effortSel.value || 'default effort'}`;
  }
}

function renderStepConfigs() {
  // The Default workflow's four rows are keyed by data-role; paint each from the
  // legacy per-role config (state.config.steps). Config always edits the NEXT
  // run, so selectors are never locked.
  for (const role of STEP_ROLES) {
    const modelSel = document.querySelector(`.step-model[data-role="${role}"]`);
    const effortSel = document.querySelector(`.step-effort[data-role="${role}"]`);
    const caption = document.querySelector(`.step-current[data-role="${role}"]`);
    if (!modelSel || !effortSel) continue;
    renderModelEffortPair(modelSel, effortSel, caption, state.config.steps[role] || {});
  }
}
```

Finally, extend the test hook block (added in Task 1) to expose the painter and a tiny model-seeding helper. Replace the `window.__np = Object.assign(...)` block from Task 1 with:

```js
if (typeof window !== 'undefined') {
  window.__np = Object.assign(window.__np || {}, {
    buildNodeConfigRows,
    buildFeedbackRows,
    defaultEffortFor,
    renderModelEffortPair,
    _setModels: (m) => { state.models = Array.isArray(m) ? m : []; },
  });
}
```

- [ ] **Step 4: Run — expect PASS.** Run:

```
node --test test/newpipeline-config.test.mjs
```

Expected: the render test passes; earlier tests still green.

- [ ] **Step 5: Guard no regression in the existing UI suite.** Run:

```
node --test test/config-ui.test.mjs test/ui-boot.test.mjs
```

Expected: PASS (Default-stage rendering unchanged).

- [ ] **Step 6: Commit.** Run:

```
git add ui/public/app.js test/newpipeline-config.test.mjs
git commit -m "refactor(newpipeline): extract renderModelEffortPair; render arbitrary node lists DRY"
```

---

### Task 4: Workflow selector — populate the dropdown, fetch the chosen workflow + registry, render per-node + per-feedback rows

**Files:**
- modify: `ui/public/app.js` (add `listWorkflows`/`getWorkflow`/`getAgents` wrappers; `loadWorkflowsInto`; `renderWorkflowConfig`; node/feedback renderers; wire `el.workflowSelect`; call from `loadConfig`)
- test: `test/newpipeline-config.test.mjs` (append an end-to-end selector test)

This is the integration: API wrappers (using the existing `fetch`/`safeJson` style), a `loadWorkflowsInto` that fills the `<select>` from `GET /api/workflows`, and `renderWorkflowConfig(workflowId)` that — for the **Default** workflow — shows `#wf-default-stages` and hides the dynamic containers (current behavior), and for a **saved** workflow — `GET /api/workflows/:id` + `GET /api/agents`, then renders one `.stage-cfg` row per node (keyed by `data-node-id`) via `buildNodeConfigRows` + `renderModelEffortPair`, and one cycle input per feedback via `buildFeedbackRows`. The chosen `workflowId` is held in `state.workflowId`.

- [ ] **Step 1: Write the failing selector test.** Append to `test/newpipeline-config.test.mjs`:

```js
// A saved workflow served by the mocked API for the selector tests below.
const SAVED_WF = {
  id: 'wf_x', name: 'Demo',
  steps: [
    [{ id: 's0_0', key: 'planner' }],
    [{ id: 's1_0', key: 'implementer' }],
    [{ id: 's2_0', key: 'reviewer' }],
  ],
  feedbacks: [{ id: 'fb_0', from: 's2_0', to: 's1_0' }],
};
const AGENTS = [
  { key: 'planner', displayName: 'Plan', color: 'violet', order: 1 },
  { key: 'implementer', displayName: 'Implement', color: 'peach', order: 3 },
  { key: 'reviewer', displayName: 'Review', color: 'blue', order: 4 },
];
const MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', efforts: ['medium', 'high', 'max'] },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', efforts: ['medium', 'high', 'max'] },
];

function workflowFetch(extraConfig = {}) {
  return (url) => {
    if (url.includes('/api/projects')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [{ name: 'proj', path: PROJECT, exists: true }] }) });
    }
    if (url.includes('/api/workflows/wf_x')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => SAVED_WF });
    }
    if (url.includes('/api/workflows')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ workflows: [{ id: 'wf_default', name: 'Default' }, SAVED_WF] }) });
    }
    if (url.includes('/api/agents')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ agents: AGENTS }) });
    }
    if (url.includes('/api/config')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [], ...extraConfig }, models: MODELS, efforts: ['medium', 'high', 'max'] }) });
    }
    return null;
  };
}

const selectProjectAnd = (window) => {
  const s = window.document.querySelector('#projectSelect');
  s.value = PROJECT; s.dispatchEvent(new window.Event('change', { bubbles: true }));
};
const pickWorkflow = (window, id) => {
  const s = window.document.querySelector('#workflowSelect');
  s.value = id; s.dispatchEvent(new window.Event('change', { bubbles: true }));
};

test('the workflow select is populated with Default + saved names from GET /api/workflows', async () => {
  const { window } = await boot({ fetchHandler: workflowFetch() });
  selectProjectAnd(window);
  await new Promise((r) => setTimeout(r, 0));
  const opts = [...window.document.querySelectorAll('#workflowSelect option')].map((o) => o.textContent);
  assert.deepEqual(opts, ['Default', 'Demo']);
});

test('selecting a saved workflow renders one node row per node (keyed by node id) + one cycle input per feedback', async () => {
  const { window } = await boot({ fetchHandler: workflowFetch() });
  selectProjectAnd(window);
  await new Promise((r) => setTimeout(r, 0));
  pickWorkflow(window, 'wf_x');
  await new Promise((r) => setTimeout(r, 0));
  const doc = window.document;
  // default stages hidden, dynamic containers shown
  assert.ok(doc.querySelector('#wf-default-stages').classList.contains('hidden'));
  assert.ok(!doc.querySelector('#wf-node-config').classList.contains('hidden'));
  // one model select per node, keyed by data-node-id
  const ids = [...doc.querySelectorAll('#wf-node-config .step-model')].map((s) => s.dataset.nodeId);
  assert.deepEqual(ids, ['s0_0', 's1_0', 's2_0']);
  // model dropdown is populated (default + 2 models + add)
  assert.equal(doc.querySelector('#wf-node-config .step-model[data-node-id="s1_0"]').options.length, 4);
  // one cycle input per feedback, keyed by data-fb-id, default 3
  const cyc = doc.querySelector('#wf-feedback-config input[data-fb-id="fb_0"]');
  assert.ok(cyc, 'missing cycle input for fb_0');
  assert.equal(cyc.value, '3');
});

test('selecting Default again restores the original four stage rows and hides the dynamic containers', async () => {
  const { window } = await boot({ fetchHandler: workflowFetch() });
  selectProjectAnd(window);
  await new Promise((r) => setTimeout(r, 0));
  pickWorkflow(window, 'wf_x');
  await new Promise((r) => setTimeout(r, 0));
  pickWorkflow(window, 'wf_default');
  await new Promise((r) => setTimeout(r, 0));
  const doc = window.document;
  assert.ok(!doc.querySelector('#wf-default-stages').classList.contains('hidden'), 'default stages shown');
  assert.ok(doc.querySelector('#wf-node-config').classList.contains('hidden'), 'node config hidden');
  assert.ok(doc.querySelector('#wf-feedback-config').classList.contains('hidden'), 'feedback config hidden');
  // the original four role rows still render their model dropdowns
  assert.equal(doc.querySelector('.step-model[data-role="planner"]').options.length, 4);
});

test('saved run-config preselects a node\\'s model+effort when the workflow is opened', async () => {
  const extra = { workflows: { wf_x: { nodes: { s1_0: { model: 'claude-opus-4-8', effort: 'high' } }, feedbacks: { fb_0: { maxCycles: 7 } } } } };
  const { window } = await boot({ fetchHandler: workflowFetch(extra) });
  selectProjectAnd(window);
  await new Promise((r) => setTimeout(r, 0));
  pickWorkflow(window, 'wf_x');
  await new Promise((r) => setTimeout(r, 0));
  const doc = window.document;
  assert.equal(doc.querySelector('#wf-node-config .step-model[data-node-id="s1_0"]').value, 'claude-opus-4-8');
  assert.equal(doc.querySelector('#wf-node-config .step-effort[data-node-id="s1_0"]').value, 'high');
  assert.equal(doc.querySelector('#wf-feedback-config input[data-fb-id="fb_0"]').value, '7');
});
```

- [ ] **Step 2: Run — expect FAIL.** Run:

```
node --test test/newpipeline-config.test.mjs
```

Expected: the new selector tests fail (the dropdown stays at the single hardcoded `Default` option; no node rows render).

- [ ] **Step 3: Implement the wrappers, loader, and renderers.** In `ui/public/app.js`:

(3a) Add `workflowId` + a registry cache to `state` (L9-18 object), after `efforts: []`:

```js
  efforts: [], // effort levels, from /api/config
  workflowId: 'wf_default', // currently selected workflow in New Pipeline
  agents: {}, // registry { [key]: AgentMeta }, lazily loaded from /api/agents
  workflowCache: {}, // { [id]: WorkflowTemplate } from GET /api/workflows/:id
```

(3b) Add the API wrappers + the loader/renderers. Place them immediately **after** `renderStepConfigs` (right after its closing brace, ~L516 post-refactor):

```js
// ---------------------------------------------------------------------------
// New-Pipeline workflow selector. Populates #workflowSelect from
// GET /api/workflows; on change, renders per-node model/effort pickers + per-
// feedback cycle inputs for the chosen workflow (or the legacy default stages).
// ---------------------------------------------------------------------------

// --- API wrappers (existing fetch()/safeJson style) ---
async function listWorkflowsApi() {
  try {
    const res = await fetch('/api/workflows');
    const data = await safeJson(res);
    return res.ok && Array.isArray(data.workflows) ? data.workflows : [];
  } catch { return []; }
}

async function getWorkflowApi(id) {
  if (state.workflowCache[id]) return state.workflowCache[id];
  try {
    const res = await fetch(`/api/workflows/${encodeURIComponent(id)}`);
    const data = await safeJson(res);
    if (!res.ok || !data || !Array.isArray(data.steps)) return null;
    state.workflowCache[id] = data;
    return data;
  } catch { return null; }
}

async function getAgentsApi() {
  if (Object.keys(state.agents).length) return state.agents;
  try {
    const res = await fetch('/api/agents');
    const data = await safeJson(res);
    const list = res.ok && Array.isArray(data.agents) ? data.agents : [];
    state.agents = Object.fromEntries(list.map((a) => [a.key, a]));
    return state.agents;
  } catch { return state.agents; }
}

// Fill #workflowSelect with Default + saved names, preserving/falling back to
// the active selection (state.workflowId), then render that workflow's config.
async function loadWorkflowsInto(selectId) {
  const sel = el.workflowSelect;
  if (!sel) return;
  const workflows = await listWorkflowsApi();
  const list = workflows.length ? workflows : [{ id: 'wf_default', name: 'Default' }];
  const want = selectId || state.workflowId || 'wf_default';
  sel.innerHTML = '';
  list.forEach((wf) => sel.appendChild(option(wf.id, wf.name || wf.id)));
  // Fall back to default if the wanted id is gone (e.g. a deleted workflow).
  state.workflowId = list.some((wf) => wf.id === want) ? want : 'wf_default';
  sel.value = state.workflowId;
  await renderWorkflowConfig(state.workflowId);
}

// Render the config UI for one workflow. Default -> show the legacy 4 stage rows
// and hide the dynamic containers. Saved -> fetch topology + registry, render a
// node row per node and a cycle input per feedback.
async function renderWorkflowConfig(workflowId) {
  const isDefault = !workflowId || workflowId === 'wf_default';
  if (el.wfDefaultStages) el.wfDefaultStages.classList.toggle('hidden', !isDefault);
  if (el.wfNodeConfig) el.wfNodeConfig.classList.toggle('hidden', isDefault);
  if (el.wfFeedbackConfig) el.wfFeedbackConfig.classList.toggle('hidden', isDefault);

  if (isDefault) {
    if (el.wfNodeConfig) el.wfNodeConfig.innerHTML = '';
    if (el.wfFeedbackConfig) el.wfFeedbackConfig.innerHTML = '';
    renderStepConfigs(); // legacy per-role rows
    return;
  }

  const [wf, registry] = await Promise.all([getWorkflowApi(workflowId), getAgentsApi()]);
  if (!wf) {
    if (el.wfNodeConfig) el.wfNodeConfig.innerHTML = '<div class="hint">Could not load this workflow.</div>';
    if (el.wfFeedbackConfig) el.wfFeedbackConfig.innerHTML = '';
    return;
  }
  const runConfig = (state.config.workflows && state.config.workflows[workflowId]) || { nodes: {}, feedbacks: {} };
  renderNodeRows(buildNodeConfigRows(wf, registry, runConfig));
  renderFeedbackRows(buildFeedbackRows(wf, runConfig));
}

// Build one .stage-cfg row per node into #wf-node-config, keyed by data-node-id.
// Mirrors the legacy markup (acc bar + meta + picks + caption) so it reuses the
// existing .stage-cfg styles and renderModelEffortPair.
function renderNodeRows(rows) {
  const host = el.wfNodeConfig;
  if (!host) return;
  host.innerHTML = '';
  rows.forEach((row) => {
    const card = document.createElement('div');
    card.className = 'stage-cfg';

    const acc = document.createElement('div');
    acc.className = 'acc' + (row.color ? ' ' + row.color : '');
    card.appendChild(acc);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const b = document.createElement('b');
    b.textContent = row.label;
    const small = document.createElement('small');
    small.textContent = row.parallel ? `Step ${row.stepIndex + 1} · parallel` : `Step ${row.stepIndex + 1}`;
    meta.append(b, small);
    card.appendChild(meta);

    const picks = document.createElement('div');
    picks.className = 'picks';
    const mWrap = document.createElement('div');
    mWrap.className = 'select-wrap';
    const modelSel = document.createElement('select');
    modelSel.className = 'step-model select';
    modelSel.dataset.nodeId = row.nodeId;
    modelSel.setAttribute('aria-label', `${row.label} model`);
    mWrap.appendChild(modelSel);
    const eWrap = document.createElement('div');
    eWrap.className = 'select-wrap';
    const effortSel = document.createElement('select');
    effortSel.className = 'step-effort select';
    effortSel.dataset.nodeId = row.nodeId;
    effortSel.setAttribute('aria-label', `${row.label} effort`);
    eWrap.appendChild(effortSel);
    picks.append(mWrap, eWrap);
    card.appendChild(picks);

    const caption = document.createElement('small');
    caption.className = 'step-current';
    caption.dataset.nodeId = row.nodeId;
    card.appendChild(caption);

    renderModelEffortPair(modelSel, effortSel, caption, { model: row.model, effort: row.effort });
    host.appendChild(card);
  });
}

// Build one cycle-count input per feedback into #wf-feedback-config, keyed by
// data-fb-id. Shows the loop's direction (to <- from) as a label.
function renderFeedbackRows(rows) {
  const host = el.wfFeedbackConfig;
  if (!host) return;
  host.innerHTML = '';
  if (!rows.length) return;

  const h = document.createElement('div');
  h.className = 'hint';
  h.style.margin = '10px 0 6px';
  h.textContent = 'Feedback loops — max cycles before gating to you.';
  host.appendChild(h);

  rows.forEach((row) => {
    const field = document.createElement('div');
    field.className = 'field';
    field.style.marginBottom = '10px';

    const label = document.createElement('label');
    label.textContent = `Loop ${row.to} ← ${row.from} — max cycles`;
    label.setAttribute('for', `fb-${row.fbId}`);
    field.appendChild(label);

    const input = document.createElement('input');
    input.id = `fb-${row.fbId}`;
    input.className = 'input';
    input.type = 'number';
    input.min = '1';
    input.value = String(row.maxCycles);
    input.dataset.fbId = row.fbId;
    field.appendChild(input);

    host.appendChild(field);
  });
}
```

(3c) Wire the dropdown's change event. Add this right after the renderers block:

```js
// Workflow change: remember the selection and re-render its config.
if (el.workflowSelect) {
  el.workflowSelect.addEventListener('change', async () => {
    state.workflowId = el.workflowSelect.value || 'wf_default';
    await renderWorkflowConfig(state.workflowId);
  });
}
```

(3d) Populate the dropdown whenever config (re)loads. In `loadConfig` (L452-467), replace the trailing `renderStepConfigs();` call (last line of the function) with the workflow-aware loader, which also seeds the active selection from run-config:

```js
  // Seed the active workflow from per-project run-config (activeWorkflowId),
  // then populate the dropdown + render the chosen workflow's config. This
  // supersedes the bare renderStepConfigs() call: the default branch still calls
  // renderStepConfigs() internally for backward-compat.
  if (state.config.activeWorkflowId) state.workflowId = state.config.activeWorkflowId;
  await loadWorkflowsInto(state.workflowId);
```

(3e) Expose the new pieces the tests poke at. Extend the `window.__np` hook block (Task 3 version) by adding `renderWorkflowConfig`:

```js
if (typeof window !== 'undefined') {
  window.__np = Object.assign(window.__np || {}, {
    buildNodeConfigRows,
    buildFeedbackRows,
    defaultEffortFor,
    renderModelEffortPair,
    renderWorkflowConfig,
    _setModels: (m) => { state.models = Array.isArray(m) ? m : []; },
  });
}
```

- [ ] **Step 4: Run — expect PASS.** Run:

```
node --test test/newpipeline-config.test.mjs
```

Expected: all selector tests pass.

- [ ] **Step 5: Guard the existing UI suite.** Run:

```
node --test test/config-ui.test.mjs test/ui-boot.test.mjs test/ui-cost.test.mjs
```

Expected: PASS (Default path unchanged; `loadConfig` still renders the four stage rows on boot).

- [ ] **Step 6: Commit.** Run:

```
git add ui/public/app.js test/newpipeline-config.test.mjs
git commit -m "feat(newpipeline): workflow dropdown fetches topology+registry and renders per-node/per-loop config"
```

---

### Task 5: Persist per-node model/effort + per-feedback cycles + active workflow via POST /api/config

**Files:**
- modify: `ui/public/app.js` (per-node change handler; per-feedback change handler; persist active workflow; extend the `el.pipelineConfig` delegated handler)
- test: `test/newpipeline-config.test.mjs` (append persistence tests asserting on captured POST bodies)

Changes to a node's model/effort, a feedback's cycle count, and the workflow selection itself must persist to per-project run-config. The CONTRACT exposes the write paths through `POST /api/config` (Phase 5 extends the handler to accept these bodies, delegating to `setNodeModel`/`setFeedbackCycles`/`setActiveWorkflow`). The client posts:
- node model/effort: `{ projectDir, workflowId, nodeId, model, effort }`
- feedback cycles: `{ projectDir, workflowId, fbId, maxCycles }`
- active workflow: `{ projectDir, activeWorkflowId }`

The existing delegated handler on `el.pipelineConfig` (L568-582) already catches `data-role` selects; extend it to also catch `data-node-id` selects and the cycle inputs (they live inside `#pipeline-config`, hence under `el.pipelineConfig`).

- [ ] **Step 1: Write the failing persistence tests.** Append to `test/newpipeline-config.test.mjs`:

```js
// Capture POST /api/config bodies while still serving the workflow/agents/config
// GETs. Returns { window, posts }.
async function bootCapturing(extraConfig = {}) {
  const posts = [];
  const base = workflowFetch(extraConfig);
  const { window } = await boot({
    fetchHandler: (url, opts) => {
      if (url.includes('/api/config') && opts && opts.method === 'POST') {
        posts.push(JSON.parse(opts.body));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [], ...extraConfig } }) });
      }
      return base(url);
    },
  });
  return { window, posts };
}

test('changing a node model POSTs {projectDir, workflowId, nodeId, model, effort}', async () => {
  const { window, posts } = await bootCapturing();
  selectProjectAnd(window);
  await new Promise((r) => setTimeout(r, 0));
  pickWorkflow(window, 'wf_x');
  await new Promise((r) => setTimeout(r, 0));
  const modelSel = window.document.querySelector('#wf-node-config .step-model[data-node-id="s1_0"]');
  modelSel.value = 'claude-opus-4-8';
  modelSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  const body = posts.find((p) => p.nodeId === 's1_0');
  assert.ok(body, 'no POST captured for the node');
  assert.equal(body.projectDir, PROJECT);
  assert.equal(body.workflowId, 'wf_x');
  assert.equal(body.model, 'claude-opus-4-8');
  assert.equal(body.effort, ''); // new model resets effort
});

test('changing a feedback cycle count POSTs {projectDir, workflowId, fbId, maxCycles}', async () => {
  const { window, posts } = await bootCapturing();
  selectProjectAnd(window);
  await new Promise((r) => setTimeout(r, 0));
  pickWorkflow(window, 'wf_x');
  await new Promise((r) => setTimeout(r, 0));
  const cyc = window.document.querySelector('#wf-feedback-config input[data-fb-id="fb_0"]');
  cyc.value = '4';
  cyc.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  const body = posts.find((p) => p.fbId === 'fb_0');
  assert.ok(body, 'no POST captured for the feedback');
  assert.equal(body.workflowId, 'wf_x');
  assert.equal(body.maxCycles, 4);
});

test('selecting a workflow persists it as the active workflow', async () => {
  const { window, posts } = await bootCapturing();
  selectProjectAnd(window);
  await new Promise((r) => setTimeout(r, 0));
  pickWorkflow(window, 'wf_x');
  await new Promise((r) => setTimeout(r, 0));
  const body = posts.find((p) => p.activeWorkflowId === 'wf_x');
  assert.ok(body, 'active workflow not persisted');
  assert.equal(body.projectDir, PROJECT);
});
```

- [ ] **Step 2: Run — expect FAIL.** Run:

```
node --test test/newpipeline-config.test.mjs
```

Expected: the three persistence tests fail (no POST is captured — the handlers don't exist yet).

- [ ] **Step 3: Implement the persistence calls + handlers.** In `ui/public/app.js`:

(3a) Add the three save wrappers. Place them right after `saveStep` (which ends at L538):

```js
// Persist one node's model/effort to the per-project run-config for the active
// workflow: POST /api/config { projectDir, workflowId, nodeId, model, effort }.
async function saveNode(workflowId, nodeId, model, effort) {
  const projectDir = selectedProjectPath();
  if (!projectDir) return;
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, workflowId, nodeId, model, effort }),
    });
    const data = await safeJson(res);
    if (!res.ok) {
      appendLog({ source: 'ui', level: 'error', text: `config: ${data.error || res.status}`, ts: Date.now() });
      return;
    }
    if (data.config) state.config = data.config;
  } catch (e) {
    appendLog({ source: 'ui', level: 'error', text: `config error: ${e.message}`, ts: Date.now() });
  }
}

// Persist one feedback loop's cycle count: POST /api/config
// { projectDir, workflowId, fbId, maxCycles }.
async function saveFeedback(workflowId, fbId, maxCycles) {
  const projectDir = selectedProjectPath();
  if (!projectDir) return;
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, workflowId, fbId, maxCycles }),
    });
    const data = await safeJson(res);
    if (!res.ok) {
      appendLog({ source: 'ui', level: 'error', text: `config: ${data.error || res.status}`, ts: Date.now() });
      return;
    }
    if (data.config) state.config = data.config;
  } catch (e) {
    appendLog({ source: 'ui', level: 'error', text: `config error: ${e.message}`, ts: Date.now() });
  }
}

// Persist the active workflow selection: POST /api/config { projectDir, activeWorkflowId }.
async function saveActiveWorkflow(workflowId) {
  const projectDir = selectedProjectPath();
  if (!projectDir) return;
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, activeWorkflowId: workflowId }),
    });
    const data = await safeJson(res);
    if (res.ok && data.config) state.config = data.config;
  } catch {
    /* selection is best-effort; ignore transient errors */
  }
}
```

(3b) Persist on workflow change. Update the `el.workflowSelect` change listener (added in Task 4, step 3c) to also call `saveActiveWorkflow`:

```js
if (el.workflowSelect) {
  el.workflowSelect.addEventListener('change', async () => {
    state.workflowId = el.workflowSelect.value || 'wf_default';
    saveActiveWorkflow(state.workflowId);
    await renderWorkflowConfig(state.workflowId);
  });
}
```

(3c) Extend the delegated change handler on `el.pipelineConfig` (L568-582) to handle node selects and cycle inputs in addition to the legacy role selects. Replace the whole handler with:

```js
// Delegated change handler for all config controls inside #pipeline-config:
//  - legacy default-stage selects carry data-role (persist via saveStep);
//  - dynamic node selects carry data-node-id (persist via saveNode);
//  - feedback cycle inputs carry data-fb-id (persist via saveFeedback).
el.pipelineConfig.addEventListener('change', (e) => {
  const t = e.target;

  // Feedback cycle inputs (number inputs, not selects).
  if (t instanceof HTMLInputElement && t.dataset.fbId) {
    const n = Math.max(1, Math.round(Number(t.value) || 1));
    t.value = String(n); // normalize the field
    saveFeedback(state.workflowId, t.dataset.fbId, n);
    return;
  }

  if (!(t instanceof HTMLSelectElement)) return;

  // Dynamic per-node selects (saved workflow).
  if (t.dataset.nodeId) {
    const nodeId = t.dataset.nodeId;
    if (t.classList.contains('step-model')) {
      if (t.value === '__add__') return addModelFlowNode(nodeId);
      // New model -> reset effort + re-render this row's effort options.
      saveNode(state.workflowId, nodeId, t.value, '');
      const effortSel = el.wfNodeConfig.querySelector(`.step-effort[data-node-id="${nodeId}"]`);
      const caption = el.wfNodeConfig.querySelector(`.step-current[data-node-id="${nodeId}"]`);
      if (effortSel) renderModelEffortPair(t, effortSel, caption, { model: t.value, effort: '' });
    } else if (t.classList.contains('step-effort')) {
      const modelSel = el.wfNodeConfig.querySelector(`.step-model[data-node-id="${nodeId}"]`);
      const model = modelSel ? modelSel.value : '';
      saveNode(state.workflowId, nodeId, model, t.value);
      const caption = el.wfNodeConfig.querySelector(`.step-current[data-node-id="${nodeId}"]`);
      if (caption) {
        const m = modelById(model);
        caption.textContent = `${m ? m.label : 'default model'} · ${t.value || 'default effort'}`;
      }
    }
    return;
  }

  // Legacy default-stage selects (data-role).
  const role = t.dataset.role;
  if (!role) return;
  if (t.classList.contains('step-model')) {
    if (t.value === '__add__') return addModelFlow(role);
    saveStep(role, t.value, '');
  } else if (t.classList.contains('step-effort')) {
    const model = (state.config.steps[role] || {}).model || '';
    saveStep(role, model, t.value);
  }
});

// "+ Add model…" picked on a per-node select: add the custom model, then select
// it for that node (mirrors addModelFlow for the legacy role selects).
async function addModelFlowNode(nodeId) {
  const projectDir = selectedProjectPath();
  if (!projectDir) { renderWorkflowConfig(state.workflowId); return; }
  const id = (window.prompt('New model id (e.g. claude-opus-4-8 or a fine-tune id):') || '').trim();
  if (!id) { renderWorkflowConfig(state.workflowId); return; }
  const label = (window.prompt('Display name (optional):', id) || '').trim();
  try {
    const res = await fetch('/api/config/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, id, label }),
    });
    const data = await safeJson(res);
    if (!res.ok) {
      appendLog({ source: 'ui', level: 'error', text: `add model: ${data.error || res.status}`, ts: Date.now() });
      renderWorkflowConfig(state.workflowId);
      return;
    }
    state.models = Array.isArray(data.models) ? data.models : state.models;
    await saveNode(state.workflowId, nodeId, id, ''); // select the new model (effort reset)
    renderWorkflowConfig(state.workflowId);           // repaint with the new model in the list
  } catch (e) {
    appendLog({ source: 'ui', level: 'error', text: `add model error: ${e.message}`, ts: Date.now() });
    renderWorkflowConfig(state.workflowId);
  }
}
```

- [ ] **Step 4: Run — expect PASS.** Run:

```
node --test test/newpipeline-config.test.mjs
```

Expected: persistence tests pass; all earlier tests still green.

- [ ] **Step 5: Guard the existing config UI suite (the legacy `data-role` branch must be unchanged).** Run:

```
node --test test/config-ui.test.mjs test/ui-boot.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit.** Run:

```
git add ui/public/app.js test/newpipeline-config.test.mjs
git commit -m "feat(newpipeline): persist per-node model/effort, per-loop cycles, and active workflow"
```

---

### Task 6: Include `workflowId` in the POST /api/run payload + snapshot it for the run card

**Files:**
- modify: `ui/public/app.js` (form submit handler L1318-1388 — add `workflowId` to `body`; `beginRun` L1394-1401 — snapshot the workflow)
- test: `test/newpipeline-config.test.mjs` (append a submit-payload test)

The run must execute the **selected** workflow. Add `workflowId: state.workflowId` to the `/api/run` body. Backward-compat: when Default is selected, `state.workflowId === 'wf_default'`, which the server already treats as today's behavior. Also snapshot the workflowId onto the local run model (harmless, mirrors the existing config snapshot).

- [ ] **Step 1: Write the failing submit test.** Append to `test/newpipeline-config.test.mjs`:

```js
test('submitting the run posts the selected workflowId (default by default)', async () => {
  const runs = [];
  const base = workflowFetch();
  const { window } = await boot({
    fetchHandler: (url, opts) => {
      if (url.includes('/api/run') && opts && opts.method === 'POST') {
        runs.push(JSON.parse(opts.body));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ runId: 'r1' }) });
      }
      return base(url);
    },
  });
  selectProjectAnd(window);
  await new Promise((r) => setTimeout(r, 0));
  // default selected
  window.document.querySelector('#prompt').value = 'do a thing';
  window.document.querySelector('#run-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].workflowId, 'wf_default');
  assert.equal(runs[0].prompt, 'do a thing');
});

test('submitting after selecting a saved workflow posts that workflowId', async () => {
  const runs = [];
  const base = workflowFetch();
  const { window } = await boot({
    fetchHandler: (url, opts) => {
      if (url.includes('/api/run') && opts && opts.method === 'POST') {
        runs.push(JSON.parse(opts.body));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ runId: 'r2' }) });
      }
      return base(url);
    },
  });
  selectProjectAnd(window);
  await new Promise((r) => setTimeout(r, 0));
  pickWorkflow(window, 'wf_x');
  await new Promise((r) => setTimeout(r, 0));
  window.document.querySelector('#prompt').value = 'ship it';
  window.document.querySelector('#run-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].workflowId, 'wf_x');
});
```

- [ ] **Step 2: Run — expect FAIL.** Run:

```
node --test test/newpipeline-config.test.mjs
```

Expected: both submit tests fail (`runs[0].workflowId` is `undefined`).

- [ ] **Step 3: Add `workflowId` to the payload.** In `ui/public/app.js`, in the submit handler, extend the `body` object (currently L1330-1336) to include the workflow:

```js
  const body = {
    projectDir,
    title: title || undefined,
    workflowId: state.workflowId || 'wf_default',
    maxRefine: Number(el.maxRefine.value) || 5,
    maxReview: Number(el.maxReview.value) || 5,
    mock: el.mock.checked,
  };
```

Then snapshot the workflow id in `beginRun` (L1394-1401) by extending the `configSnapshot` line:

```js
function beginRun(runId, projectDir, title) {
  const r = upsertRun({ runId, title: title || '(untitled)', projectDir, status: 'starting', local: true });
  r.configSnapshot = JSON.parse(JSON.stringify({ steps: state.config.steps, models: state.models, workflowId: state.workflowId }));
  hideViewer();
  updateNavCounts();
  showView('running');
  renderRunningView();
}
```

- [ ] **Step 4: Run — expect PASS.** Run:

```
node --test test/newpipeline-config.test.mjs
```

Expected: both submit tests pass; the whole file is green.

- [ ] **Step 5: Commit.** Run:

```
git add ui/public/app.js test/newpipeline-config.test.mjs
git commit -m "feat(newpipeline): submit the selected workflowId in the POST /api/run payload"
```

---

### Task 7: Full-suite verification + smoke (default-workflow parity)

**Files:**
- (no code changes; verification + a topbar-subtitle polish in `ui/public/index.html` if the subtitle is stale)

Confirm the entire UI + engine suite is green and the offline smoke run (default workflow) is unaffected — the load-bearing backward-compat guarantee. Also refresh the New-Pipeline subtitle which still hardcodes the default pipeline; leave the copy accurate.

- [ ] **Step 1: Run the full test suite.** Run:

```
node --test test/*.mjs
```

Expected: PASS across the board, including `newpipeline-config.test.mjs`, `config-ui.test.mjs`, `config-api.test.mjs`, and all `ui-*.test.mjs`. If any pre-existing UI test fails, fix the cause here (most likely a missed reference to the now-wrapped default stages).

- [ ] **Step 2: Run the offline smoke (default workflow parity).** Run:

```
MAESTRO_MOCK=1 npm run smoke
```

Expected: exits 0 — the default workflow (selected by default, `wf_default`) reproduces today's `Plan → Refine → Implement → Review` run end-to-end with no Claude calls.

- [ ] **Step 3: Keep the New-Pipeline subtitle truthful.** In `ui/public/index.html`, the New-Pipeline `.sub` (L66) reads `Plan &rarr; Refine &rarr; Implement &rarr; Review`. That is still the **default**; make it clear a workflow is now selectable by replacing L66:

```html
              <div class="sub">Pick a workflow, configure each agent, and run · default: Plan &rarr; Refine &rarr; Implement &rarr; Review</div>
```

- [ ] **Step 4: Re-run the markup + boot tests after the copy edit.** Run:

```
node --test test/newpipeline-config.test.mjs test/ui-boot.test.mjs
```

Expected: PASS (the subtitle text is not asserted by any test; this just confirms nothing broke).

- [ ] **Step 5: Commit.** Run:

```
git add ui/public/index.html
git commit -m "docs(newpipeline): clarify the New Pipeline subtitle now that workflows are selectable"
```

## Phase 7: Docs: adding an agent + workflow/run-config model

> Goal: make "add a new agent" a documented, repeatable drop-in (no tribal knowledge). This phase ships `docs/ADDING-AGENTS.md` (a complete how-to), a short README pointer to the Pipeline Composer + the new doc, a CI-friendly **pairing guard** (every `agents/*.md` has a sibling `agents/*.meta.json`), and a tiny test that asserts that pairing. It is *docs-and-guard* only — it adds no engine behavior, so the bulk of the work is authored prose + one assertion test.
>
> **Required reads before starting (cite by file:line):**
> - `README.md` (full) — match its tone/structure. Real anchors used below: `## The 4 agents` (README.md:138), the agent table (README.md:140-145), `## The phases and loops` (README.md:149), `## Project structure` (README.md:188-199).
> - SHARED CONTRACT — `AgentMeta` shape, `runnerType ∈ {producer,verifier}`, the file map, and the public signatures of `agent-registry.mjs` (`loadAgentRegistry`, `registryToSteps`), `workflows.mjs` (`resolveWorkflow`, `DEFAULT_WORKFLOW`), `runners.mjs` (`runners = { producer, verifier }`), `config.mjs` (`resolveRunConfig`).
> - The 2 new agents from Phase 1 as worked examples: `agents/maestro-manual-tests-checklist.md` + `agents/manualTestsChecklist.meta.json`, `agents/maestro-manual-web-ui-testing.md` + `agents/manualWebUiTesting.meta.json`.
> - For accurate frontmatter/`tools`/severity prose: `agents/maestro-planner.md:1-6`, `agents/maestro-implementer.md:1-6`, `src/core/phases.mjs:22-24` (allowedTools per role), `src/core/protocol.mjs:15-17` (`SEVERITIES`; critical/major block), `src/core/orchestrator.mjs:331-389` (`_refineLoop` gate this loop reproduces).

### Task 1: Add the pairing guard + its test (TDD)

This is the only executable deliverable, so it goes first (red → green). The guard is the invariant the doc relies on: **every executable agent prompt `agents/<file>.md` is paired with an `agents/<key>.meta.json` whose `agentFile` names it, and every `agentFile` in a meta points at a real `.md`.** The test is the machine-checked form; the doc's "Verify" step is the human/CI shell form.

**Files:**
- Test (create): `test/agents-meta.test.mjs`
- Reference (read only, do not modify): `agents/*.meta.json` (the 6 sidecars from Phase 1), `src/core/agent-registry.mjs` (`loadAgentRegistry`)

- [ ] **Step 1: Write the failing test (full code)**

Create `test/agents-meta.test.mjs`:

```javascript
// test/agents-meta.test.mjs
// Guards the "drop two files to add an agent" invariant documented in
// docs/ADDING-AGENTS.md: every agents/<key>.meta.json names a runnable
// runnerType and (when agentFile is set) points at a real prompt .md, and
// every agents/*.md prompt is claimed by exactly one meta sidecar. If this
// ever fails, an agent was added without its pair — see docs/ADDING-AGENTS.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadAgentRegistry } from '../src/core/agent-registry.mjs';

const AGENTS_DIR = fileURLToPath(new URL('../agents/', import.meta.url));
const RUNNER_TYPES = new Set(['producer', 'verifier']);

async function listAgents() {
  const names = await readdir(AGENTS_DIR);
  return {
    metas: names.filter((n) => n.endsWith('.meta.json')),
    // Only prompt markdown — never count a .meta.json as a prompt.
    prompts: names.filter((n) => n.endsWith('.md') && !n.endsWith('.meta.json')),
  };
}

test('every prompt agents/*.md is claimed by some meta.agentFile', async () => {
  const { prompts } = await listAgents();
  const registry = loadAgentRegistry(AGENTS_DIR);
  const claimed = new Set(
    Object.values(registry).map((m) => m.agentFile).filter(Boolean),
  );
  const orphans = prompts.filter((p) => !claimed.has(p));
  assert.deepEqual(
    orphans,
    [],
    `prompt(s) with no sibling meta.json: ${orphans.join(', ')} — add agents/<key>.meta.json (see docs/ADDING-AGENTS.md)`,
  );
});

test('every meta.agentFile points at a real prompt .md that exists', async () => {
  const { prompts } = await listAgents();
  const present = new Set(prompts);
  const registry = loadAgentRegistry(AGENTS_DIR);
  for (const meta of Object.values(registry)) {
    if (meta.agentFile == null) continue; // palette-only agents may omit a prompt
    assert.ok(
      present.has(meta.agentFile),
      `meta "${meta.key}" names agentFile "${meta.agentFile}" but that file is missing in agents/`,
    );
  }
});

test('every meta has the required fields and a runnable runnerType', async () => {
  const { metas } = await listAgents();
  assert.ok(metas.length >= 6, 'expected at least the 6 shipped agent metas');
  for (const file of metas) {
    const raw = await readFile(join(AGENTS_DIR, file), 'utf8');
    const meta = JSON.parse(raw);
    // key must match the filename stem (agents/<key>.meta.json).
    assert.equal(`${meta.key}.meta.json`, file, `meta.key must equal the file stem for ${file}`);
    for (const field of ['key', 'displayName', 'description', 'color', 'icon', 'runnerType', 'order']) {
      assert.ok(meta[field] != null && meta[field] !== '', `${file}: missing "${field}"`);
    }
    assert.ok(RUNNER_TYPES.has(meta.runnerType), `${file}: runnerType "${meta.runnerType}" must be producer|verifier`);
    assert.equal(typeof meta.loopSource, 'boolean', `${file}: loopSource must be a boolean`);
    assert.equal(typeof meta.order, 'number', `${file}: order must be a number`);
  }
});

test('loadAgentRegistry returns the 6 shipped agents keyed by key, sorted by order', async () => {
  const registry = loadAgentRegistry(AGENTS_DIR);
  const keys = Object.keys(registry);
  for (const k of ['planner', 'refiner', 'implementer', 'reviewer', 'manualTestsChecklist', 'manualWebUiTesting']) {
    assert.ok(keys.includes(k), `registry missing "${k}"`);
  }
  const orders = keys.map((k) => registry[k].order);
  const sorted = [...orders].sort((a, b) => a - b);
  assert.deepEqual(orders, sorted, 'loadAgentRegistry must return entries sorted by .order');
});
```

- [ ] **Step 2: Run the test and watch it pass against Phase 1's files (or FAIL loudly if a pair is missing)**

Run: `node --test test/agents-meta.test.mjs`

Expected, given Phase 1 shipped all 6 sidecars + the 2 new prompts: **PASS** (4 tests). If Phase 1 is incomplete (e.g. a `.md` exists with no sibling `.meta.json`, or a `meta.agentFile` points nowhere), this **FAILS** with the exact offending filename — which is precisely the guard's job. Treat any failure here as "an agent was added without its documented pair" and fix the pairing before continuing. (This is the test-first proof: the test only goes green once the drop-in pairing is correct.)

- [ ] **Step 3: Add an offline shell guard (the doc's "Verify" command) and confirm it agrees**

Run this exact one-liner (it is the copy-paste command embedded verbatim in `docs/ADDING-AGENTS.md` §Verify). It exits non-zero and prints the unpaired prompt if any `agents/*.md` lacks a sibling `agents/*.meta.json`:

```bash
for f in agents/*.md; do
  key_meta="agents/$(basename "${f%.md}").meta.json"
  ls agents/*.meta.json >/dev/null 2>&1 || { echo "no meta sidecars at all"; exit 1; }
  grep -lq "\"agentFile\"[[:space:]]*:[[:space:]]*\"$(basename "$f")\"" agents/*.meta.json \
    || { echo "UNPAIRED: $f has no agents/*.meta.json with agentFile \"$(basename "$f")\""; exit 1; }
done; echo "OK: every agents/*.md is paired with a meta sidecar"
```

Expected: prints `OK: every agents/*.md is paired with a meta sidecar` and exits 0. (Pairs a prompt to *any* meta whose `agentFile` names it, matching the test's semantics. The naming convention is `agents/maestro-<role>.md` for the prompt and `agents/<camelKey>.meta.json` for the sidecar — they differ on purpose: the sidecar links to the prompt via its `agentFile` field, not by filename.)

- [ ] **Step 4: Commit**

```bash
git add test/agents-meta.test.mjs
git commit -m "test(agents): guard every agent prompt has a paired meta.json sidecar"
```

### Task 2: Author docs/ADDING-AGENTS.md (the full how-to)

The implementation *is* the file's full content (below) — not a description of it. It walks the six steps the CONTRACT requires: (1) write `agents/<key>.md`, (2) write `agents/<key>.meta.json` with every field explained and the `manualWebUiTesting` meta as a complete example, (3) choose `runnerType` (or add a runner — shape shown), (4) automatic Composer palette via `loadAgentRegistry`, (5) how template topology (`resolveWorkflow`) + per-project run-config (`resolveRunConfig`) merge at run time, (6) `loopSource` semantics. It ends with the Verify command from Task 1.

**Files:**
- Doc (create): `docs/ADDING-AGENTS.md`
- Read to keep prose accurate: SHARED CONTRACT (signatures/shapes), `src/core/protocol.mjs:15-17`, `agents/maestro-code-reviewer.md:31-53`, `agents/maestro-manual-web-ui-testing.md` (Phase 1), `agents/manualWebUiTesting.meta.json` (Phase 1).

- [ ] **Step 1: Create `docs/ADDING-AGENTS.md` with exactly this content**

````markdown
# Adding an agent to Maestro

Maestro's agent system is **data-driven**: an agent is two sibling files in
`agents/` plus a choice of *runner*. Drop those files in and the agent appears
in the **Pipeline Composer** palette automatically — no edits to the engine,
the orchestrator, or the UI. This page is the complete recipe.

> Authoritative module/event/file contract: [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).
> Composer design: [`docs/superpowers/specs/2026-06-01-pipeline-composer-design.md`](superpowers/specs/2026-06-01-pipeline-composer-design.md).

## TL;DR

1. Write the prompt: `agents/maestro-<your-role>.md` (YAML frontmatter incl. `tools`, then the system prompt).
2. Write the sidecar: `agents/<key>.meta.json` (`key`, `displayName`, `color`, `icon`, `agentFile`, `runnerType`, `loopSource`, `order`, …).
3. Pick a `runnerType`: `producer` (makes artifacts/code) or `verifier` (emits a review verdict, can drive a feedback loop). Only add a runner if you need genuinely new behavior.
4. **Done.** `loadAgentRegistry()` scans `agents/*.meta.json`, so the agent is in the palette and drag-droppable. Topology you draw in the Composer + your project's model/effort/cycle settings resolve into an executable plan at run time.
5. Verify the pairing: run the guard at the bottom of this page (and `node --test test/agents-meta.test.mjs`).

`key` is the canonical camelCase identifier used **everywhere** (registry,
workflow node `key`, run-config). The six shipped keys are: `planner`,
`refiner`, `implementer`, `reviewer`, `manualTestsChecklist`,
`manualWebUiTesting`.

---

## Step 1 — Write `agents/maestro-<role>.md` (prompt + frontmatter)

The prompt is markdown with a YAML frontmatter block. The orchestrator loads the
body as the agent's *appended system prompt* (prepended with the preflight
tool instruction). Frontmatter mirrors the existing four agents
(`agents/maestro-planner.md`, `…-implementer.md`, `…-code-reviewer.md`):

```markdown
---
name: maestro-manual-web-ui-testing
description: Runs the drafted manual UI checklist against the live web app via Playwright (MCP) and emits the protocol.mjs verdict JSON so it can drive a feedback loop back to Implementation. Invoked by the deterministic orchestrator.
tools: Read, Bash, Grep, Glob, mcp__plugin_playwright_playwright__browser_navigate, mcp__plugin_playwright_playwright__browser_click, mcp__plugin_playwright_playwright__browser_type, mcp__plugin_playwright_playwright__browser_snapshot, mcp__plugin_playwright_playwright__browser_take_screenshot
model: inherit
---

You are the **Manual web UI testing** agent in a deterministic, data-driven
pipeline. You are spawned headlessly... (full role instructions here).
```

Frontmatter keys:

- **`name`** — the agent's headless identifier. By convention `maestro-<role>`,
  matching the file stem.
- **`description`** — one paragraph: what the agent does and that it is invoked
  by the orchestrator (never directly by a human). Keep it crisp; it is also a
  routing hint.
- **`tools`** — the **allowed tools** for this agent, comma-separated. Grant the
  minimum it needs:
  - Producers that write artifacts/code use the read/write set, e.g.
    `Read, Write, Edit, Bash, Grep, Glob` (the implementer additionally uses
    `MultiEdit`; see `src/core/phases.mjs` `READ_WRITE_TOOLS`/`IMPLEMENTER_TOOLS`).
  - A verifier that only inspects + reports needs less write capability, e.g.
    `Read, Bash, Grep, Glob`.
  - **MCP tools** (e.g. Playwright) are declared by their fully-qualified tool
    names, exactly as in the example above. This is how *Manual web UI testing*
    gets a browser. Declaring a tool the environment doesn't provide simply
    means it's unavailable at run time — instruct the agent to degrade
    gracefully and report if it cannot proceed.
  - Add `Skill` if the agent must invoke project/personal skills via the `Skill`
    tool (headless `claude -p` otherwise denies skill calls).
- **`model: inherit`** — keep this. The effective model/effort is chosen
  per-node by the user's run-config (Step 5), not pinned in the prompt.

**If the agent emits a verdict** (a `verifier`, see Step 3), the prompt MUST
instruct it to write the review JSON in the `protocol.mjs` shape so the loop can
gate on it:

```json
{
  "issues": [
    { "severity": "critical", "title": "…", "detail": "…", "location": "path:line" }
  ],
  "summary": "1-3 sentence verdict."
}
```

Severities are `critical | major | minor | suggestion`; **only `critical` and
`major` are blocking** (`src/core/protocol.mjs` `SEVERITIES` / `hasBlocking`).
Report `[]` with a positive summary when the run genuinely passes. See
`agents/maestro-code-reviewer.md` for the canonical verdict-writing prose to
copy.

> A prompt may be omitted only for a non-executable, palette-only agent — set
> `"agentFile": null` in the meta. None ship today; every agent in scope has a
> prompt.

---

## Step 2 — Write `agents/<key>.meta.json` (the sidecar)

This sidecar is what makes the agent *discoverable*. `loadAgentRegistry()` scans
`agents/*.meta.json` and builds the registry that the palette, the orchestrator,
and the per-project config all read from. **Every field, explained:**

| Field | Type | Meaning |
|-------|------|---------|
| `key` | string (camelCase) | Canonical id. Must equal the file stem: `agents/<key>.meta.json`. Used as the workflow node `key`, the registry key, and across run-config. |
| `displayName` | string | Human label shown on the palette pill and node. |
| `description` | string | Short blurb (palette tooltip / node subtitle). |
| `color` | enum | One of `green, peach, red, blue, violet, amber` — maps to the CSS color tokens; tints the palette dot/pill. |
| `icon` | string | **Inline SVG inner markup** for a `viewBox="0 0 24 24"` glyph (paths only, no wrapping `<svg>`). Copy a glyph from the mockup `ICON` map. |
| `agentFile` | string \| null | Prompt filename in `agents/` (e.g. `"maestro-manual-web-ui-testing.md"`). `null` for a palette-only agent (no runner invoked). |
| `runnerType` | `"producer"` \| `"verifier"` | Selects the execution function from the runner registry (Step 3). |
| `loopSource` | boolean | `true` if this agent may **originate a feedback loop** (it emits a blocking/non-blocking verdict). Only meaningful for `verifier`. See Step 6. |
| `connectsTo` | `"*"` | Which agents it can wire to in the Composer. `"*"` (everything) for now. |
| `order` | number | Palette render order; `loadAgentRegistry` returns the registry **sorted by `order`**. |

**Complete worked example — the shipped `agents/manualWebUiTesting.meta.json`:**

```json
{
  "key": "manualWebUiTesting",
  "displayName": "Manual web UI testing",
  "description": "Runs the manual checklist against the live web UI via Playwright and emits a pass/fail verdict.",
  "color": "violet",
  "icon": "<path d='M3 5h18v12H3z' fill='none' stroke='currentColor' stroke-width='2'/><path d='M3 19h18' stroke='currentColor' stroke-width='2'/>",
  "agentFile": "maestro-manual-web-ui-testing.md",
  "runnerType": "verifier",
  "loopSource": true,
  "connectsTo": "*",
  "order": 6
}
```

That single file is enough for *Manual web UI testing* to: appear last in the
palette (`order: 6`), render a violet pill with the screen glyph, run via the
`verifier` runner, and be eligible as a feedback-loop origin (`loopSource: true`)
— with **zero** engine edits.

For comparison, the producer sibling `agents/manualTestsChecklist.meta.json`
uses `"runnerType": "producer"`, `"loopSource": false`, `"color": "amber"`,
`"order": 5` — it drafts the checklist artifact and never originates a loop.

---

## Step 3 — Choose a `runnerType` (or add a runner)

A `runnerType` names an entry in the runner registry
(`src/core/runners.mjs`): `runners = { producer, verifier }`. Each runner is
`async (ctx) => RunnerResult`. **Almost every new agent reuses one of the two —
no engine code needed.**

- **`producer`** — generates artifacts/code. The Plan, Refine, Implement, and
  **Manual Tests Checklist** agents are producers. The runner carries the
  planner/refiner/implementer specializations via mode flags on `ctx`.
- **`verifier`** — emits the `protocol.mjs` review verdict (`issues[]` +
  `summary`); eligible as a `loopSource`. The Review and **Manual web UI
  testing** agents are verifiers.

The runner receives a `ctx` that extends the orchestrator's phase context with
`{ nodeId, key, agentPrompt, stepIndex, cycle, claudeOpts:{ model, effort, … } }`,
and returns:

```js
// RunnerResult
{
  status: "ok" | "blocked",      // "blocked" when a verifier found critical/major issues
  issues?: [{ severity, title, detail, location }],
  summary?: string,
  cost?: number,                 // forwarded to cost tracking
  artifacts?: Array              // paths produced
}
```

**Only add a runner if you need genuinely new behavior** the two types can't
express. The shape to add:

```js
// src/core/runners.mjs
export const runners = {
  producer,                       // existing
  verifier,                       // existing

  // New runner: a name you set as `"runnerType": "myKind"` in a meta sidecar.
  async myKind(ctx) {
    // ctx: { nodeId, key, agentPrompt, stepIndex, cycle, claudeOpts, ...phaseCtx }
    // Drive the agent (e.g. via the same claude-runner path the others use),
    // then return the contracted RunnerResult.
    return {
      status: 'ok',               // or 'blocked' to gate a loop (requires loopSource:true on the node)
      summary: 'what happened',
      // issues: [...], cost, artifacts
    };
  },
};
```

Then set `"runnerType": "myKind"` in your meta. The dispatcher calls
`runners[node.runnerType](ctx)` — an unknown `runnerType` is rejected by the
workflow validator before a run starts, so wire the registry entry first.

---

## Step 4 — It appears in the Composer automatically

There is no registration list to edit. At startup the registry is built by:

```js
// src/core/agent-registry.mjs
loadAgentRegistry(agentsDir)   // scans agents/*.meta.json -> { [key]: AgentMeta }, sorted by .order
registryToSteps(registry)      // -> [{ key, label }] (the AGENT_STEPS-shaped list)
```

Because the **Composer palette is built from this registry** (served via
`GET /api/agents`), your new agent shows up as a draggable pill the moment its
`agents/<key>.meta.json` exists — positioned by `order`, tinted by `color`,
glyphed by `icon`. The legacy fixed `AGENT_STEPS` is now *derived* from the
registry via `registryToSteps`, so per-stage model/effort pickers pick the agent
up too. No `app.js`, `index.html`, or `config.mjs` edit is required to surface a
new agent.

---

## Step 5 — How topology + run-config resolve at run time

Two layers combine when a pipeline runs. They are deliberately separate so a
workflow can be shared while each project keeps its own model/cost choices:

1. **Workflow template — topology only, global.** Stored at
   `~/.maestro/workflows/<id>.json`:

   ```json
   {
     "id": "wf_quickfix", "name": "Quick Fix", "version": 1,
     "steps": [
       [ { "id": "s0_0", "key": "planner" } ],
       [ { "id": "s1_0", "key": "implementer" } ],
       [ { "id": "s2_0", "key": "reviewer" } ]
     ],
     "feedbacks": [ { "id": "fb_0", "from": "s2_0", "to": "s1_0" } ],
     "createdAt": "…", "updatedAt": "…"
   }
   ```

   `steps` outer array = **sequential** order; an inner array with >1 node is a
   **parallel** group (run concurrently). Each node `id` is a unique *instance*
   id within the workflow (e.g. `s0_0`) — feedbacks and run-config reference
   these ids, not the role `key`, so the same agent can appear in several steps
   or cycles unambiguously. The built-in `DEFAULT_WORKFLOW` (id `wf_default`) is
   the current `Plan → Refine → Implement → Review`.

2. **Run-config — model/effort/cycles, per-project.** Stored in
   `<projectDir>/.maestro/config.json` (the legacy `steps`/`customModels` keys
   are untouched):

   ```json
   {
     "steps": { "…legacy per-role…": {} },
     "customModels": [],
     "workflows": {
       "wf_quickfix": {
         "nodes": { "s1_0": { "model": "claude-opus-4-8", "effort": "high" } },
         "feedbacks": { "fb_0": { "maxCycles": 3 } }
       }
     },
     "activeWorkflowId": "wf_quickfix"
   }
   ```

**At run time** `resolveWorkflow(projectDir, workflowId, registry)` loads the
template (or the built-in default), looks each node's `key` up in the registry
to attach `runnerType`, `agentFile`, the prompt body, `tools`, and `loopSource`,
then merges the per-project run-config (via
`resolveRunConfig(projectDir, workflowId)`) to attach `model`/`effort` per node
and `maxCycles` per feedback — producing the **ExecutablePlan**:

```js
{
  id, name,
  steps: [ [ { nodeId, key, runnerType, agentFile, agentPrompt, model, effort, tools, loopSource } ] ],
  feedbacks: [ { id, from, to, maxCycles, gate: "hasBlocking" } ]
}
```

The dispatcher walks `plan.steps` in order: a single-node step runs
`runners[node.runnerType](ctx)` directly; a multi-node step runs its nodes with
`Promise.all` (parallel). Every emitted engine event is tagged with `{ nodeId,
stepIndex, cycle }` so parallel/looped output stays attributable.

**Net effect for a new agent:** you only authored two files in `agents/`. Its
model/effort come from whatever the user picks in *New Pipeline* (keyed by node
id), and its place in the flow comes from whatever workflow includes it. Nothing
in the agent is hardcoded to a position.

---

## Step 6 — `loopSource` semantics (feedback loops)

`loopSource: true` marks an agent that can **originate a feedback loop**. It is
only meaningful for a `verifier` (a producer has no verdict to gate on).

A feedback edge `{ id, from, to }` points **backward**: `from` is a later step
(where the `loopSource` node lives) and `to` is an earlier step to re-run. At run
time, when a `loopSource` node returns `status: "blocked"` (i.e. its verdict has
`critical`/`major` issues per `protocol.mjs` `hasBlocking`) **and** that loop's
`cycle < maxCycles`, the dispatcher moves the execution pointer back to the
loop's `to` step and re-runs forward, incrementing that loop's `cycle`. When
`maxCycles` is exhausted, it **gates to the user** (continue / stop) exactly as
the original `_refineLoop`/`_reviewLoop` did (`src/core/orchestrator.mjs`).

This is how the default workflow reproduces today's two loops:

- **Refine loop** — `refiner` (`loopSource`) gating back to `Plan`.
- **Review loop** — `reviewer` (`loopSource`) gating back to `Implement`.

The two new agents follow the same rule:

- **Manual Tests Checklist** — `loopSource: false`; it produces an artifact and
  never gates.
- **Manual web UI testing** — `loopSource: true`; on a blocking verdict it can
  drive a feedback loop back to *Implementation*.

The workflow validator (`src/core/workflow-validator.mjs`) enforces that a
feedback's `to` step precedes its `from` step, that ids are unique, and that
every referenced node exists — so a malformed loop is rejected before a run
starts, and `maxCycles ≥ 1` bounds every cycle.

---

## Verify (the pairing guard)

Adding an agent means **two** files. This invariant — every prompt has a sibling
meta that claims it — is guarded two ways. Run both before you commit:

```bash
node --test test/agents-meta.test.mjs
```

…and the offline shell guard (CI-friendly; exits non-zero on the first
unpaired prompt):

```bash
for f in agents/*.md; do
  grep -lq "\"agentFile\"[[:space:]]*:[[:space:]]*\"$(basename "$f")\"" agents/*.meta.json \
    || { echo "UNPAIRED: $f has no agents/*.meta.json with agentFile \"$(basename "$f")\""; exit 1; }
done; echo "OK: every agents/*.md is paired with a meta sidecar"
```

Then run the full offline smoke to confirm the engine still drives the default
workflow end to end:

```bash
MAESTRO_MOCK=1 npm run smoke
```
````

- [ ] **Step 2: Sanity-check the doc renders and its links resolve**

Run: `node --test test/agents-meta.test.mjs && for f in agents/*.md; do grep -lq "\"agentFile\"[[:space:]]*:[[:space:]]*\"$(basename "$f")\"" agents/*.meta.json || { echo "UNPAIRED: $f"; exit 1; }; done; echo OK`

Expected: the test PASSES and the embedded guard prints `OK` — proving the exact commands copy-pasted into the doc actually work against the repo. Also confirm the two relative links resolve from `docs/`: `ls docs/ARCHITECTURE.md docs/superpowers/specs/2026-06-01-pipeline-composer-design.md` (both exist).

- [ ] **Step 3: Commit**

```bash
git add docs/ADDING-AGENTS.md
git commit -m "docs: add ADDING-AGENTS guide (prompt+meta, runnerType, resolve, loopSource)"
```

### Task 3: Point README at the Composer + the new doc

Two small, surgical README edits anchored to **real** headings found in `README.md`: (a) refresh the `## The 4 agents` section so it acknowledges the 6-agent, data-driven model and links the new guide; (b) add a `## Pipeline Composer` section after `## The phases and loops` (README.md:149-162) and before `## Artifact layout` (README.md:166). Match the existing tone (terse, second-person, backtick paths).

**Files:**
- Modify: `README.md` (heading `## The 4 agents` at README.md:138; insert new section between `## The phases and loops` and `## Artifact layout`)

- [ ] **Step 1: Add a "Pipeline Composer" + "Adding an agent" pointer to the agents section**

In `README.md`, immediately **after** the agent table (the line ending `…hands back to the implementer to fix. |` at README.md:145, before the `---` at README.md:147), insert:

```markdown

Maestro now ships **6 runnable agents** and the agent system is **data-driven**:
each agent is a prompt (`agents/maestro-<role>.md`) plus a metadata sidecar
(`agents/<key>.meta.json`), so new agents drop in without engine edits. Beyond
the four above, it adds **Manual Tests Checklist** (drafts manual test cases) and
**Manual web UI testing** (runs them against the live web UI via Playwright and
emits a pass/fail verdict). To add your own, see
[`docs/ADDING-AGENTS.md`](docs/ADDING-AGENTS.md).
```

- [ ] **Step 2: Add the "## Pipeline Composer" section**

In `README.md`, insert this new section **between** the end of `## The phases and loops` (after the line `not hold up the loop.` at README.md:162) and the `---` preceding `## Artifact layout` (README.md:164). Place it as its own block:

```markdown

## Pipeline Composer

The phases above are the **default** pipeline. The **Pipeline Composer** (a view
in the web UI) lets you compose your own: drag agents onto a canvas to build
**sequential steps**, **parallel groups** (a step with more than one agent runs
concurrently), and **feedback loops** (an agent that emits a verdict can loop
back to an earlier step until it passes or hits a cycle cap). Save a layout by
name and it becomes selectable from **New Pipeline**, where you also pick each
agent's model/effort and each loop's cycle count.

The engine is data-driven: it executes whatever workflow you select. The default
workflow reproduces exactly the `Plan → Refine → Implement → Review` behavior
described above, and **Reset to default** on the canvas redraws it. Workflow
topology is saved globally under `~/.maestro/workflows/`; per-project
model/effort/cycle choices live in `<projectDir>/.maestro/config.json`.

To add a new agent to the palette, see [`docs/ADDING-AGENTS.md`](docs/ADDING-AGENTS.md).
```

- [ ] **Step 3: Verify the README still reads cleanly and links resolve**

Run: `grep -n "Pipeline Composer\|docs/ADDING-AGENTS.md" README.md` (expect the new heading + two link occurrences) and `ls docs/ADDING-AGENTS.md` (exists after Task 2). Visually confirm the new `## Pipeline Composer` section sits between `## The phases and loops` and `## Artifact layout`, and that the agents-section paragraph sits directly under the agent table.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): add Pipeline Composer section + Adding-an-agent pointer"
```

