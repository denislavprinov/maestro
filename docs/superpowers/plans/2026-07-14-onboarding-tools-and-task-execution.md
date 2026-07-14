# Onboarding Tools + Task Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Enable onboarding pipeline always vendors mandatory tools (graphify, caveman) and shows them on the results screen, offers optional tools at clarify time and as one-click suggestions after completion, and — opt-in — executes the evaluator's top gap tasks with an honest re-score.

**Architecture:** Everything rides existing extension points: two new curated-list exports in `skill-vendor.mjs`, a plugin-cache source in `skills.mjs`, two new pure contract normalizers (`tools`, `tasks`) wired into the existing `validateContractOutputs` hook, one new metadata-declared verifier agent (`onboardingExecutor`) inserted into `ENABLE_WORKFLOW` with a feedback edge `s_execute → s_eval` (fires via the standard `hasBlocking` gate when the executor's review carries a "re-score required" major issue), one new server endpoint (`POST /api/enable/vendor`), and new results-screen sections. Zero orchestrator-engine changes.

**Tech Stack:** Node 26 ESM (`.mjs`), `node:test` + `assert/strict`, JSDOM for UI tests, Express server, vanilla-JS browser UI.

**Spec:** `docs/superpowers/specs/2026-07-14-onboarding-tools-and-task-execution-design.md`

## Global Constraints

- Test command: `npm test` runs `rm -rf .maestro-test && MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/*.mjs`. Run a single file with `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/<file>.mjs`.
- Contract-normalizer policy (must match siblings in `src/core/onboarding-contracts.mjs`): return `{ ok, value, warnings }`; repair + warn what code can fix; `ok:false` only when the artifact is unusable; derived fields are ALWAYS recomputed (mirroring `delta`).
- Vendoring security rule: allowlist MEMBERSHIP — never physical location — is the gate. No endpoint or agent may ever copy a skill name outside `CURATED_ALLOWLIST`.
- Install target is the TARGET REPO only (`.claude/skills/`). Nothing writes to the user's `~/.claude`.
- Backward compatibility: runs recorded before this change have no `tools.json` / `tasks-report.json`; every reader/renderer must treat them as absent (`null`) and render exactly as today.
- Agent `.md` files and `.meta.json` sidecars are the contract for LLM agents — prose changes there are code changes; keep ids/keys exactly as written here.
- Commit after every task with the trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Curated lists — caveman in baseline, OPTIONAL_CATALOG export

**Files:**
- Modify: `src/core/skill-vendor.mjs:7-16`
- Test: `test/skill-vendor.test.mjs`

**Interfaces:**
- Produces: `CURATED_BASELINE` (now includes `'caveman'`), new export `OPTIONAL_CATALOG` (frozen `string[]`), `CURATED_ALLOWLIST` (= baseline ∪ catalog, unchanged membership except caveman). Consumed later by contracts (Task 3), server (Task 8), and agent prose (Task 6).

- [ ] **Step 1: Write the failing tests** — append to `test/skill-vendor.test.mjs` (extend the existing import line to include `OPTIONAL_CATALOG` and `CURATED_ALLOWLIST`):

```js
test('caveman joins graphify in the curated baseline (mandatory tools)', () => {
  assert.ok(CURATED_BASELINE.includes('graphify'));
  assert.ok(CURATED_BASELINE.includes('caveman'));
});

test('OPTIONAL_CATALOG: subset of the allowlist, disjoint from the baseline', () => {
  assert.ok(OPTIONAL_CATALOG.length > 0);
  for (const name of OPTIONAL_CATALOG) {
    assert.ok(CURATED_ALLOWLIST.includes(name), `${name} must be allowlisted`);
    assert.ok(!CURATED_BASELINE.includes(name), `${name} must not be in the baseline`);
  }
});

test('caveman is always vendored even with zero refs (baseline union)', () => {
  const { vendor } = resolveVendorTargets(new Set());
  assert.ok(vendor.includes('caveman'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/skill-vendor.test.mjs`
Expected: FAIL — `OPTIONAL_CATALOG` is not exported / caveman missing.

- [ ] **Step 3: Implement** — replace lines 7-16 of `src/core/skill-vendor.mjs`:

```js
/** Always-vendored known-good floor (run-config overridable). */
export const CURATED_BASELINE = Object.freeze([
  'graphify', 'caveman', 'test-driven-development', 'systematic-debugging', 'verification-before-completion',
]);

/** Optional add-ons: offered at clarify (Q6) and suggested on the results screen.
 *  Invariant (tested): subset of the allowlist, disjoint from the baseline. */
export const OPTIONAL_CATALOG = Object.freeze([
  'writing-plans', 'executing-plans', 'requesting-code-review',
]);

/** Vetted allowlist the pipeline is permitted to vendor (superset of the baseline).
 *  Extend deliberately; membership — not physical location — is the gate. */
export const CURATED_ALLOWLIST = Object.freeze([...CURATED_BASELINE, ...OPTIONAL_CATALOG]);
```

- [ ] **Step 4: Run tests to verify pass** — same command, expected: PASS (all pre-existing tests in the file too).

- [ ] **Step 5: Commit**

```bash
git add src/core/skill-vendor.mjs test/skill-vendor.test.mjs
git commit -m "feat(onboarding): caveman in curated baseline + OPTIONAL_CATALOG export"
```

---

### Task 2: Plugin-cache skill resolution

**Files:**
- Modify: `src/core/skills.mjs` (resolveSkill, injectSkills, module doc)
- Test: `test/skills-resolve.test.mjs`, `test/skills-inject.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `resolveSkill(name, {repoRoot, projectDir, homeDir})` gains a 4th source `'plugin'` with `path` = the plugin-cache skill dir (`<homeDir>/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/`), tried AFTER bundle/global/project. `searched` gains one pattern entry (length 4). `injectSkills` copies `'plugin'`-sourced skills like `'bundle'` ones (neither is on the headless scan path).

- [ ] **Step 1: Write the failing tests** — in `test/skills-resolve.test.mjs`, update the existing priority-order test's final assertion from `assert.equal(hit.searched.length, 3)` to `assert.equal(hit.searched.length, 4)`, then append:

```js
test('resolveSkill: plugin-cache source, lowest priority', async () => {
  const repoRoot = await tmp();
  const homeDir = await tmp();
  const projectDir = await tmp();
  const ctx = { repoRoot, homeDir, projectDir };

  // plugin cache layout: <home>/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/
  await seedSkill(homeDir, '.claude/plugins/cache/mp/caveman/abc123/skills', 'caveman');
  const hit = resolveSkill('caveman', ctx);
  assert.equal(hit.source, 'plugin');
  assert.equal(hit.path, join(homeDir, '.claude/plugins/cache/mp/caveman/abc123/skills/caveman'));

  // project shadows plugin
  await seedSkill(projectDir, '.claude/skills', 'caveman');
  assert.equal(resolveSkill('caveman', ctx).source, 'project');
});

test('resolveSkill: no plugin cache dir at all is a clean miss', async () => {
  const ctx = { repoRoot: await tmp(), homeDir: await tmp(), projectDir: await tmp() };
  const r = resolveSkill('nothere', ctx);
  assert.equal(r.source, null);
  assert.equal(r.searched.length, 4);
});
```

In `test/skills-inject.test.mjs` (it already has `tmp`, `validateSkills`, `injectSkills`, `access` in scope) append:

```js
test('injectSkills copies a plugin-cache skill into the worktree (not on the scan path)', async () => {
  const repoRoot = await tmp();
  const projectDir = await tmp();
  const homeDir = await tmp();
  // seed ONLY a plugin-cache skill
  const pluginSkill = join(homeDir, '.claude', 'plugins', 'cache', 'mp', 'caveman', 'v1', 'skills', 'caveman');
  await mkdir(pluginSkill, { recursive: true });
  await writeFile(join(pluginSkill, 'SKILL.md'), '# caveman\n');
  const resolved = validateSkills([{ skill: 'caveman', requiredBy: ['x'] }], { repoRoot, projectDir, homeDir });
  assert.equal(resolved.get('caveman').source, 'plugin');
  const wt = await tmp();
  const injected = await injectSkills(resolved, { worktrees: [wt] });
  assert.deepEqual(injected, ['caveman']);
  await assert.doesNotReject(access(join(wt, '.claude', 'skills', 'caveman', 'SKILL.md')));
});
```

(The existing "skips global/project sources" test stays green — global is still skipped.)

- [ ] **Step 2: Run to verify failure**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/skills-resolve.test.mjs test/skills-inject.test.mjs`
Expected: FAIL — source is `null` for the plugin seed; searched.length is 3.

- [ ] **Step 3: Implement** — in `src/core/skills.mjs`:

Add `readdirSync` to the fs import: `import { existsSync, readdirSync } from 'node:fs';`

Add above `resolveSkill`:

```js
/** Locate <cacheRoot>/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md.
 *  Read-only readdir probes; each level scanned in sorted order so resolution
 *  is deterministic when a skill name exists in several plugins. */
function findPluginSkillDir(cacheRoot, name) {
  const subdirs = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch { return []; }
  };
  for (const marketplace of subdirs(cacheRoot)) {
    for (const plugin of subdirs(join(cacheRoot, marketplace))) {
      for (const version of subdirs(join(cacheRoot, marketplace, plugin))) {
        const dir = join(cacheRoot, marketplace, plugin, version, 'skills', name);
        if (existsSync(join(dir, 'SKILL.md'))) return dir;
      }
    }
  }
  return null;
}
```

Rework `resolveSkill`'s tail (keep the three existing probes byte-identical, extend the return contract):

```js
export function resolveSkill(name, { repoRoot, projectDir, homeDir = homedir() }) {
  const bundleDir    = join(repoRoot, 'skills', name);
  const globalDir    = join(homeDir, '.claude', 'skills', name);
  const projSkillDir  = join(projectDir, '.claude', 'skills', name);
  const pluginCache   = join(homeDir, '.claude', 'plugins', 'cache');
  const searched = [
    join(bundleDir, 'SKILL.md'),
    join(globalDir, 'SKILL.md'),
    join(projSkillDir, 'SKILL.md'),
    join(pluginCache, '<marketplace>', '<plugin>', '<version>', 'skills', name, 'SKILL.md'),
  ];
  if (existsSync(searched[0])) return { source: 'bundle',  path: bundleDir,    searched };
  if (existsSync(searched[1])) return { source: 'global',  path: globalDir,    searched };
  if (existsSync(searched[2])) return { source: 'project', path: projSkillDir, searched };
  const pluginDir = findPluginSkillDir(pluginCache, name);
  if (pluginDir) return { source: 'plugin', path: pluginDir, searched };
  return { source: null, path: null, searched };
}
```

Update the JSDoc `@returns` to `{source:'bundle'|'global'|'project'|'plugin'|null, ...}` and the priority list in the function comment (4. plugin — copied into the worktree like bundle; 5. none). In `injectSkills`, change the skip line to:

```js
    if (r.source !== 'bundle' && r.source !== 'plugin') continue;
```

and extend its doc comment: plugin-cache skills, like bundle ones, are not on the headless scan path, so they are copied too.

- [ ] **Step 4: Run tests to verify pass** — same command plus `test/skills-gate-wiring.test.mjs test/skills-bundle.test.mjs` (they exercise the same module). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/skills.mjs test/skills-resolve.test.mjs test/skills-inject.test.mjs
git commit -m "feat(skills): resolve + inject plugin-cache skills (source 'plugin')"
```

---

### Task 3: `normalizeToolsReport` contract

**Files:**
- Modify: `src/core/onboarding-contracts.mjs`
- Test: `test/onboarding-contracts.test.mjs`

**Interfaces:**
- Consumes: `CURATED_BASELINE` from `./skill-vendor.mjs` (pure constant import — module stays I/O-free).
- Produces: `normalizeToolsReport(raw) -> { ok, value: { installed: [{name, source, mandatory}], skipped: [{name, reason}], suggested: [{name, reason, source}] }, warnings }`. Consumed by the phases hook (Task 5) and indirectly by the UI via `tools.json`.

- [ ] **Step 1: Write the failing tests** — append to `test/onboarding-contracts.test.mjs` (add `normalizeToolsReport` to the import):

```js
// ── normalizeToolsReport ────────────────────────────────────────────────────

test('normalizeToolsReport: canonical object passes clean', () => {
  const input = {
    installed: [{ name: 'graphify', source: 'global', mandatory: true },
                { name: 'writing-plans', source: 'bundle', mandatory: false }],
    skipped: [{ name: 'my-private-thing', reason: 'not on allowlist' }],
    suggested: [{ name: 'executing-plans', reason: 'pairs with writing-plans', source: 'catalog' }],
  };
  const res = normalizeToolsReport(input);
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings, []);
  assert.deepEqual(res.value, input);
});

