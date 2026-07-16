# Stack-Specific Skills Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detected-stack skill suggestions (Spring Boot, Swift, DevOps, web) on the Enable results screen, backed by a vetted in-repo mirror of external skills, with vendored skills replicated into each AI tool's project dir (`.cursor/skills/`, `.agents/skills/`).

**Architecture:** Pinned + vetted mirror committed under `skills/` (allowlist membership stays the only gate; `resolveSkill()` already treats `<repoRoot>/skills/<name>` as source `bundle` — zero resolver changes). A pure `detectStacks()` sniffs manifests; the existing `validateContractOutputs` hook unions matches into `tools.suggested[]` with `source: 'stack-match'`. The shipped results-screen suggested-tools UI and `/api/enable/vendor` endpoint deliver them; the endpoint additionally fans copies out to destinations from a presence-based `vendorDestinations()`.

**Tech Stack:** Node ESM, `node:test`, existing Enable app (Express + vanilla JS UI). Zero orchestrator-engine changes.

**Spec:** `docs/superpowers/specs/2026-07-15-stack-skills-mirror-design.md`

## Global Constraints

- Trust model: **membership in `CURATED_ALLOWLIST` is the gate.** No runtime fetching of external repos; mirrored skills are committed files.
- `STACK_CATALOG` skills must be a subset of `CURATED_ALLOWLIST` and disjoint from `CURATED_BASELINE` and from `OPTIONAL_CATALOG` (all tested).
- Suggestion source value is exactly `stack-match`; suggestion union must never duplicate installed/already-suggested names, and agent suggestions win name collisions.
- Each DevOps artifact detects independently — a Dockerfile alone must NOT suggest kubernetes/terraform.
- `nextjs` implies react: when both detected from `package.json`, suggest `nextjs` only.
- Vendor destinations: always `.claude/skills`; `.cursor/rules/` or `.cursorrules` present → add `.cursor/skills`; `AGENTS.md` present → add `.agents/skills`; copilot footprint adds nothing. Destinations computed server-side (never client-supplied). The realpath `~/.claude` guard applies to EVERY destination.
- Every mirrored skill dir: `SKILL.md` + `ATTRIBUTION.md` (upstream URL, pinned SHA, date, modifications) + upstream `LICENSE` copy.
- Test command: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/<file>.mjs` from the repo root. Known quirk: some enable-* JSDOM files pass-then-hang on exit — rc=124 with all-pass output is a pass. Known quirk: grep can return no matches on `apps/enable/public/app.js` — use the Read tool there.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: STACK_CATALOG + allowlist extension + vendorDestinations

**Files:**
- Modify: `src/core/skill-vendor.mjs`
- Test: `test/skill-vendor.test.mjs`

**Interfaces:**
- Produces: `STACK_CATALOG: Readonly<Record<string, readonly string[]>>`, `STACK_SKILLS: readonly string[]` (flat unique union), `vendorDestinations(projectDir): string[]`. `CURATED_ALLOWLIST` grows to include `STACK_SKILLS`. Existing exports unchanged.

- [ ] **Step 1: Write the failing tests** — append to `test/skill-vendor.test.mjs`:

```js
// --- stack catalog (stack-skills mirror) ---
import { STACK_CATALOG, STACK_SKILLS, vendorDestinations } from '../src/core/skill-vendor.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('STACK_CATALOG: subset of allowlist, disjoint from baseline and optional catalog', () => {
  assert.ok(STACK_SKILLS.length >= 10);
  for (const name of STACK_SKILLS) {
    assert.ok(CURATED_ALLOWLIST.includes(name), `${name} must be allowlisted`);
    assert.ok(!CURATED_BASELINE.includes(name), `${name} must not be in the baseline`);
    assert.ok(!OPTIONAL_CATALOG.includes(name), `${name} must not be in the optional catalog`);
  }
  assert.equal(new Set(STACK_SKILLS).size, STACK_SKILLS.length, 'no duplicate names across stacks');
});