test('normalizeToolsReport: not an object is fatal', () => {
  assert.equal(normalizeToolsReport([]).ok, false);
  assert.equal(normalizeToolsReport('x').ok, false);
});

test('normalizeToolsReport: missing arrays default to [] with warnings', () => {
  const res = normalizeToolsReport({});
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, { installed: [], skipped: [], suggested: [] });
  assert.equal(res.warnings.length, 3);
});

test('normalizeToolsReport: mandatory is recomputed from the curated baseline', () => {
  const res = normalizeToolsReport({ installed: [
    { name: 'caveman', source: 'plugin', mandatory: false },      // lies: caveman IS baseline
    { name: 'writing-plans', source: 'global', mandatory: true }, // lies: it is not
  ], skipped: [], suggested: [] });
  assert.equal(res.ok, true);
  assert.equal(res.value.installed[0].mandatory, true);
  assert.equal(res.value.installed[1].mandatory, false);
  assert.ok(res.warnings.length >= 2);
});

test('normalizeToolsReport: bad entries dropped, unknown source coerced, installed names pruned from suggested', () => {
  const res = normalizeToolsReport({
    installed: [{ name: 'graphify', source: 'weird' }, { source: 'global' }, 'junk'],
    skipped: [{ name: 'x' }],
    suggested: [{ name: 'graphify', reason: 'dupe' }, { name: 'executing-plans', source: 'nope' }],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value.installed, [{ name: 'graphify', source: 'unknown', mandatory: true }]);
  assert.deepEqual(res.value.skipped, [{ name: 'x', reason: '' }]);
  assert.deepEqual(res.value.suggested, [{ name: 'executing-plans', reason: '', source: 'catalog' }]);
  assert.ok(res.warnings.length >= 4);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/onboarding-contracts.test.mjs`
Expected: FAIL — `normalizeToolsReport` is not exported.

- [ ] **Step 3: Implement** — in `src/core/onboarding-contracts.mjs`, add at the top (below the header comment):

```js
import { CURATED_BASELINE } from './skill-vendor.mjs';
```

and append after `normalizeGraphSummary`:

```js
const TOOL_SOURCES = new Set(['bundle', 'global', 'project', 'plugin', 'unknown']);
const SUGGESTION_SOURCES = new Set(['catalog', 'analyzer']);

/** Normalize one {name, ...} entry array; entries without a usable name are dropped. */
function namedEntries(raw, warnings, label, shape) {
  if (!Array.isArray(raw)) {
    warnings.push(`${label}: missing or not an array — defaulted to []`);
    return [];
  }
  const out = [];
  for (const e of raw) {
    if (!isPlainObject(e) || typeof e.name !== 'string' || !e.name.trim()) {
      warnings.push(`${label}: dropped entry without a usable name (${JSON.stringify(e)})`);
      continue;
    }
    out.push(shape(e, e.name.trim()));
  }
  return out;
}

/**
 * Normalize a tools.json object (infra-gen's installed/skipped/suggested tool report).
 * Fatal: not a plain object. `mandatory` is DERIVED from CURATED_BASELINE membership
 * (always recomputed, mirroring readiness.delta); suggested entries already installed
 * are pruned.
 */
export function normalizeToolsReport(raw) {
  const warnings = [];
  if (!isPlainObject(raw)) {
    return { ok: false, warnings: ['tools: not a plain object'] };
  }
  const baseline = new Set(CURATED_BASELINE);

  const installed = namedEntries(raw.installed, warnings, 'tools.installed', (e, name) => {
    let source = typeof e.source === 'string' && TOOL_SOURCES.has(e.source) ? e.source : 'unknown';
    if (source === 'unknown' && e.source !== 'unknown') {
      warnings.push(`tools.installed.${name}.source: not a known source (${JSON.stringify(e.source)}) — defaulted to "unknown"`);
    }
    const mandatory = baseline.has(name);
    if (typeof e.mandatory === 'boolean' && e.mandatory !== mandatory) {
      warnings.push(`tools.installed.${name}.mandatory: stored ${e.mandatory} did not match the curated baseline — recomputed value used`);
    }
    return { name, source, mandatory };
  });

  const skipped = namedEntries(raw.skipped, warnings, 'tools.skipped', (e, name) => ({
    name, reason: e.reason != null ? String(e.reason) : '',
  }));

  const installedNames = new Set(installed.map((t) => t.name));
  const suggested = namedEntries(raw.suggested, warnings, 'tools.suggested', (e, name) => {
    let source = typeof e.source === 'string' && SUGGESTION_SOURCES.has(e.source) ? e.source : 'catalog';
    if (source === 'catalog' && e.source != null && e.source !== 'catalog') {
      warnings.push(`tools.suggested.${name}.source: not catalog|analyzer (${JSON.stringify(e.source)}) — defaulted to "catalog"`);
    }
    return { name, reason: e.reason != null ? String(e.reason) : '', source };
  }).filter((s) => {
    if (installedNames.has(s.name)) {
      warnings.push(`tools.suggested.${s.name}: already installed — dropped`);
      return false;
    }
    return true;
  });

  const knownKeys = new Set(['installed', 'skipped', 'suggested']);
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) warnings.push(`tools.${key}: unknown top-level field — dropped`);
  }

  return { ok: true, value: { installed, skipped, suggested }, warnings };
}
```

- [ ] **Step 4: Run tests to verify pass** — same command. Expected: PASS. (If the "canonical passes clean" test warns on `mandatory`, the canonical fixture's booleans must match baseline membership — they do as written.)

- [ ] **Step 5: Commit**

```bash
git add src/core/onboarding-contracts.mjs test/onboarding-contracts.test.mjs
git commit -m "feat(contracts): normalizeToolsReport for the tools.json channel"
```

---

### Task 4: `normalizeTasksReport` contract

**Files:**
- Modify: `src/core/onboarding-contracts.mjs`
- Test: `test/onboarding-contracts.test.mjs`

**Interfaces:**
- Produces: `normalizeTasksReport(raw) -> { ok, value: { attempted: [{gap, status, notes}], completed, skipped, failed }, warnings }` — counts always recomputed from `attempted[]`.

- [ ] **Step 1: Write the failing tests** — append (add `normalizeTasksReport` to the import):

```js
// ── normalizeTasksReport ────────────────────────────────────────────────────

test('normalizeTasksReport: canonical object passes clean, counts intact', () => {
  const input = {
    attempted: [
      { gap: 'Add smoke test for CLI entry', status: 'completed', notes: 'test added + passing' },
      { gap: 'Document release flow', status: 'skipped', notes: 'needs a human decision' },
    ],
    completed: 1, skipped: 1, failed: 0,
  };
  const res = normalizeTasksReport(input);
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings, []);
  assert.deepEqual(res.value, input);
});