test('vendorDestinations: presence-based per-tool dirs, .claude always first', () => {
  const bare = mkdtempSync(join(tmpdir(), 'vd-'));
  assert.deepEqual(vendorDestinations(bare), ['.claude/skills']);

  const cursor = mkdtempSync(join(tmpdir(), 'vd-'));
  mkdirSync(join(cursor, '.cursor', 'rules'), { recursive: true });
  assert.deepEqual(vendorDestinations(cursor), ['.claude/skills', '.cursor/skills']);

  const cursorLegacy = mkdtempSync(join(tmpdir(), 'vd-'));
  writeFileSync(join(cursorLegacy, '.cursorrules'), 'rules');
  assert.deepEqual(vendorDestinations(cursorLegacy), ['.claude/skills', '.cursor/skills']);

  const agents = mkdtempSync(join(tmpdir(), 'vd-'));
  writeFileSync(join(agents, 'AGENTS.md'), '# agents');
  assert.deepEqual(vendorDestinations(agents), ['.claude/skills', '.agents/skills']);

  const copilotOnly = mkdtempSync(join(tmpdir(), 'vd-'));
  mkdirSync(join(copilotOnly, '.github'), { recursive: true });
  writeFileSync(join(copilotOnly, '.github', 'copilot-instructions.md'), 'x');
  assert.deepEqual(vendorDestinations(copilotOnly), ['.claude/skills']);

  const all = mkdtempSync(join(tmpdir(), 'vd-'));
  mkdirSync(join(all, '.cursor', 'rules'), { recursive: true });
  writeFileSync(join(all, 'AGENTS.md'), '# agents');
  assert.deepEqual(vendorDestinations(all), ['.claude/skills', '.cursor/skills', '.agents/skills']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/skill-vendor.test.mjs`
Expected: FAIL — `STACK_CATALOG` has no export.

- [ ] **Step 3: Implement** — in `src/core/skill-vendor.mjs`, after the `OPTIONAL_CATALOG` block, add (and extend `CURATED_ALLOWLIST`; add the two fs imports at the top of the file):

```js
import { existsSync } from 'node:fs';
import { join } from 'node:path';
```

```js
/** Stack-matched add-ons from the vetted mirror (skills/<name>/, see each dir's
 *  ATTRIBUTION.md). Suggested on the results screen when detectStacks() finds the
 *  stack in the target repo. Invariants (tested): subset of the allowlist,
 *  disjoint from the baseline AND the optional catalog. */
export const STACK_CATALOG = Object.freeze({
  'spring-boot':    Object.freeze(['rest-api-conventions', 'spring-data-jpa', 'spring-security-jwt', 'flyway-migrations', 'testing-pyramid']),
  swift:            Object.freeze(['swift', 'swiftui']),
  docker:           Object.freeze(['docker']),
  kubernetes:       Object.freeze(['kubernetes']),
  terraform:        Object.freeze(['terraform']),
  'github-actions': Object.freeze(['github-actions']),
  react:            Object.freeze(['react']),
  nextjs:           Object.freeze(['nextjs']),
  django:           Object.freeze(['django']),
  fastapi:          Object.freeze(['fastapi']),
  express:          Object.freeze(['express']),
});

/** Flat unique union of every STACK_CATALOG skill name. */
export const STACK_SKILLS = Object.freeze([...new Set(Object.values(STACK_CATALOG).flat())]);
```

Change the existing allowlist line to:

```js
export const CURATED_ALLOWLIST = Object.freeze([...CURATED_BASELINE, ...OPTIONAL_CATALOG, ...STACK_SKILLS]);
```

Append at the end of the file:

```js
/** Where vendored skills go in `projectDir`, presence-based: which AI-tool
 *  footprints does the repo actually have? (Infra-gen writes those footprints
 *  from the multiToolTargets answer during the run, so the user's choice is
 *  reflected on disk; also correct for old runs and hand-configured repos.)
 *  `.claude/skills` always and first; Copilot has no skills support. */
export function vendorDestinations(projectDir) {
  const dests = ['.claude/skills'];
  if (existsSync(join(projectDir, '.cursor', 'rules')) || existsSync(join(projectDir, '.cursorrules'))) {
    dests.push('.cursor/skills');
  }
  if (existsSync(join(projectDir, 'AGENTS.md'))) dests.push('.agents/skills');
  return dests;
}
```

NOTE: the module header comment says "Pure vendoring-policy contract" — update that header line to `// Vendoring-policy contract for the onboarding infra-gen agent (pure) + presence-based destination probes (read-only fs).` since `vendorDestinations` does fs probes.

- [ ] **Step 4: Run to verify pass**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/skill-vendor.test.mjs`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add src/core/skill-vendor.mjs test/skill-vendor.test.mjs
git commit -m "feat(enable): STACK_CATALOG mirror registry + presence-based vendorDestinations"
```

---

### Task 2: detectStacks — deterministic manifest sniffing

**Files:**
- Create: `src/core/stack-detect.mjs`
- Test: `test/stack-detect.test.mjs`

**Interfaces:**
- Consumes: `STACK_CATALOG` keys (names must match exactly).
- Produces: `detectStacks(projectDir): Array<{ stack: string, evidence: string }>` — sorted by stack name, one entry per detected stack, `evidence` human-readable (becomes the suggestion `reason`).

- [ ] **Step 1: Write the failing test** — create `test/stack-detect.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectStacks } from '../src/core/stack-detect.mjs';
import { STACK_CATALOG } from '../src/core/skill-vendor.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'stacks-'));
const stacks = (d) => detectStacks(d).map((s) => s.stack);

test('empty repo detects nothing', () => {
  assert.deepEqual(detectStacks(dir()), []);
});

test('spring-boot via pom.xml containing spring-boot', () => {
  const d = dir();
  writeFileSync(join(d, 'pom.xml'), '<project><artifactId>spring-boot-starter-web</artifactId></project>');
  const out = detectStacks(d);
  assert.deepEqual(out.map((s) => s.stack), ['spring-boot']);
  assert.match(out[0].evidence, /pom\.xml/);
});

test('spring-boot via build.gradle.kts; plain java gradle does NOT match', () => {
  const d1 = dir();
  writeFileSync(join(d1, 'build.gradle.kts'), 'plugins { id("org.springframework.boot") }');
  assert.deepEqual(stacks(d1), ['spring-boot']);
  const d2 = dir();
  writeFileSync(join(d2, 'build.gradle'), 'plugins { id("java") }');
  assert.deepEqual(stacks(d2), []);
});

test('swift via Package.swift or *.xcodeproj', () => {
  const d1 = dir();
  writeFileSync(join(d1, 'Package.swift'), '// swift-tools-version:6.0');
  assert.deepEqual(stacks(d1), ['swift']);
  const d2 = dir();
  mkdirSync(join(d2, 'App.xcodeproj'), { recursive: true });
  assert.deepEqual(stacks(d2), ['swift']);
});

test('devops artifacts detect independently — Dockerfile alone must not suggest kubernetes', () => {
  const d = dir();
  writeFileSync(join(d, 'Dockerfile'), 'FROM node:22');
  assert.deepEqual(stacks(d), ['docker']);
});

test('kubernetes via Chart.yaml, kustomization.yaml, or k8s/ manifest with apiVersion+kind', () => {
  const d1 = dir();
  writeFileSync(join(d1, 'Chart.yaml'), 'name: app');
  assert.deepEqual(stacks(d1), ['kubernetes']);
  const d2 = dir();
  writeFileSync(join(d2, 'kustomization.yaml'), 'resources: []');
  assert.deepEqual(stacks(d2), ['kubernetes']);
  const d3 = dir();
  mkdirSync(join(d3, 'k8s'));
  writeFileSync(join(d3, 'k8s', 'deploy.yaml'), 'apiVersion: apps/v1\nkind: Deployment');
  assert.deepEqual(stacks(d3), ['kubernetes']);
  const d4 = dir();
  mkdirSync(join(d4, 'k8s'));
  writeFileSync(join(d4, 'k8s', 'notes.yaml'), 'just: notes');
  assert.deepEqual(stacks(d4), []);
});

test('terraform via *.tf; github-actions via .github/workflows/*.yml', () => {
  const d1 = dir();
  writeFileSync(join(d1, 'main.tf'), 'resource "x" "y" {}');
  assert.deepEqual(stacks(d1), ['terraform']);
  const d2 = dir();
  mkdirSync(join(d2, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(d2, '.github', 'workflows', 'ci.yml'), 'on: push');
  assert.deepEqual(stacks(d2), ['github-actions']);
});

test('package.json deps: react / nextjs (implies react — nextjs only) / express', () => {
  const d1 = dir();
  writeFileSync(join(d1, 'package.json'), JSON.stringify({ dependencies: { react: '^19' } }));
  assert.deepEqual(stacks(d1), ['react']);
  const d2 = dir();
  writeFileSync(join(d2, 'package.json'), JSON.stringify({ dependencies: { next: '^15', react: '^19' } }));
  assert.deepEqual(stacks(d2), ['nextjs']);
  const d3 = dir();
  writeFileSync(join(d3, 'package.json'), JSON.stringify({ dependencies: { express: '^4' }, devDependencies: {} }));
  assert.deepEqual(stacks(d3), ['express']);
  const d4 = dir();
  writeFileSync(join(d4, 'package.json'), 'not json');
  assert.deepEqual(stacks(d4), []);
});

test('python deps: django / fastapi via pyproject.toml or requirements.txt', () => {
  const d1 = dir();
  writeFileSync(join(d1, 'pyproject.toml'), '[project]\ndependencies = ["django>=5"]');
  assert.deepEqual(stacks(d1), ['django']);
  const d2 = dir();
  writeFileSync(join(d2, 'requirements.txt'), 'fastapi==0.115\nuvicorn');
  assert.deepEqual(stacks(d2), ['fastapi']);
});

test('multi-stack repo: sorted stack names, every stack is a STACK_CATALOG key', () => {
  const d = dir();
  writeFileSync(join(d, 'Dockerfile'), 'FROM eclipse-temurin');
  writeFileSync(join(d, 'pom.xml'), '<a>spring-boot</a>');
  mkdirSync(join(d, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(d, '.github', 'workflows', 'ci.yml'), 'on: push');
  const out = stacks(d);
  assert.deepEqual(out, ['docker', 'github-actions', 'spring-boot']);
  for (const s of out) assert.ok(Object.hasOwn(STACK_CATALOG, s));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/stack-detect.test.mjs`
Expected: FAIL — cannot find module `stack-detect.mjs`.

- [ ] **Step 3: Implement** — create `src/core/stack-detect.mjs`:

```js
// src/core/stack-detect.mjs
// Deterministic, offline stack detection for the stack-skills mirror. Read-only
// manifest sniffing — no LLM, no network. Each detected stack keys STACK_CATALOG
// in skill-vendor.mjs; `evidence` becomes the results-screen suggestion reason.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const names = (dir) => { try { return readdirSync(dir); } catch { return []; } };

function pkgDeps(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  } catch { return {}; }
}

function pyDeps(dir) {
  return read(join(dir, 'pyproject.toml')) + '\n' + read(join(dir, 'requirements.txt'));
}

/**
 * Detect the target repo's stacks from manifests. Pure fs reads, top level only
 * (plus the conventional k8s/, manifests/, .github/workflows/ dirs).
 * @param {string} projectDir
 * @returns {Array<{stack: string, evidence: string}>} sorted by stack name
 */
export function detectStacks(projectDir) {
  const found = new Map(); // stack -> evidence

  // spring-boot: any JVM manifest mentioning spring-boot / springframework.boot
  for (const f of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
    const text = read(join(projectDir, f));
    if (/spring-boot|springframework\.boot/i.test(text)) { found.set('spring-boot', `Spring Boot detected (${f})`); break; }
  }

  // swift: SPM manifest or an Xcode project/workspace dir
  if (existsSync(join(projectDir, 'Package.swift'))) found.set('swift', 'Swift detected (Package.swift)');
  else {
    const xcode = names(projectDir).find((n) => n.endsWith('.xcodeproj') || n.endsWith('.xcworkspace'));
    if (xcode) found.set('swift', `Swift detected (${xcode})`);
  }

  // devops artifacts — each detects independently
  if (existsSync(join(projectDir, 'Dockerfile')) ||
      names(projectDir).some((n) => /^docker-compose.*\.ya?ml$/.test(n))) {
    found.set('docker', 'Docker detected (Dockerfile/docker-compose)');
  }
  if (existsSync(join(projectDir, 'Chart.yaml')) || existsSync(join(projectDir, 'kustomization.yaml'))) {
    found.set('kubernetes', 'Kubernetes detected (helm/kustomize manifest)');
  } else {
    for (const d of ['k8s', 'manifests']) {
      const hit = names(join(projectDir, d)).find((n) => /\.ya?ml$/.test(n) &&
        /apiVersion:/.test(read(join(projectDir, d, n))) && /kind:/.test(read(join(projectDir, d, n))));
      if (hit) { found.set('kubernetes', `Kubernetes detected (${d}/${hit})`); break; }
    }
  }
  if (names(projectDir).some((n) => n.endsWith('.tf'))) found.set('terraform', 'Terraform detected (*.tf)');
  if (names(join(projectDir, '.github', 'workflows')).some((n) => /\.ya?ml$/.test(n))) {
    found.set('github-actions', 'GitHub Actions detected (.github/workflows)');
  }

  // node web frameworks from package.json deps; nextjs implies react
  const deps = pkgDeps(projectDir);
  if (deps.next) found.set('nextjs', 'Next.js detected (package.json)');
  else if (deps.react) found.set('react', 'React detected (package.json)');
  if (deps.express) found.set('express', 'Express detected (package.json)');

  // python web frameworks
  const py = pyDeps(projectDir);
  if (/\bdjango\b/i.test(py)) found.set('django', 'Django detected (python manifest)');
  if (/\bfastapi\b/i.test(py)) found.set('fastapi', 'FastAPI detected (python manifest)');

  return [...found.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([stack, evidence]) => ({ stack, evidence }));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/stack-detect.test.mjs`
Expected: PASS 10/10.

- [ ] **Step 5: Commit**

```bash
git add src/core/stack-detect.mjs test/stack-detect.test.mjs
git commit -m "feat(enable): deterministic detectStacks manifest sniffing"
```

---

### Task 3: suggestion union — stack matches into tools.suggested

**Files:**
- Modify: `src/core/onboarding-contracts.mjs` (normalizeToolsReport signature + `SUGGESTION_SOURCES`)
- Modify: `src/core/phases.mjs` (hook passes stack matches for the tools channel)
- Test: `test/onboarding-contracts.test.mjs` (unit), `test/onboarding-contracts-hook.test.mjs` (hook wiring)

**Interfaces:**
- Consumes: `detectStacks(projectDir)` (Task 2), `STACK_CATALOG` (Task 1).
- Produces: `normalizeToolsReport(raw, { stackMatches = [] } = {})` — second optional arg, `stackMatches` is `detectStacks()` output. Suggested entries gain allowed source `'stack-match'`. Hook computes matches from `ctx.projectDir` for the `tools` channel only.

- [ ] **Step 1: Write the failing unit tests** — append to `test/onboarding-contracts.test.mjs` (read the file first; reuse its existing import of `normalizeToolsReport`):

```js
test('normalizeToolsReport: stack matches union into suggested with source stack-match', () => {
  const r = normalizeToolsReport(
    { installed: [{ name: 'graphify', source: 'bundle' }], skipped: [], suggested: [] },
    { stackMatches: [{ stack: 'spring-boot', evidence: 'Spring Boot detected (pom.xml)' }] },
  );
  assert.equal(r.ok, true);
  const names = r.value.suggested.map((s) => s.name);
  for (const n of ['rest-api-conventions', 'spring-data-jpa', 'spring-security-jwt', 'flyway-migrations', 'testing-pyramid']) {
    assert.ok(names.includes(n), `${n} suggested for spring-boot`);
  }
  const s = r.value.suggested.find((x) => x.name === 'spring-data-jpa');
  assert.equal(s.source, 'stack-match');
  assert.equal(s.reason, 'Spring Boot detected (pom.xml)');
});

test('normalizeToolsReport: union skips installed names and agent suggestions win collisions', () => {
  const r = normalizeToolsReport(
    {
      installed: [{ name: 'docker', source: 'bundle' }],
      skipped: [],
      suggested: [{ name: 'terraform', reason: 'agents saw infra dirs', source: 'analyzer' }],
    },
    { stackMatches: [{ stack: 'docker', evidence: 'Docker detected (Dockerfile)' },
                     { stack: 'terraform', evidence: 'Terraform detected (*.tf)' }] },
  );
  assert.equal(r.ok, true);
  assert.ok(!r.value.suggested.some((s) => s.name === 'docker'), 'installed name never suggested');
  const tf = r.value.suggested.filter((s) => s.name === 'terraform');
  assert.equal(tf.length, 1, 'no duplicate');
  assert.equal(tf[0].source, 'analyzer', 'agent suggestion wins the collision');
});

test('normalizeToolsReport: agent-written stack-match source is accepted verbatim', () => {
  const r = normalizeToolsReport({ installed: [], skipped: [], suggested: [{ name: 'docker', reason: 'x', source: 'stack-match' }] });
  assert.equal(r.ok, true);
  assert.equal(r.value.suggested[0].source, 'stack-match');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/onboarding-contracts.test.mjs`
Expected: FAIL — spring skills not in suggested (union not implemented) and `stack-match` source defaulted to `catalog`.

- [ ] **Step 3: Implement the union** — in `src/core/onboarding-contracts.mjs`:

Change line 221 to:

```js
const SUGGESTION_SOURCES = new Set(['catalog', 'analyzer', 'stack-match']);
```

Add the import near the existing skill-vendor import (line 11):

```js
import { CURATED_BASELINE, STACK_CATALOG } from './skill-vendor.mjs';
```

Change the `normalizeToolsReport` signature and add the union AFTER the existing `suggested` filter block (after line 282), before the `knownKeys` check:

```js
export function normalizeToolsReport(raw, { stackMatches = [] } = {}) {
```

```js
  // Union deterministic stack matches into suggested. Installed and
  // agent-suggested names win — the matcher only ADDS, never overrides.
  // Each addition pushes a warning so the hook's existing warnings-triggered
  // rewrite persists the unioned file (clean files stay byte-identical).
  const suggestedNames = new Set(suggested.map((s) => s.name));
  for (const m of stackMatches) {
    for (const name of STACK_CATALOG[m.stack] || []) {
      if (installedNames.has(name) || suggestedNames.has(name)) continue;
      suggested.push({ name, reason: String(m.evidence || `${m.stack} detected`), source: 'stack-match' });
      suggestedNames.add(name);
      warnings.push(`tools.suggested.${name}: added from stack match (${m.stack})`);
    }
  }
```

- [ ] **Step 4: Run to verify unit pass**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/onboarding-contracts.test.mjs`
Expected: PASS.

- [ ] **Step 5: Write the failing hook test** — append to `test/onboarding-contracts-hook.test.mjs` (read the file first: it exercises `validateContractOutputs` indirectly through the phases module; follow its existing pattern for invoking the hook with a ctx whose `outputs.tools.path` points at a temp tools.json. If the file drives the hook via an exported wrapper, reuse it; the assertion is on the REWRITTEN file content):

```js
test('tools channel: hook unions detectStacks matches from ctx.projectDir', async () => {
  // temp project with a Dockerfile; temp tools.json missing the docker suggestion
  const proj = mkdtempSync(join(tmpdir(), 'hook-stacks-'));
  writeFileSync(join(proj, 'Dockerfile'), 'FROM node:22');
  const out = mkdtempSync(join(tmpdir(), 'hook-out-'));
  const toolsPath = join(out, 'tools.json');
  writeFileSync(toolsPath, JSON.stringify({ installed: [], skipped: [], suggested: [] }));

  await runToolsValidation({ projectDir: proj, outputs: { tools: { path: toolsPath } } });

  const after = JSON.parse(readFileSync(toolsPath, 'utf8'));
  const docker = after.suggested.find((s) => s.name === 'docker');
  assert.ok(docker, 'docker suggested from Dockerfile');
  assert.equal(docker.source, 'stack-match');
});
```

(`runToolsValidation` = whatever invocation shape the existing hook tests use — mirror it exactly. If the hook is not directly importable, the existing test file already solves this; copy its mechanism.)

- [ ] **Step 6: Run to verify failure**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/onboarding-contracts-hook.test.mjs`
Expected: new test FAILS (no union at hook level).

- [ ] **Step 7: Wire the hook** — in `src/core/phases.mjs`:

Add import:

```js
import { detectStacks } from './stack-detect.mjs';
```

In `validateContractOutputs` (line ~980), compute per-channel context and pass it (only `tools` gets matches; a detect failure must never fail the run):

```js
    let result;
    if (channel === 'tools') {
      let stackMatches = [];
      try { stackMatches = detectStacks(ctx.projectDir); }
      catch (err) { console.warn(`[contracts] tools: stack detection failed (${err.message}) — continuing without matches`); }
      result = normalize(raw, { stackMatches });
    } else {
      result = normalize(raw);
    }
```

(replacing the existing `const result = normalize(raw);` line)

The existing rewrite block (`if (result.warnings.length > 0) { … rewrite … }`) stays UNCHANGED — each stack-match addition pushed a warning in Step 3, so additions trigger the existing rewrite path, while clean files (no warnings, no additions) remain byte-identical exactly as today.

- [ ] **Step 8: Run to verify pass + adjacent suites**

Run:
```
MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/onboarding-contracts-hook.test.mjs
MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/onboarding-contracts.test.mjs test/onboarding-tools-readers.test.mjs
```
Expected: PASS all.

- [ ] **Step 9: Commit**

```bash
git add src/core/onboarding-contracts.mjs src/core/phases.mjs test/onboarding-contracts.test.mjs test/onboarding-contracts-hook.test.mjs
git commit -m "feat(enable): union detectStacks matches into tools.suggested (source stack-match)"
```

---

### Task 4: mirror ingestion script + the 16 vetted skills

**Files:**
- Create: `scripts/mirror-skills.mjs`
- Create: `skills/<name>/` × 16 (see list) each with `SKILL.md`, `ATTRIBUTION.md`, `LICENSE`
- Test: `test/skills-mirror.test.mjs`

**Interfaces:**
- Consumes: `STACK_SKILLS`, `resolveSkill` (existing).
- Produces: committed mirror dirs that `resolveSkill()` resolves as `bundle`.

- [ ] **Step 1: Write the failing hygiene test** — create `test/skills-mirror.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STACK_SKILLS } from '../src/core/skill-vendor.mjs';
import { resolveSkill } from '../src/core/skills.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('every STACK_CATALOG skill is mirrored: bundle-resolvable with SKILL.md, ATTRIBUTION.md, LICENSE', () => {
  for (const name of STACK_SKILLS) {
    const r = resolveSkill(name, { repoRoot, projectDir: repoRoot, homeDir: '/nonexistent-home' });
    assert.equal(r.source, 'bundle', `${name} must resolve from the repo bundle`);
    for (const f of ['SKILL.md', 'ATTRIBUTION.md', 'LICENSE']) {
      assert.ok(existsSync(join(r.path, f)), `${name}/${f} missing`);
    }
    const attribution = readFileSync(join(r.path, 'ATTRIBUTION.md'), 'utf8');
    assert.match(attribution, /https:\/\/github\.com\//, `${name} attribution names the upstream repo`);
    assert.match(attribution, /[0-9a-f]{40}/, `${name} attribution pins a full commit SHA`);
    const skill = readFileSync(join(r.path, 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\n[\s\S]*?\bname:/m, `${name} SKILL.md has frontmatter with a name`);
  }
});

test('mirrored skills contain no executable payloads', () => {
  for (const name of STACK_SKILLS) {
    const r = resolveSkill(name, { repoRoot, projectDir: repoRoot, homeDir: '/nonexistent-home' });
    const walk = (dir) => {
      for (const e of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else assert.ok(/\.(md|txt|json|ya?ml|toml|java|kt|swift|ts|tsx|js|py|xml|gradle|properties|sql|sh)$|^LICENSE$/.test(e.name),
          `${name}: unexpected file type ${p}`);
      }
    };
    walk(r.path);
  }
});
```

NOTE: `require` is unavailable in ESM — import `readdirSync` at the top instead (`import { existsSync, readFileSync, readdirSync } from 'node:fs';`) and use it directly. Write it that way from the start.

- [ ] **Step 2: Run to verify failure**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/skills-mirror.test.mjs`
Expected: FAIL — none of the 16 dirs exist.

- [ ] **Step 3: Write the ingestion script** — create `scripts/mirror-skills.mjs`:

```js
// scripts/mirror-skills.mjs
// One-shot (re-runnable) ingestion for the stack-skills mirror. Clones each
// upstream at a pinned ref into a temp dir, copies the mapped skill dirs into
// skills/<local-name>/, writes ATTRIBUTION.md + copies the upstream LICENSE.
// Every refresh is a deliberate re-run + human review + commit — never runtime.
//
// Usage: node scripts/mirror-skills.mjs [--ref-override <repo>=<sha>]
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, copyFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// upstream -> { ref: pin (branch/sha; sha recorded either way), skills: { localName: pathInRepo } }
const SOURCES = {
  'https://github.com/rrezartprebreza/spring-boot-skills': {
    ref: 'main',
    skills: {
      'rest-api-conventions': 'skills/spring-boot-3/rest-api-conventions',
      'spring-data-jpa': 'skills/spring-boot-3/spring-data-jpa',
      'spring-security-jwt': 'skills/spring-boot-3/spring-security-jwt',
      'flyway-migrations': 'skills/spring-boot-3/flyway-migrations',
      'testing-pyramid': 'skills/spring-boot-3/testing-pyramid',
    },
  },
  'https://github.com/Mindrally/skills': {
    ref: 'main',
    skills: {
      swift: 'swift', swiftui: 'swiftui',
      docker: 'docker', kubernetes: 'kubernetes', terraform: 'terraform', 'github-actions': 'github-actions',
      react: 'react', nextjs: 'nextjs', django: 'django', fastapi: 'fastapi', express: 'express',
    },
  },
};

for (const [url, { ref, skills }] of Object.entries(SOURCES)) {
  const tmp = mkdtempSync(join(tmpdir(), 'mirror-'));
  execFileSync('git', ['clone', '--depth', '50', url, tmp], { stdio: 'inherit' });
  execFileSync('git', ['-C', tmp, 'checkout', ref], { stdio: 'inherit' });
  const sha = execFileSync('git', ['-C', tmp, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  for (const [local, remotePath] of Object.entries(skills)) {
    const src = join(tmp, remotePath);
    if (!existsSync(join(src, 'SKILL.md'))) {
      console.error(`SKIP ${local}: ${remotePath} has no SKILL.md at ${url}@${sha} — check the upstream layout`);
      continue;
    }
    const dest = join(repoRoot, 'skills', local);
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
    for (const lic of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
      if (existsSync(join(tmp, lic))) { copyFileSync(join(tmp, lic), join(dest, 'LICENSE')); break; }
    }
    writeFileSync(join(dest, 'ATTRIBUTION.md'),
      `# Attribution\n\nMirrored from ${url}\n\n- path: \`${remotePath}\`\n- commit: ${sha}\n` +
      `- mirrored: ${new Date().toISOString().slice(0, 10)}\n- local modifications: none\n`);
    console.log(`mirrored ${local} <- ${url}@${sha.slice(0, 7)}:${remotePath}`);
  }
  rmSync(tmp, { recursive: true, force: true });
}
console.log('Done. REVIEW every mirrored file before committing.');
```

- [ ] **Step 4: Run the script and RECONCILE the mapping**

Run: `node scripts/mirror-skills.mjs`

Upstream dir names were verified only from READMEs — if the script prints `SKIP` for any skill, `ls` the cloned layout (clone manually to a temp dir), find the actual dir for that skill, update the `SOURCES` mapping (local names NEVER change — they must match `STACK_CATALOG`), and re-run. If an upstream skill genuinely does not exist in any form, STOP and report BLOCKED with the upstream layout — do not invent content.

- [ ] **Step 5: Review + prune mirrored content**

Read every mirrored `SKILL.md` (and skim `examples/`/`templates/`/`references/`). Delete files that are not needed by the skill (upstream repo boilerplate, CI configs). Confirm no file instructs agents to fetch remote content or run arbitrary commands — if one does, STOP and report BLOCKED naming the file (that's a vetting rejection, the human decides).

- [ ] **Step 6: Run hygiene test to verify pass**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/skills-mirror.test.mjs`
Expected: PASS 2/2. Also run `test/skill-vendor.test.mjs` (still green).

- [ ] **Step 7: Commit**

```bash
git add scripts/mirror-skills.mjs skills/ test/skills-mirror.test.mjs
git commit -m "feat(enable): vetted stack-skills mirror (16 skills) + ingestion script"
```

---

### Task 5: vendor endpoint fans out to vendorDestinations

**Files:**
- Modify: `apps/enable/server.mjs` (`/api/enable/vendor`, lines ~540-573)
- Test: `test/enable-vendor.test.mjs`

**Interfaces:**
- Consumes: `vendorDestinations(projectDir)` (Task 1).
- Produces: endpoint response gains `destinations: string[]` (relative dirs written). Idempotency: `already: true` only when the skill exists in EVERY destination; otherwise missing ones are filled.

- [ ] **Step 1: Write the failing tests** — append to `test/enable-vendor.test.mjs` (read the file first; reuse its server-boot, cookie, `freshRepo`-style helpers and its existing guard-test mechanics):

```js
test('vendor fans out to .cursor/skills and .agents/skills when footprints exist', async () => {
  const dir = freshProject();                       // reuse the file's existing temp-project helper name
  mkdirSync(join(dir, '.cursor', 'rules'), { recursive: true });
  writeFileSync(join(dir, 'AGENTS.md'), '# agents');
  const r = await post('/api/enable/vendor', { dir, name: 'writing-plans' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.destinations, ['.claude/skills', '.cursor/skills', '.agents/skills']);
  for (const d of r.json.destinations) {
    assert.ok(existsSync(join(dir, d, 'writing-plans', 'SKILL.md')), `${d} copy exists`);
  }
});

test('vendor already:true only when present in EVERY destination; fills the missing ones', async () => {
  const dir = freshProject();
  mkdirSync(join(dir, '.cursor', 'rules'), { recursive: true });
  const r1 = await post('/api/enable/vendor', { dir, name: 'writing-plans' });
  assert.equal(r1.json.already, false);
  // add a new footprint after the first vendor -> .agents/skills now missing
  writeFileSync(join(dir, 'AGENTS.md'), '# agents');
  const r2 = await post('/api/enable/vendor', { dir, name: 'writing-plans' });
  assert.equal(r2.json.already, false, 'fills the newly-required destination');
  assert.ok(existsSync(join(dir, '.agents', 'skills', 'writing-plans', 'SKILL.md')));
  const r3 = await post('/api/enable/vendor', { dir, name: 'writing-plans' });
  assert.equal(r3.json.already, true, 'all destinations present now');
});

test('the ~/.claude guard applies to every destination (symlinked .cursor)', async () => {
  // mirror the existing symlink guard test's HOME-override mechanics, but symlink .cursor
  const { dir, fakeGlobal, restore } = symlinkTrapProject('.cursor');   // adapt from the existing symlink test
  try {
    const r = await post('/api/enable/vendor', { dir, name: 'writing-plans' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /user-global/);
    assert.ok(!existsSync(join(fakeGlobal, 'skills', 'writing-plans')), 'nothing written through the symlink');
  } finally { restore(); }
});
```

(The third test's `symlinkTrapProject` helper does not exist — build it by extracting/adapting the existing symlink guard test's setup in the same file: temp HOME with a fake `~/.claude`, a project whose named dir is a symlink into it. Keep the existing `.claude` symlink test untouched.)

- [ ] **Step 2: Run to verify failure**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/enable-vendor.test.mjs`
Expected: new tests FAIL (`destinations` undefined; single-destination behavior).

- [ ] **Step 3: Implement** — in `apps/enable/server.mjs`, add `vendorDestinations` to the existing `skill-vendor.mjs` import, then replace the single-target section of the route (from `const target = path.join(dir, '.claude', 'skills', name);` through the final `res.json(...)`) with:

```js
  const destinations = vendorDestinations(dir);
  const globalClaude = path.join(os.homedir(), '.claude');
  const resolvedGlobal = existsSync(globalClaude) ? resolveRealish(globalClaude) : globalClaude;
  const targets = [];
  for (const rel of destinations) {
    const target = path.join(dir, ...rel.split('/'), name);
    // Resolve through the filesystem so a symlinked ancestor (.claude, .cursor,
    // .agents, or their skills/ subdir pointed at ~/.claude) can't lexically
    // dodge the prefix check while landing writes inside the real global dir.
    const resolvedTarget = resolveRealish(target);
    if (resolvedTarget === resolvedGlobal || resolvedTarget.startsWith(resolvedGlobal + path.sep)) {
      return res.status(400).json({ error: 'refusing to vendor into the user-global ~/.claude' });
    }
    targets.push({ rel, target });
  }
  const missing = targets.filter((t) => !existsSync(path.join(t.target, 'SKILL.md')));
  if (missing.length === 0) return res.json({ ok: true, name, already: true, destinations });
  const r = resolveSkill(name, { repoRoot: REPO_ROOT, projectDir: dir, homeDir: SKILLS_HOME });
  if (!r.source) return res.status(404).json({ error: `skill "${name}" was not found on this machine` });
  try {
    for (const t of missing) cpSync(r.path, t.target, { recursive: true });
    const manifest = path.join(dir, '.claude', 'skills', 'VENDORED.md');
    let head = '# Vendored skills\n';
    try { head = readFileSync(manifest, 'utf8'); } catch {}
    const line = `- ${name} — vendored from ${r.source} via the Enable results screen ` +
      `(${new Date().toISOString().slice(0, 10)}) → ${destinations.join(', ')}\n`;
    writeFileSync(manifest, `${head.replace(/\n*$/, '\n')}${line}`);
  } catch (err) { return res.status(500).json({ error: String(err && err.message || err) }); }
  res.json({ ok: true, name, source: r.source, already: false, destinations });
```

(Everything before this point in the route — allowlist check, dir validation — is unchanged. `mkdirSync` is not needed: `cpSync` recursive creates parents.)

- [ ] **Step 4: Run to verify pass**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/enable-vendor.test.mjs`
Expected: PASS all (pre-existing guard tests included — `.claude/skills` is always destination[0], so old assertions hold).

- [ ] **Step 5: Commit**

```bash
git add apps/enable/server.mjs test/enable-vendor.test.mjs
git commit -m "feat(enable): vendor endpoint fans skills out to per-tool destinations with guard per destination"
```

---

### Task 6: infra-gen prompt — multi-tool skill mirroring

**Files:**
- Modify: `agents/maestro-project-onboarding.md` (the multi-tool section, ~line 100-105, and the vendored-skills bullet ~line 96-98)
- Test: `test/agent-registry-onboarding.test.mjs` (prompt-pin)

**Interfaces:**
- Consumes: none (prompt-only).
- Produces: infra-gen instruction text that mirrors vendored skills per multiToolTargets.

- [ ] **Step 1: Write the failing prompt-pin test** — append to `test/agent-registry-onboarding.test.mjs` (read the file first; it already reads agent md bodies — reuse that mechanism):

```js
test('infra-gen prompt instructs multi-tool skill mirroring', () => {
  const body = readAgentBody('maestro-project-onboarding.md');   // reuse the file's existing reader
  assert.match(body, /\.cursor\/skills/, 'names .cursor/skills');
  assert.match(body, /\.agents\/skills/, 'names .agents/skills');
  assert.match(body, /copilot/i, 'covers the copilot no-skills case');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/agent-registry-onboarding.test.mjs`
Expected: new test FAILS.

- [ ] **Step 3: Edit the prompt** — in `agents/maestro-project-onboarding.md`, inside the multi-tool compatibility bullet list (after the `.cursor/rules` mapping line ~102), add:

```markdown
  - **Vendored-skill mirroring:** the SKILL.md format is an open standard. For every skill you vendor into `.claude/skills/`, ALSO copy the identical skill dir into each skills location implied by the chosen targets: Cursor → `.cursor/skills/<name>/`; `AGENTS.md` (generic agents) → `.agents/skills/<name>/`. Copilot has no skills support — its instructions file is the only Copilot artifact. Record the destinations per skill in `.claude/skills/VENDORED.md`.
```

- [ ] **Step 4: Run to verify pass**

Run: `MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/agent-registry-onboarding.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agents/maestro-project-onboarding.md test/agent-registry-onboarding.test.mjs
git commit -m "feat(enable): infra-gen mirrors vendored skills into per-tool skills dirs"
```

---

### Task 7: full-suite reconciliation

**Files:**
- Modify: only test files whose enumeration-style expectations (allowlist size/membership lists, suggestion-source enumerations) changed. NEVER weaken behavioral assertions.

- [ ] **Step 1: Run the full suite** (split-run: the six enable-* JSDOM UI files hang the full-glob run — run them standalone, rc=124 with all-pass output is a pass):

```
FILES=$(ls test/*.mjs | grep -v -E 'enable-(a11y|interactive|pause-ui|renderer|setup-tools|tools-ui)')
MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test $FILES
for f in enable-a11y.test enable-interactive.test enable-pause-ui.test enable-renderer enable-setup-tools.test enable-tools-ui.test; do
  timeout 60 env MAESTRO_HOME=.maestro-test node --disable-warning=ExperimentalWarning --test test/$f.mjs
done
```

Known pre-existing failures (NOT yours to fix): 2 failures in `test/cli-subcommands.test.mjs` (`/tmp/x` sandbox collision).

- [ ] **Step 2: Reconcile enumerations only.** Candidates: any test asserting `CURATED_ALLOWLIST` length/contents, tools-report source enumerations, or skills-dir listings. If a test fails for a behavioral reason, STOP and report BLOCKED with the output.

- [ ] **Step 3: Commit (if changes were needed)**

```bash
git add test/
git commit -m "test: expectation updates for the stack-skills mirror"
```