test('normalizeTasksReport: not an object is fatal', () => {
  assert.equal(normalizeTasksReport(null).ok, false);
  assert.equal(normalizeTasksReport([1]).ok, false);
});

test('normalizeTasksReport: counts are recomputed from attempted, mismatch warns', () => {
  const res = normalizeTasksReport({
    attempted: [{ gap: 'x', status: 'completed' }, { gap: 'y', status: 'failed' }],
    completed: 9, skipped: 9, failed: 9,
  });
  assert.equal(res.ok, true);
  assert.equal(res.value.completed, 1);
  assert.equal(res.value.skipped, 0);
  assert.equal(res.value.failed, 1);
  assert.ok(res.warnings.some((w) => /completed/.test(w)));
});

test('normalizeTasksReport: bad status coerced to skipped, gapless entries dropped', () => {
  const res = normalizeTasksReport({ attempted: [
    { gap: 'x', status: 'wat' }, { status: 'completed' }, 'junk',
  ] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value.attempted, [{ gap: 'x', status: 'skipped', notes: '' }]);
  assert.equal(res.value.skipped, 1);
  assert.ok(res.warnings.length >= 3); // bad status + 2 drops (+ count defaults)
});
```

- [ ] **Step 2: Run to verify failure** — same command as Task 3. Expected: FAIL (not exported).

- [ ] **Step 3: Implement** — append to `src/core/onboarding-contracts.mjs`:

```js
const TASK_STATUSES = new Set(['completed', 'skipped', 'failed']);

/**
 * Normalize a tasks-report.json object (the executor's gap-task report).
 * Fatal: not a plain object. The completed/skipped/failed counts are DERIVED
 * from attempted[] (always recomputed, mirroring readiness.delta).
 */
export function normalizeTasksReport(raw) {
  const warnings = [];
  if (!isPlainObject(raw)) {
    return { ok: false, warnings: ['tasks: not a plain object'] };
  }

  const attempted = [];
  if (!Array.isArray(raw.attempted)) {
    warnings.push('tasks.attempted: missing or not an array — defaulted to []');
  } else {
    for (const e of raw.attempted) {
      if (!isPlainObject(e) || typeof e.gap !== 'string' || !e.gap.trim()) {
        warnings.push(`tasks.attempted: dropped entry without a usable gap (${JSON.stringify(e)})`);
        continue;
      }
      let status = typeof e.status === 'string' ? e.status : '';
      if (!TASK_STATUSES.has(status)) {
        warnings.push(`tasks.attempted."${e.gap.trim()}".status: not completed|skipped|failed (${JSON.stringify(e.status)}) — defaulted to "skipped"`);
        status = 'skipped';
      }
      attempted.push({ gap: e.gap.trim(), status, notes: e.notes != null ? String(e.notes) : '' });
    }
  }

  const counts = { completed: 0, skipped: 0, failed: 0 };
  for (const a of attempted) counts[a.status] += 1;
  for (const k of Object.keys(counts)) {
    if (toNumberOrNull(raw[k]) !== counts[k]) {
      warnings.push(`tasks.${k}: stored ${JSON.stringify(raw[k])} did not match recomputed ${counts[k]} — recomputed value used`);
    }
  }

  const knownKeys = new Set(['attempted', 'completed', 'skipped', 'failed']);
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) warnings.push(`tasks.${key}: unknown top-level field — dropped`);
  }

  return { ok: true, value: { attempted, ...counts }, warnings };
}
```

- [ ] **Step 4: Run tests to verify pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/onboarding-contracts.mjs test/onboarding-contracts.test.mjs
git commit -m "feat(contracts): normalizeTasksReport for the tasks channel"
```

---

### Task 5: Contract hook — validate `tools` and `tasks` channels

**Files:**
- Modify: `src/core/phases.mjs:962-966` (CONTRACT_VALIDATORS + import)
- Test: `test/onboarding-contracts-hook.test.mjs`

**Interfaces:**
- Consumes: `normalizeToolsReport`, `normalizeTasksReport` (Tasks 3-4); `outputs.tools?.path` / `outputs.tasks?.path` — the generic-artifact handles the channel allocator mints for custom json channels (`channels.mjs` default branch).
- Produces: `validateContractOutputs` now also repairs/fails `tools.json` and `tasks-report.json` after any generic producer/verifier that declares those channels.

- [ ] **Step 1: Write the failing tests** — append to `test/onboarding-contracts-hook.test.mjs`, reusing its `ctxFor`/`captureWarnings`/`makeTmpDir` helpers:

```js
test('producer(tools): repairable tools.json is normalized on disk with a [contracts] warning', async () => {
  const dir = await makeTmpDir();
  const toolsPath = join(dir, 'tools.json');
  const node = { nodeId: 't0', key: 'infra', runnerType: 'producer', loopSource: false, agentPrompt: 'You are infra-gen.' };
  const cap = captureWarnings();
  try {
    await runGenericProducer(ctxFor(dir, node, {
      outputs: { tools: { kind: 'artifact', path: toolsPath, channel: 'tools' } },
    }));
  } finally { cap.restore(); }
  const written = JSON.parse(await readFile(toolsPath, 'utf8'));
  assert.deepEqual(written.installed, []);
  assert.deepEqual(written.skipped, []);
  assert.deepEqual(written.suggested, []);
  assert.ok(cap.lines.some((l) => l.startsWith('[contracts] tools:')));
});

test('verifier(tasks): missing tasks-report.json warns but does not throw', async () => {
  const dir = await makeTmpDir();
  const node = { nodeId: 'x0', key: 'onboardingExecutor', runnerType: 'verifier', loopSource: true, agentPrompt: 'You are the executor.' };
  const cap = captureWarnings();
  try {
    const res = await runGenericVerifier(ctxFor(dir, node, {
      outputs: {
        review: { kind: 'review', mdPath: join(dir, 'x-review-cycle1.md'), jsonPath: join(dir, 'x-review-cycle1.json') },
        tasks: { kind: 'artifact', path: join(dir, 'tasks-report.json'), channel: 'tasks' },
      },
    }));
    assert.ok(res.review !== undefined);
  } finally { cap.restore(); }
  assert.ok(cap.lines.some((l) => l.includes('[contracts] tasks: output file missing')));
});

test('producer(tasks): unparseable tasks-report.json throws through the hook', async () => {
  const dir = await makeTmpDir();
  const tasksPath = join(dir, 'tasks-report.json');
  const node = { nodeId: 'x1', key: 'anything', runnerType: 'producer', loopSource: false, agentPrompt: 'x' };
  // primary output is a decoy md so the mock does not overwrite the fixture
  await writeFile(tasksPath, '{not json', 'utf8');
  await assert.rejects(
    runGenericProducer(ctxFor(dir, node, {
      outputs: {
        out: { kind: 'artifact', path: join(dir, 'out.md') },
        tasks: { kind: 'artifact', path: tasksPath, channel: 'tasks' },
      },
    })),
    /\[contracts\] tasks: unparseable JSON/,
  );
});
```

Note: the mock claude writes the FIRST output that has a `.path` (`runGenericProducer`'s `primary`), so in the unparseable test a decoy `out` handle is listed first to keep the fixture intact. If the mock also happens to rewrite `tasks-report.json`, adjust by asserting the reject only — check actual behavior at run time.

- [ ] **Step 2: Run to verify failure**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/onboarding-contracts-hook.test.mjs`
Expected: FAIL — no `[contracts] tools:` warnings (channel not registered).

- [ ] **Step 3: Implement** — in `src/core/phases.mjs`, extend the contracts import (find the existing `normalizeReadiness, normalizeGraphSummary` import near the top) to:

```js
import { normalizeReadiness, normalizeGraphSummary, normalizeToolsReport, normalizeTasksReport } from './onboarding-contracts.mjs';
```

and replace the `CONTRACT_VALIDATORS` literal:

```js
// channel id -> { pathOf(outputs), normalize } for validateContractOutputs.
const CONTRACT_VALIDATORS = {
  readiness: { pathOf: (outputs) => outputs.readiness?.jsonPath, normalize: normalizeReadiness },
  graph: { pathOf: (outputs) => outputs.graph?.path, normalize: normalizeGraphSummary },
  tools: { pathOf: (outputs) => outputs.tools?.path, normalize: normalizeToolsReport },
  tasks: { pathOf: (outputs) => outputs.tasks?.path, normalize: normalizeTasksReport },
};
```

Update the `validateContractOutputs` doc comment's channel list to "(readiness, graph, tools, tasks)".

- [ ] **Step 4: Run tests to verify pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/phases.mjs test/onboarding-contracts-hook.test.mjs
git commit -m "feat(contracts): hook validates tools + tasks channels"
```

---

### Task 6: Executor agent + workflow topology + clarify Q6/Q7

**Files:**
- Create: `agents/onboardingExecutor.meta.json`, `agents/maestro-onboarding-executor.md`
- Modify: `src/core/onboarding.mjs:16-33` (ENABLE_WORKFLOW, ENABLE_QUESTION_IDS), `agents/maestro-enable-clarifier.md`, `agents/enableClarifier.meta.json` (description), `agents/projectOnboarding.meta.json` (produces + channelDefs), `agents/maestro-project-onboarding.md` (tools output + optionalTools), `agents/onboardingEvaluator.meta.json` (connectsTo)
- Test: `test/workflow-onboarding-topology.test.mjs`

**Interfaces:**
- Consumes: channel machinery as-is; `hasBlocking` feedback gate as-is.
- Produces: workflow node `s_execute` (key `onboardingExecutor`, runnerType `verifier`, loopSource true) between `s_eval` and `s_canary`; feedback `fb_exec: s_execute → s_eval`; clarify ids `optionalTools` (comma-list string, first option `none`) and `executeTasks` (`up-to-3` | `up-to-1` | `none`); infra now produces channel `tools` (file `tools.json`); executor produces channels `review` + `tasks` (file `tasks-report.json`).

- [ ] **Step 1: Write the failing tests** — append to `test/workflow-onboarding-topology.test.mjs` (add `import { ENABLE_WORKFLOW, ENABLE_QUESTION_IDS } from '../src/core/onboarding.mjs';`):

```js
test('ENABLE_WORKFLOW validates against the registry (no errors)', () => {
  const reg = loadAgentRegistry(undefined, { userAgentsDir: null });
  const { ok, errors } = validateWorkflow(ENABLE_WORKFLOW, reg);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test('ENABLE_WORKFLOW: s_execute sits between s_eval and s_canary with a legal fb_exec back-edge', () => {
  const idx = (id) => ENABLE_WORKFLOW.steps.findIndex((g) => g.some((n) => n.id === id));
  assert.ok(idx('s_eval') < idx('s_execute'), 'execute after eval');
  assert.ok(idx('s_execute') < idx('s_canary'), 'execute before canary');
  const fb = ENABLE_WORKFLOW.feedbacks.find((f) => f.id === 'fb_exec');
  assert.equal(fb.from, 's_execute');
  assert.equal(fb.to, 's_eval');
  assert.ok(idx(fb.to) < idx(fb.from), 'target step must precede source step');
});

test('ENABLE_QUESTION_IDS carries the two new clarify ids', () => {
  assert.ok(ENABLE_QUESTION_IDS.includes('optionalTools'));
  assert.ok(ENABLE_QUESTION_IDS.includes('executeTasks'));
});

test('onboardingExecutor registry meta: verifier, loopSource, tasks channelDef', () => {
  const reg = loadAgentRegistry(undefined, { userAgentsDir: null });
  const m = reg.onboardingExecutor;
  assert.ok(m, 'onboardingExecutor is registered');
  assert.equal(m.runnerType, 'verifier');
  assert.equal(m.loopSource, true);
  assert.ok(m.produces.includes('tasks'));
  assert.ok(m.consumes.includes('readiness'));
});

test('projectOnboarding registry meta: produces the tools channel with a json channelDef', () => {
  const reg = loadAgentRegistry(undefined, { userAgentsDir: null });
  const m = reg.projectOnboarding;
  assert.ok(m.produces.includes('tools'));
  const def = (m.channelDefs || []).find((d) => d.id === 'tools');
  assert.ok(def, 'tools channelDef declared');
  assert.equal(def.kind, 'json');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/workflow-onboarding-topology.test.mjs`
Expected: FAIL — no s_execute node / no onboardingExecutor meta.

- [ ] **Step 3: Create `agents/onboardingExecutor.meta.json`:**

```json
{
  "key": "onboardingExecutor", "domain": "coding",
  "displayName": "Onboarding Execute", "description": "opt-in: knock out the evaluator's top gap tasks on the enable branch, then hand back for an honest re-score",
  "color": "violet", "icon": "<path d=\"M4 7h9M4 12h6M4 17h9\" stroke-linecap=\"round\"/><path d=\"M14.5 16.5l2 2 4-4.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  "agentFile": "maestro-onboarding-executor.md",
  "runnerType": "verifier", "loopSource": true, "fanOut": true,
  "consumes": ["readiness", "clarify", "code"], "optionalConsumes": ["graph"],
  "produces": ["review", "tasks"],
  "channelDefs": [{ "id": "tasks", "kind": "json", "filename": "tasks-report.json" }],
  "connectsTo": ["onboardingCanary"], "order": 8.45,
  "tools": "Read, Write, Edit, Bash, Grep, Glob, Skill"
}
```

- [ ] **Step 4: Create `agents/maestro-onboarding-executor.md`:**

```markdown
---
name: maestro-onboarding-executor
description: Opt-in gap executor for the AI-enablement onboarding pipeline. Reads the evaluator's readiness gaps, executes up to the clarify-capped number of them on the enable branch, and emits a tasks report + a review verdict that triggers exactly one honest re-score. Consumes readiness, clarify, code (optional graph); produces review, tasks.
tools: Read, Write, Edit, Bash, Grep, Glob, Skill
model: inherit
---

# Onboarding Executor Agent

## Role

You are the **Executor** for the AI-Enablement Onboarding pipeline — the opt-in step that turns the evaluator's "Still worth doing" gaps into done work. You execute up to N gap tasks directly on the enable branch (the real working tree — the pipeline commits your changes), report exactly what happened, and hand back to the evaluator for one honest re-score.

## Inputs

- **readiness** (required): the evaluator's report card. The `gaps` array in its json sibling (`readiness.json`, next to the md path you were given) is your task list, in priority order.
- **clarify** (required): the set-up answers. `answers.executeTasks` is your budget toggle; `answers.scopeConstraints` is binding.
- **code** (required): the working tree with the generated setup — inspect with `git status` / `git diff`.
- **graph** (optional): the analyzer's summary, for grounding where things live.

## Method

1. **Honor the toggle FIRST.** Read `answers.executeTasks`. Map it to a budget: `up-to-3` → 3, `up-to-1` → 1, `none` → 0; free text: parse the first integer, defaulting to 3. If the budget is 0, or `readiness.json` has no gaps, write a no-op tasks report (`attempted: []`) and a ZERO-issue review, and EXIT. maestro always runs the seeded execute step; this self-no-op is the only skip mechanism.
2. **Cycle guard — run real work ONCE.** If a prior-cycle report exists (`tasks-report.json` in the pipeline dir — your own output path carries a `-cycleN` suffix on re-runs), you are on the post-re-score pass: copy the previous report's `attempted` entries verbatim into your new report (carry-forward, so the results screen keeps the full account), add nothing new, and emit a ZERO-issue review so the loop terminates. Do NOT execute more tasks.
3. **Execute up to budget gaps, in the order the evaluator listed them.** For each gap: implement it for real — code plus a test where the gap is testable — honoring `scopeConstraints` exactly. Prefer small and finished over big and half-done: if a gap turns out to need a human decision, is out of scope, or would exceed a sane effort for one task, record it `skipped` with the reason and move on. A gap you started but could not land safely: revert your partial edits and record it `failed` with what blocked you. Run the project's test suite after each task; never leave the tree red.
4. **Write the tasks report** to the `tasks` output path, exact shape:

   ```json
   {
     "attempted": [
       { "gap": "<the gap text, verbatim from readiness.json>", "status": "completed|skipped|failed", "notes": "<one line: what you did / why not>" }
     ],
     "completed": 0, "skipped": 0, "failed": 0
   }
   ```

   Counts must equal the tally of `attempted` statuses (the pipeline recomputes and warns on mismatch).
5. **Write the review verdict** (md + json, standard protocol shape `{ "issues": [{ "severity", "title", "detail", "location" }], "summary" }`):
   - If `completed > 0` on THIS pass: emit EXACTLY ONE `major` issue — title `Re-score required`, detail `"<N> gap task(s) were executed; the readiness card is stale until the evaluator re-scores."`, location `tasks-report.json`. This single issue is the loop trigger: the pipeline rewinds to the evaluator for one honest re-score, then returns here (your cycle guard ends the loop).
   - Otherwise (no-op, all skipped/failed): ZERO blocking issues. Surface anything noteworthy as `minor`/`suggestion`.

## Workspace runs (fan-out)

As a fan-out instance you execute only your assigned member project's gaps, against that member's readiness card, and report only your member's tasks.

## Output Contract

Your final message states the budget, each gap attempted with its outcome, whether a re-score was requested, and confirmation the test suite is green (or was never touched, for a no-op).
```

- [ ] **Step 5: Modify `src/core/onboarding.mjs`** — replace the `steps`/`feedbacks`/`ENABLE_QUESTION_IDS` blocks:

```js
  steps: [
    [{ id: 's_clarify', key: 'enableClarifier' }],   // NEW deterministic clarifier
    [{ id: 's_analyze', key: 'onboardingAnalyzer' }], // reused
    [{ id: 's_infra',   key: 'projectOnboarding' }],  // reused
    [{ id: 's_tests',   key: 'onboardingTests' }],    // reused
    [{ id: 's_eval',    key: 'onboardingEvaluator' }],// reused
    [{ id: 's_execute', key: 'onboardingExecutor' }], // opt-in gap executor (self-no-ops off toggle)
    [{ id: 's_canary',  key: 'onboardingCanary' }],   // reused
  ],
  feedbacks: [
    { id: 'fb_eval', from: 's_eval', to: 's_infra' },   // resolveWorkflow adds gate:'hasBlocking'
    // fb_exec: the executor's single "Re-score required" major issue rewinds to the
    // evaluator for one honest re-score; the executor's cycle guard then emits a
    // clean review so the loop terminates on the second pass.
    { id: 'fb_exec', from: 's_execute', to: 's_eval' },
  ],
```

```js
export const ENABLE_QUESTION_IDS = Object.freeze([
  'testTier', 'vendoringDepth', 'multiToolTargets', 'canary', 'scopeConstraints',
  'optionalTools', 'executeTasks',
]);
```

- [ ] **Step 6: Modify `agents/maestro-enable-clarifier.md`** — change "EXACTLY these 5 questions" to "EXACTLY these 7 questions" (both in the prose and keep ids stable) and extend the Output Contract JSON's `questions` array with, after `scopeConstraints`:

```json
    { "id": "optionalTools", "question": "Add optional AI skills to the repo?", "options": ["none", "writing-plans, executing-plans, requesting-code-review", "writing-plans", "executing-plans", "requesting-code-review"], "allowFreeText": true },
    { "id": "executeTasks", "question": "Fix the top remaining gaps at the end of the run?", "options": ["up-to-3", "up-to-1", "none"], "allowFreeText": true }
```

Add one prose paragraph: `optionalTools` is a comma-separated list of curated optional skill names (the UI joins its checkboxes into one string; `none` means none); `executeTasks` caps the executor step (`up-to-3` / `up-to-1` / `none`). Update `agents/enableClarifier.meta.json`'s `description` to "…the 7 fixed Enable set-up questions…".

- [ ] **Step 7: Modify `agents/projectOnboarding.meta.json`** — change `"produces": ["code"]` to:

```json
  "produces": ["code", "tools"],
  "channelDefs": [{ "id": "tools", "kind": "json", "filename": "tools.json" }],
```

- [ ] **Step 8: Modify `agents/maestro-project-onboarding.md`:**
  - Inputs section, clarify line: extend the answer list to `(testTier, vendoringDepth, multiToolTargets, canary, scopeConstraints, optionalTools, executeTasks)`.
  - Vendored-skills bullet (Phase 4): after the `resolveVendorTargets(refs)` sentence, add: "Additionally vendor every name in `clarify.answers.optionalTools` (a comma-separated list; `none` means none) — these are user-picked entries from the curated OPTIONAL_CATALOG and are allowlisted by construction; still verify each against the allowlist before copying. Skill sources now include the plugin cache (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/`) — `caveman` in the baseline typically resolves there."
  - Outputs section: add a second bullet:

```markdown
- **tools**: a machine-readable tool report written to the `tools` output path (json). Exact shape:

  ```json
  {
    "installed": [{ "name": "graphify", "source": "bundle|global|project|plugin", "mandatory": true }],
    "skipped":   [{ "name": "<ref>", "reason": "not on allowlist" }],
    "suggested": [{ "name": "<catalog-or-candidate name>", "reason": "<one line why>", "source": "catalog|analyzer" }]
  }
  ```

  `installed` lists every skill you actually vendored (mandatory = curated-baseline member). `skipped` mirrors the report's *not vendored* refs. `suggested` = every OPTIONAL_CATALOG name you did NOT install (source `catalog`, one-line generic reason) PLUS any `graph.skillCandidates` name that is on the curated allowlist but was not installed (source `analyzer`, reason from the candidate's `whySkill`). Never suggest a name outside the curated allowlist.
```

  - Output Contract table: add a row `| <pipeline dir>/tools.json | created | machine-readable installed/suggested tool report |`.

- [ ] **Step 9: Modify `agents/onboardingEvaluator.meta.json`** — `"connectsTo": ["onboardingExecutor", "onboardingCanary"]`.

- [ ] **Step 10: Run tests to verify pass**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/workflow-onboarding-topology.test.mjs test/agent-registry*.test.mjs`
Expected: PASS (registry palette/parity tests may enumerate agents — if one asserts a fixed agent count or color set, extend its fixture to include `onboardingExecutor`).

- [ ] **Step 11: Commit**

```bash
git add agents/onboardingExecutor.meta.json agents/maestro-onboarding-executor.md agents/maestro-enable-clarifier.md agents/enableClarifier.meta.json agents/projectOnboarding.meta.json agents/maestro-project-onboarding.md agents/onboardingEvaluator.meta.json src/core/onboarding.mjs test/workflow-onboarding-topology.test.mjs
git commit -m "feat(onboarding): executor step + fb_exec re-score loop + clarify Q6/Q7 + tools channel"
```

---

### Task 7: Readers + final-event payload (`tools`, `tasks`)

**Files:**
- Modify: `src/core/onboarding.mjs` (readers + final emit)
- Test: `test/onboarding-tools-readers.test.mjs` (create)

**Interfaces:**
- Produces: `readToolsReport(pipelineDir) -> object|null`, `readTasksReport(pipelineDir) -> object|null` (latest-cycle-wins over `tools.json`/`tools-cycleN.json` and `tasks-report.json`/`tasks-report-cycleN.json`); the `kind:'final'` readiness event gains `tools` and `tasks` fields (null when absent). Consumed by the server (Task 8) and UI (Task 10).

- [ ] **Step 1: Write the failing tests** — create `test/onboarding-tools-readers.test.mjs`:

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readToolsReport, readTasksReport } from '../src/core/onboarding.mjs';

const dirs = [];
const tmp = async () => { const d = await mkdtemp(join(tmpdir(), 'enable-readers-')); dirs.push(d); return d; };
after(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

test('readToolsReport: absent file -> null (old runs render unchanged)', async () => {
  assert.equal(readToolsReport(await tmp()), null);
});

test('readToolsReport: base file read; later cycle file wins', async () => {
  const dir = await tmp();
  await writeFile(join(dir, 'tools.json'), JSON.stringify({ installed: [{ name: 'graphify' }] }));
  assert.equal(readToolsReport(dir).installed[0].name, 'graphify');
  await writeFile(join(dir, 'tools-cycle2.json'), JSON.stringify({ installed: [{ name: 'caveman' }] }));
  assert.equal(readToolsReport(dir).installed[0].name, 'caveman');
});

test('readTasksReport: absent -> null; latest cycle wins', async () => {
  const dir = await tmp();
  assert.equal(readTasksReport(dir), null);
  await writeFile(join(dir, 'tasks-report.json'), JSON.stringify({ attempted: [], completed: 0 }));
  await writeFile(join(dir, 'tasks-report-cycle2.json'), JSON.stringify({ attempted: [{ gap: 'x', status: 'completed' }], completed: 1 }));
  assert.equal(readTasksReport(dir).completed, 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/onboarding-tools-readers.test.mjs`
Expected: FAIL — readers not exported.

- [ ] **Step 3: Implement** — in `src/core/onboarding.mjs`, after `readFinalReadiness` add:

```js
// tools.json / tasks-report.json are custom pipeline-dir channels; a loop rewind
// writes a -cycleN suffixed sibling (channels.mjs default branch), so "latest
// cycle wins" here. null when the run predates the channel (old runs).
function readLatestCycleJson(pipelineDir, stem) {
  let latest = readJsonSafe(join(pipelineDir, `${stem}.json`));
  for (let c = 2; ; c++) {
    const next = readJsonSafe(join(pipelineDir, `${stem}-cycle${c}.json`));
    if (!next) break;
    latest = next;
  }
  return latest;
}

export function readToolsReport(pipelineDir) {
  return readLatestCycleJson(pipelineDir, 'tools');
}

export function readTasksReport(pipelineDir) {
  return readLatestCycleJson(pipelineDir, 'tasks-report');
}
```

and extend the `kind:'final'` emit inside `wireOnboardingRun` (the `events.emit('readiness', {...})` block) with two fields after `gaps`:

```js
        tools: dir ? readToolsReport(dir) : null,       // installed/suggested tools (null on old runs)
        tasks: dir ? readTasksReport(dir) : null,       // executor's gap-task report (null when skipped)
```

- [ ] **Step 4: Run tests to verify pass** — same command, plus `test/enable-pause-resume.test.mjs` (exercises the final emit path). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/onboarding.mjs test/onboarding-tools-readers.test.mjs
git commit -m "feat(onboarding): tools/tasks readers + final readiness event payload"
```

---

### Task 8: Server — `POST /api/enable/vendor` + history detail payload

**Files:**
- Modify: `apps/enable/server.mjs` (imports, new route after the `/todo` route at :463-490, history detail route at :404-410)
- Test: `test/enable-vendor.test.mjs` (create)

**Interfaces:**
- Consumes: `CURATED_ALLOWLIST` (Task 1), `resolveSkill` (Task 2), `readToolsReport`/`readTasksReport` (Task 7).
- Produces: `POST /api/enable/vendor` body `{ dir, name }` → `{ ok, name, source, already }` | 400 (not allowlisted / bad dir) | 404 (unresolvable); `GET /api/enable/history/:id` response gains `tools` and `tasks` fields. New env override `ENABLE_SKILLS_HOME` (tests only) for the skill-resolution home dir.

- [ ] **Step 1: Write the failing tests** — create `test/enable-vendor.test.mjs` (pattern: `test/enable-server.mjs`):

```js
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after);

// deterministic skill-resolution home for the vendor endpoint (read at import time)
const skillsHome = mkdtempSync(join(tmpdir(), 'enable-vendor-home-'));
process.env.ENABLE_SKILLS_HOME = skillsHome;

let app, server, base, cookie;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts = {}) =>
  realFetch(url, { ...opts, headers: { ...(opts.headers || {}), cookie } });

before(async () => {
  ({ app, server } = await import('../apps/enable/server.mjs'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${server.address().port}`;
  const res = await realFetch(`http://${base}/`);
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
});
after(async () => { if (server) await new Promise((r) => server.close(r)); });

function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'enable-vendor-'));
  execSync('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: dir });
  return dir;
}

async function post(path, body) {
  const res = await fetch(`http://${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('vendor: a name off the curated allowlist is rejected 400 (never copied)', async () => {
  const { status, json } = await post('/api/enable/vendor', { dir: freshRepo(), name: 'my-private-thing' });
  assert.equal(status, 400);
  assert.match(json.error, /allowlist/);
});

test('vendor: happy path copies a global-resolved skill and appends VENDORED.md', async () => {
  const skillDir = join(skillsHome, '.claude', 'skills', 'writing-plans');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# writing-plans\n');
  const dir = freshRepo();
  const { status, json } = await post('/api/enable/vendor', { dir, name: 'writing-plans' });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.already, false);
  assert.ok(existsSync(join(dir, '.claude', 'skills', 'writing-plans', 'SKILL.md')));
  assert.match(readFileSync(join(dir, '.claude', 'skills', 'VENDORED.md'), 'utf8'), /writing-plans/);
  // idempotent re-vendor
  const again = await post('/api/enable/vendor', { dir, name: 'writing-plans' });
  assert.equal(again.json.already, true);
});

test('vendor: allowlisted but unresolvable on this machine -> 404', async () => {
  const { status } = await post('/api/enable/vendor', { dir: freshRepo(), name: 'requesting-code-review' });
  assert.equal(status, 404);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/enable-vendor.test.mjs`
Expected: FAIL — 404 route (Express falls through to static → non-JSON).

- [ ] **Step 3: Implement** — in `apps/enable/server.mjs`:

Imports: extend the onboarding import to `{ runOnboarding, resumeOnboarding, readFinalReadiness, readToolsReport, readTasksReport, ENABLE_TITLE }`; add `cpSync` to the `node:fs` import; add:

```js
import { CURATED_ALLOWLIST } from '../../src/core/skill-vendor.mjs';
import { resolveSkill } from '../../src/core/skills.mjs';
```

Constants (near `PROJECTS_ROOT`):

```js
const REPO_ROOT = path.join(__dirname, '../..');
// tests point this at a throwaway home so skill resolution is deterministic
const SKILLS_HOME = process.env.ENABLE_SKILLS_HOME || os.homedir();
```

New route directly after the `/api/enable/todo` route:

```js
// vendor one suggested skill into the project's .claude/skills/ (results-screen
// "Add" button). SECURITY: curated-allowlist MEMBERSHIP is the gate — an arbitrary
// name is rejected before any disk probe, so this can never copy a personal skill.
// Writes to the project's CURRENT working tree (a user-initiated post-run action),
// not the enable branch.
app.post('/api/enable/vendor', (req, res) => {
  const { dir: rawDir, name } = req.body || {};
  if (typeof name !== 'string' || !CURATED_ALLOWLIST.includes(name)) {
    return res.status(400).json({ error: 'skill is not on the curated allowlist' });
  }
  if (typeof rawDir !== 'string' || !rawDir) return res.status(400).json({ error: 'dir required' });
  const dir = path.isAbsolute(rawDir) ? rawDir : resolveProjectDir(rawDir);
  if (!dir) return res.status(400).json({ error: `unknown project: ${rawDir}` });
  try { if (!statSync(dir).isDirectory()) throw new Error('not a directory'); }
  catch { return res.status(400).json({ error: `not a directory: ${dir}` }); }

  const target = path.join(dir, '.claude', 'skills', name);
  if (existsSync(path.join(target, 'SKILL.md'))) return res.json({ ok: true, name, already: true });
  const r = resolveSkill(name, { repoRoot: REPO_ROOT, projectDir: dir, homeDir: SKILLS_HOME });
  if (!r.source) return res.status(404).json({ error: `skill "${name}" was not found on this machine` });
  try {
    cpSync(r.path, target, { recursive: true });
    const manifest = path.join(dir, '.claude', 'skills', 'VENDORED.md');
    let head = '# Vendored skills\n';
    try { head = readFileSync(manifest, 'utf8'); } catch {}
    const line = `- ${name} — vendored from ${r.source} via the Enable results screen (${new Date().toISOString().slice(0, 10)})\n`;
    writeFileSync(manifest, `${head.replace(/\n*$/, '\n')}${line}`);
  } catch (err) { return res.status(500).json({ error: String(err && err.message || err) }); }
  res.json({ ok: true, name, source: r.source, already: false });
});
```

History detail route — replace the `res.json` line in `GET /api/enable/history/:id` with:

```js
    res.json({
      entry, readiness: entry.readiness, changes: readChanges(entry.dir),
      tools: readToolsReport(entry.dir), tasks: readTasksReport(entry.dir),
    });
```

- [ ] **Step 4: Run tests to verify pass**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/enable-vendor.test.mjs test/enable-server.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/enable/server.mjs test/enable-vendor.test.mjs
git commit -m "feat(enable): POST /api/enable/vendor + tools/tasks in history detail"
```

---

### Task 9: UI — setup form Q6/Q7 + execute stage in the journey

**Files:**
- Modify: `apps/enable/public/app.js:7-29` (STAGES + SETUP_QUESTIONS), `apps/enable/public/app.js:273-289` (collectAnswers), `apps/enable/public/index.html:98-107` (fieldsets)
- Test: `test/enable-setup-tools.test.mjs` (create)

**Interfaces:**
- Consumes: clarify ids from Task 6 (values must match the clarifier's `options` strings exactly: `optionalTools` joined comma list / `'none'`; `executeTasks` ∈ `up-to-3|up-to-1|none`).
- Produces: `POST /api/enable/run` body `answers.optionalTools` (string) and `answers.executeTasks` (string); journey stage node `s_execute`.

- [ ] **Step 1: Write the failing test** — create `test/enable-setup-tools.test.mjs` using the boot pattern from `test/enable-graph-ui.test.mjs` (copy its `FakeWS`, `boot`, `tick`, and project-selection helpers verbatim; capture `POST /api/enable/run` bodies in the fetch stub and return `{ ok: true, json: async () => ({ runId: 'r1' }) }`):

```js
test('setup form: optionalTools + executeTasks fieldsets render with safe defaults', async () => {
  const document = await boot();
  assert.ok(document.querySelector('.opts[data-q="optionalTools"] input[value="writing-plans"]'));
  // no optional tool pre-checked
  assert.equal(document.querySelectorAll('input[name="optionalTools"]:checked').length, 0);
  // executeTasks defaults to up-to-3 (first option checked)
  assert.equal(document.querySelector('input[name="executeTasks"]:checked')?.value, 'up-to-3');
});

test('submitting the form sends joined optionalTools and the executeTasks choice', async () => {
  const document = await boot();
  await selectProject(document);
  document.querySelector('#go-setup').click();
  await tick();
  document.querySelector('input[name="optionalTools"][value="writing-plans"]').checked = true;
  document.querySelector('input[name="optionalTools"][value="executing-plans"]').checked = true;
  document.querySelector('input[name="executeTasks"][value="none"]').checked = true;
  document.querySelector('#setup-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  const body = JSON.parse(runPosts.at(-1));            // captured by the fetch stub
  assert.equal(body.answers.optionalTools, 'writing-plans, executing-plans');
  assert.equal(body.answers.executeTasks, 'none');
});

test('the journey renders the s_execute stage between review and test-drive', async () => {
  const document = await boot();
  await selectProject(document);
  document.querySelector('#go-setup').click();
  await tick();
  document.querySelector('#setup-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  const nodes = [...document.querySelectorAll('#journey .stage')].map((s) => s.dataset.node);
  assert.deepEqual(nodes.slice(-3), ['s_eval', 's_execute', 's_canary']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/enable-setup-tools.test.mjs`
Expected: FAIL — no `optionalTools` inputs, journey has 6 stages.

- [ ] **Step 3: Implement**

`apps/enable/public/app.js` — STAGES (insert before s_canary):

```js
  { node: 's_execute', label: 'Fix gaps',   color: '#a78bfa' },
```

SETUP_QUESTIONS — update the header comment to "The 7 fixed set-up questions" and add after `canary`:

```js
  optionalTools: { type: 'multi', options: [
    { value: 'writing-plans', label: 'Writing plans' },
    { value: 'executing-plans', label: 'Executing plans' },
    { value: 'requesting-code-review', label: 'Requesting code review' }],
    defaults: [] },
  executeTasks: { type: 'single', options: [
    { value: 'up-to-3', label: 'Yes — up to 3 tasks (recommended)' },
    { value: 'up-to-1', label: 'Yes — 1 task' },
    { value: 'none', label: 'No' }] },
```

`collectAnswers()` — add before `return a;`:

```js
  // optionalTools rides the clarify answer as ONE comma-joined string ('none' = none)
  const opt = [...document.querySelectorAll('input[name="optionalTools"]:checked')].map((el) => el.value);
  a.optionalTools = opt.length ? opt.join(', ') : 'none';
  a.executeTasks = document.querySelector('input[name="executeTasks"]:checked')?.value;
```

`apps/enable/public/index.html` — insert after the `canary` fieldset (line 101) and before `scopeConstraints`:

```html
          <fieldset class="q">
            <legend>Add optional AI skills? <span class="opt-note">(optional)</span></legend>
            <div class="opts multi" data-q="optionalTools"></div>
          </fieldset>
          <fieldset class="q">
            <legend>Fix the top remaining gaps at the end?</legend>
            <div class="opts" data-q="executeTasks"></div>
          </fieldset>
```

- [ ] **Step 4: Run tests to verify pass** — the new file plus every existing enable UI suite (they boot the same form):

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/enable-setup-tools.test.mjs test/enable-graph-ui.test.mjs test/enable-interactive.test.mjs test/enable-a11y.test.mjs test/enable-pause-ui.test.mjs`
Expected: PASS. If a suite asserts the journey stage count (6) or enumerates SETUP_QUESTIONS, update its expectation to include the new stage/questions — that is the intended behavior change, not a regression.

- [ ] **Step 5: Commit**

```bash
git add apps/enable/public/app.js apps/enable/public/index.html test/enable-setup-tools.test.mjs
git commit -m "feat(enable-ui): optionalTools + executeTasks setup questions, execute journey stage"
```

---

### Task 10: UI — results screen: installed tools, suggested tools, executed-tasks note

**Files:**
- Modify: `apps/enable/public/index.html:191-199` (results-side), `apps/enable/public/app.js` (renderResults at :715, new renderTools/renderTasksNote/vendorSkill, showHistoryDetail at :1167, init wiring), `apps/enable/public/styles.css` (three small classes)
- Test: `test/enable-tools-ui.test.mjs` (create)

**Interfaces:**
- Consumes: final readiness event fields `tools` / `tasks` (Task 7); history detail fields `tools` / `tasks` (Task 8); `POST /api/enable/vendor` (Task 8).
- Produces: results-side sections `#tools-wrap` (installed list with mandatory badges), `#suggested-wrap` (rows with Add buttons), `#tasks-note` line in the gaps header area.

- [ ] **Step 1: Write the failing tests** — create `test/enable-tools-ui.test.mjs` (boot pattern as in Task 9; drive frames via `window.__enableTest`):

```js
const TOOLS = {
  installed: [{ name: 'graphify', source: 'global', mandatory: true },
              { name: 'caveman', source: 'plugin', mandatory: true },
              { name: 'writing-plans', source: 'global', mandatory: false }],
  skipped: [],
  suggested: [{ name: 'executing-plans', reason: 'pairs with writing-plans', source: 'catalog' }],
};
const TASKS = { attempted: [{ gap: 'Add smoke test', status: 'completed', notes: '' }], completed: 1, skipped: 0, failed: 0 };

function finalFrame(extra = {}) {
  return { type: 'readiness', kind: 'final', score: 90, baselineScore: 40, delta: 50,
    dimensions: {}, gaps: ['Document release flow'], branch: 'maestro/enable-x', ...extra };
}

test('results: installed tools render with mandatory badges; suggested rows carry Add buttons', async () => {
  const document = await boot();
  window.__enableTest.setRun('r1', 'p1');
  window.__enableTest.handle(finalFrame({ tools: TOOLS, tasks: TASKS }));
  await tick();
  assert.equal(document.querySelector('#tools-wrap').hidden, false);
  const installed = [...document.querySelectorAll('#tools-installed .tool-row')];
  assert.equal(installed.length, 3);
  assert.equal(installed.filter((li) => li.querySelector('.tool-badge')).length, 2);
  const btn = document.querySelector('#tools-suggested .vendor-btn');
  assert.equal(btn.dataset.name, 'executing-plans');
  assert.equal(document.querySelector('#tasks-note').hidden, false);
  assert.match(document.querySelector('#tasks-note').textContent, /1 task/);
});

test('results: an old run (no tools/tasks) hides the new sections entirely', async () => {
  const document = await boot();
  window.__enableTest.setRun('r1', 'p1');
  window.__enableTest.handle(finalFrame());
  await tick();
  assert.equal(document.querySelector('#tools-wrap').hidden, true);
  assert.equal(document.querySelector('#tasks-note').hidden, true);
});

test('clicking Add POSTs /api/enable/vendor and flips the button', async () => {
  const document = await boot();          // fetch stub: /api/enable/vendor -> { ok:true, already:false }
  window.__enableTest.setRun('r1', 'p1');
  // lastProjectDir must be set: boot -> selectProject -> submit run first (as in Task 9's submit test)
  window.__enableTest.handle(finalFrame({ tools: TOOLS, tasks: null }));
  await tick();
  const btn = document.querySelector('#tools-suggested .vendor-btn');
  btn.click();
  await tick(); await tick();
  assert.ok(vendorPosts.length === 1);                       // captured by the fetch stub
  assert.equal(JSON.parse(vendorPosts[0]).name, 'executing-plans');
  assert.match(btn.textContent, /Added/);
});
```

(The fetch stub captures vendor POST bodies into `vendorPosts` the same way Task 9 captures run bodies.)

- [ ] **Step 2: Run to verify failure** — expected: FAIL, `#tools-wrap` missing.

- [ ] **Step 3: Implement**

`apps/enable/public/index.html` — inside `.results-side`, after the `gaps-wrap` div (line 199) add:

```html
            <div class="tools-wrap" id="tools-wrap" hidden>
              <h3>Tools installed</h3>
              <ul id="tools-installed" class="tools-list"></ul>
              <div id="suggested-wrap" hidden>
                <h3>Suggested tools</h3>
                <ul id="tools-suggested" class="tools-list"></ul>
                <p id="vendor-error" class="error-line" hidden></p>
              </div>
            </div>
```

and inside `#gaps-wrap`, directly after the `.gaps-head` div, add:

```html
              <p id="tasks-note" class="hint-line" hidden></p>
```

`apps/enable/public/app.js` — new functions after `createTodoTasks`:

```js
// ---------- installed / suggested tools ----------
function renderTools(tools) {
  const wrap = document.querySelector('#tools-wrap');
  const installed = Array.isArray(tools?.installed) ? tools.installed : [];
  const suggested = Array.isArray(tools?.suggested) ? tools.suggested : [];
  wrap.hidden = installed.length === 0 && suggested.length === 0;
  document.querySelector('#tools-installed').innerHTML = installed.map((t) =>
    `<li class="tool-row"><code>${esc(t.name)}</code>${t.mandatory ? ' <span class="tool-badge">mandatory</span>' : ''}</li>`).join('');
  const sWrap = document.querySelector('#suggested-wrap');
  sWrap.hidden = suggested.length === 0;
  document.querySelector('#vendor-error').hidden = true;
  document.querySelector('#tools-suggested').innerHTML = suggested.map((t) =>
    `<li class="tool-row"><code>${esc(t.name)}</code>` +
    `${t.reason ? ` <span class="tool-reason">${esc(t.reason)}</span>` : ''}` +
    `<button type="button" class="ghost-btn small vendor-btn" data-name="${esc(t.name)}"${lastProjectDir ? '' : ' disabled'}>Add</button></li>`).join('');
}

function renderTasksNote(tasks) {
  const el = document.querySelector('#tasks-note');
  const done = Number(tasks?.completed) || 0;
  el.hidden = done === 0;
  el.textContent = done ? `${done} task${done === 1 ? '' : 's'} already done during enablement.` : '';
}

async function vendorSkill(btn) {
  const errEl = document.querySelector('#vendor-error');
  errEl.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Adding…';
  try {
    const res = await fetch('/api/enable/vendor', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: lastProjectDir, name: btn.dataset.name }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    btn.textContent = body.already ? '✓ Already added' : '✓ Added';
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Add';
    errEl.textContent = `Could not add ${btn.dataset.name}: ${err.message}`;
    errEl.hidden = false;
  }
}
```

`renderResults(r)` — after the `resetTodoButton(...)` line add:

```js
  renderTools(r.tools || null);
  renderTasksNote(r.tasks || null);
```

`showHistoryDetail` — extend the `renderResults({...})` call to pass the new fields:

```js
  renderResults({ ...(d.readiness || {}), tools: d.tools ?? null, tasks: d.tasks ?? null, branch: e.branch ?? null, _stats });
```

`init()` — add near the `#todo-btn` wiring:

```js
  document.querySelector('#tools-suggested').addEventListener('click', (e) => {
    const btn = e.target.closest('.vendor-btn');
    if (btn && !btn.disabled) vendorSkill(btn);
  });
```

`apps/enable/public/styles.css` — append (match the file's existing custom-property palette; reuse `--muted`/`--accent` names found in the file):

```css
.tools-list { list-style: none; margin: 0; padding: 0; }
.tool-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.tool-row .tool-reason { color: var(--muted); font-size: 0.85em; flex: 1; }
.tool-badge { font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.04em;
  border: 1px solid var(--accent); color: var(--accent); border-radius: 999px; padding: 1px 7px; }
.tool-row .vendor-btn { margin-left: auto; }
```

- [ ] **Step 4: Run tests to verify pass**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/enable-tools-ui.test.mjs test/enable-graph-ui.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/enable/public/index.html apps/enable/public/app.js apps/enable/public/styles.css test/enable-tools-ui.test.mjs
git commit -m "feat(enable-ui): installed/suggested tools sections + executed-tasks note + one-click vendor"
```

---

### Task 11: Full-suite verification

**Files:**
- Modify: only whatever the suite flags (expectation updates in tests that enumerate stages/questions/agents).

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: PASS. Known likely touch-points if anything fails:
  - suites that enumerate `STAGES` (now 7) or the setup questions (now 6 rendered controls + 2 free-text),
  - registry palette/parity tests that enumerate agent metas (now include `onboardingExecutor`),
  - mock end-to-end enable runs (`enable-interactive`, `enable-pause-resume`): the mock executor emits a clean review (mock reviews carry no blocking issues), so `fb_exec` never fires and runs complete as before — if a test asserts the exact phase sequence, add `s_execute`.

- [ ] **Step 2: Fix any flagged expectations** — update the enumerating assertions only; never weaken a behavioral assertion.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test: expectation updates for the execute stage + new setup questions"
```

---

## Deliberately out of scope (matches spec)

- No changes to `ONBOARDING_WORKFLOW` in `src/core/builtin-workflows.mjs` (main-UI variant keeps 6 steps); the executor agent is registered and could be added there later.
- No `~/.claude` (user-global) installation.
- Cost estimator (`estimateCost`) does not model the execute step.
- Catalog management stays a code constant (`OPTIONAL_CATALOG`).
