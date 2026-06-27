# AI-Readiness Report MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `maestro readiness` — a CLI command that scans 1+ repos and produces a scored AI-Readiness Report (markdown + JSON) that GTM can sell as a concierge diagnostic.

**Architecture:** Mirror the existing read-only workspace-scan engine. A new `ReadinessAudit` engine reuses the graph phase (graphify per member, throwaway worktree, D4 cleanup), fans out one read-only **auditor** agent per project that scores 6 fixed dimensions 0-100 with evidence, then a **pure rubric module** aggregates the raw scores into an overall score + band and renders the report. Unlike scan, the report is **persisted** to the store (filesystem only — no DB, no UI).

**Tech Stack:** Node ≥22 ESM (`.mjs`), `node:test` + `assert/strict`, EventEmitter engine, graphify CLI, Claude headless runner with a deterministic mock role.

**Scope — explicitly DEFERRED (NOT in this MVP):** web UI, PDF export, continuous/re-score, drift alerts, DB persistence, automated skill generation. The "one generated skill" upsell is concierge/manual for now.

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `src/core/readiness-rubric.mjs` | Pure scoring IP: dimensions+weights, `scoreProject`, `band`, `aggregate`, `renderReport`. No I/O, no claude. | Create |
| `agents/maestro-readiness-auditor.md` | Read-only auditor agent body: fan out one investigator per project, score 6 dims with evidence, emit ONE JSON block. | Create |
| `agents/readinessAuditor.meta.json` | Registry meta (display, fanOut, scope). | Create |
| `src/core/claude-runner.mjs` | Add `readiness-audit` mock role + register in `MOCK_FANOUT_ROLES`. | Modify |
| `src/core/phases.mjs` | Add `runReadinessAudit(ctx, opts)` (mirrors `runWorkspaceScan`). | Modify |
| `src/core/store.mjs` | Add `readinessStorePath(key, { workspace })`. | Modify |
| `src/core/readiness-audit.mjs` | `ReadinessAudit` EventEmitter engine: graph phase reuse + fan-out + rubric + persist. Emits `readiness-*`. | Create |
| `src/cli/maestro.mjs` | `readiness` subcommand. | Modify |
| `test/readiness-rubric.test.mjs` | Unit tests for the pure rubric. | Create |
| `test/readiness-audit.test.mjs` | Engine tests (mock-driven, mirrors `workspace-scan.test.mjs`). | Create |
| `test/readiness-cli.test.mjs` | CLI smoke (mock). | Create |

---

## Task 1: Pure rubric module — dimensions, scoring, bands

**Files:**
- Create: `src/core/readiness-rubric.mjs`
- Test: `test/readiness-rubric.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// test/readiness-rubric.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIMENSIONS, scoreProject, band, aggregate, renderReport } from '../src/core/readiness-rubric.mjs';

test('DIMENSIONS: 6 dims, weights sum to 1.0', () => {
  assert.equal(DIMENSIONS.length, 6);
  const sum = DIMENSIONS.reduce((a, d) => a + d.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights must sum to 1, got ${sum}`);
  for (const d of DIMENSIONS) {
    assert.equal(typeof d.key, 'string');
    assert.equal(typeof d.label, 'string');
    assert.equal(typeof d.weight, 'number');
  }
});

test('scoreProject: weighted overall, clamps 0-100, missing dim -> 0', () => {
  const all100 = Object.fromEntries(DIMENSIONS.map((d) => [d.key, 100]));
  const r = scoreProject(all100);
  assert.equal(r.overall, 100);
  assert.equal(r.dimensions.length, 6);

  const none = scoreProject({});
  assert.equal(none.overall, 0);

  const clamped = scoreProject({ [DIMENSIONS[0].key]: 9999, [DIMENSIONS[1].key]: -50 });
  for (const d of clamped.dimensions) assert.ok(d.score >= 0 && d.score <= 100);
});

test('band: thresholds', () => {
  assert.equal(band(10), 'Not Ready');
  assert.equal(band(50), 'Emerging');
  assert.equal(band(70), 'Workable');
  assert.equal(band(90), 'Agent-Ready');
});

test('aggregate: mean of project overalls + band', () => {
  const a = aggregate([{ overall: 80 }, { overall: 40 }]);
  assert.equal(a.overall, 60);
  assert.equal(a.band, 'Workable');
  assert.equal(aggregate([]).overall, 0);
});

test('renderReport: markdown has score, band, per-project + per-dimension rows', () => {
  const projectResults = [{
    projectKey: 'k1', projectName: 'svc-a',
    ...scoreProject(Object.fromEntries(DIMENSIONS.map((d) => [d.key, 80]))),
    topGaps: ['no integration tests'],
  }];
  const md = renderReport({
    name: 'Acme', projectResults, overall: 80, band: band(80), graphifyUsed: true,
  });
  assert.match(md, /# AI-Readiness Report: Acme/);
  assert.match(md, /Overall Score.*80/s);
  assert.match(md, /Agent-Ready/);
  assert.match(md, /svc-a/);
  assert.match(md, new RegExp(DIMENSIONS[0].label));
  assert.match(md, /no integration tests/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MAESTRO_HOME=.maestro-test node --test test/readiness-rubric.test.mjs`
Expected: FAIL — `Cannot find module '../src/core/readiness-rubric.mjs'`

- [ ] **Step 3: Write the implementation**

```javascript
// src/core/readiness-rubric.mjs
//
// Pure AI-Readiness scoring. No I/O, no claude. The auditor agent produces raw
// per-dimension scores (0-100) per project; this module is the deterministic,
// testable IP that turns those into an overall score, a band, and the report
// markdown. Keeping it pure means the credibility-critical math is unit-tested
// without an LLM.

/** The 6 fixed readiness dimensions. Weights sum to 1.0. */
export const DIMENSIONS = [
  { key: 'testSafetyNet', label: 'Test Safety Net', weight: 0.25,
    hint: 'Can an agent verify its own change? Test presence, coverage breadth, a runnable test command.' },
  { key: 'legibility', label: 'Legibility', weight: 0.20,
    hint: 'README / docs / ADRs, consistent naming, modules a reader can hold in context.' },
  { key: 'typeContractCoverage', label: 'Type & Contract Coverage', weight: 0.15,
    hint: 'Types / schemas / interfaces; explicit API contracts an agent can rely on.' },
  { key: 'conventionDensity', label: 'Convention Density', weight: 0.15,
    hint: 'Lint/format config and consistent patterns an agent can mirror.' },
  { key: 'structureClarity', label: 'Structure Clarity', weight: 0.15,
    hint: 'Modularity, low dead/duplicate code, sane coupling (graph signal).' },
  { key: 'aiScaffolding', label: 'AI Scaffolding', weight: 0.10,
    hint: 'Existing AI affordances: CLAUDE.md/AGENTS.md, skills, agent configs, CODEOWNERS.' },
];

const clamp = (n) => Math.max(0, Math.min(100, Number.isFinite(+n) ? +n : 0));

/**
 * Score one project from a map of { dimKey: score }. Missing dims count as 0.
 * @returns {{ overall:number, dimensions:Array<{key,label,weight,score}> }}
 */
export function scoreProject(dimScores = {}) {
  const dimensions = DIMENSIONS.map((d) => ({
    key: d.key, label: d.label, weight: d.weight, score: clamp(dimScores[d.key]),
  }));
  const overall = Math.round(dimensions.reduce((a, d) => a + d.weight * d.score, 0));
  return { overall, dimensions };
}

/** Map an overall 0-100 score to a readiness band. */
export function band(overall) {
  const n = clamp(overall);
  if (n < 40) return 'Not Ready';
  if (n < 60) return 'Emerging';
  if (n < 80) return 'Workable';
  return 'Agent-Ready';
}

/** Workspace roll-up: mean of per-project overalls. */
export function aggregate(projectResults = []) {
  if (!projectResults.length) return { overall: 0, band: band(0) };
  const overall = Math.round(
    projectResults.reduce((a, p) => a + clamp(p.overall), 0) / projectResults.length,
  );
  return { overall, band: band(overall) };
}

/** Render the report markdown. Pure string build. */
export function renderReport({ name, projectResults = [], overall, band: bnd, graphifyUsed }) {
  const lines = [];
  lines.push(`# AI-Readiness Report: ${name}`);
  lines.push('');
  lines.push(`**Overall Score: ${overall}/100 — ${bnd}**`);
  lines.push('');
  lines.push(`Projects assessed: ${projectResults.length}. Graph-grounded: ${graphifyUsed ? 'yes' : 'no (source-read)'}.`);
  lines.push('');
  for (const p of projectResults) {
    lines.push(`## ${p.projectName} — ${p.overall}/100 (${band(p.overall)})`);
    lines.push('');
    lines.push('| Dimension | Score | Weight |');
    lines.push('| --- | --- | --- |');
    for (const d of p.dimensions) lines.push(`| ${d.label} | ${d.score} | ${Math.round(d.weight * 100)}% |`);
    lines.push('');
    if (Array.isArray(p.topGaps) && p.topGaps.length) {
      lines.push('**Top gaps:**');
      for (const g of p.topGaps) lines.push(`- ${g}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `MAESTRO_HOME=.maestro-test node --test test/readiness-rubric.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/readiness-rubric.mjs test/readiness-rubric.test.mjs
git commit -m "feat(readiness): pure rubric module — dimensions, scoring, bands, report render"
```

---

## Task 2: Auditor agent body + meta

**Files:**
- Create: `agents/maestro-readiness-auditor.md`
- Create: `agents/readinessAuditor.meta.json`

(No automated test — agent bodies are markdown contracts; Task 5's engine test exercises the wiring via mock.)

- [ ] **Step 1: Write the agent body**

```markdown
---
name: maestro-readiness-auditor
description: AI-Readiness Auditor for Maestro. Scores how ready a set of repos is for AI coding agents across 6 fixed dimensions (test safety net, legibility, type/contract coverage, convention density, structure clarity, AI scaffolding) by fanning out one read-only investigator per project, then emits ONE JSON block of per-project per-dimension scores with evidence and top gaps. Read-only; never edits any repo. Off-pipeline — invoked directly by the readiness audit engine.
tools: Read, Write, Bash, Grep, Glob, Skill
model: inherit
---

You are the **AI-Readiness Auditor**. You run OUTSIDE the Plan -> Refine -> Implement -> Review pipeline: the readiness engine spawns you once to judge how ready a set of repos is for AI coding agents. You are strictly **read-only** — investigate and report; NEVER edit, commit, or branch in any repo.

## Inputs (from the task prompt)
- The projects: each project's name, `projectKey`, and the directory to investigate (a throwaway worktree when graphify built a graph there, else the project root).
- For each project, whether a `graphify-out/` knowledge graph is available (use it when present; otherwise fall back to `Read`/`Grep`/`Glob`).
- The absolute path to write the readiness JSON.

## The 6 dimensions (score each 0-100, per project)
1. **testSafetyNet** — Can an agent verify its own change? Tests present, coverage breadth, a discoverable runnable test command. (Highest weight — no tests means agents can't self-correct.)
2. **legibility** — README / docs / ADRs, consistent naming, modules small enough to reason about.
3. **typeContractCoverage** — Types / schemas / interfaces; explicit API contracts.
4. **conventionDensity** — Lint/format config and consistent patterns an agent can mirror.
5. **structureClarity** — Modularity, low dead/duplicate code, sane coupling. Use the graph when present.
6. **aiScaffolding** — Existing AI affordances: CLAUDE.md/AGENTS.md, skills, agent configs, CODEOWNERS.

## What to do
1. **Fan out (cap 4).** Dispatch ONE read-only investigator per project. Each scores its OWN project across all 6 dimensions with one concrete evidence string per dimension and 1-3 `topGaps`. Announce each with `AUDITING <projectKey>` so the engine's live status updates; announce the merge with `SCORING readiness`.
2. **Ground in real code.** When `graphify-out/` exists, read `graphify-out/GRAPH_REPORT.md` and run `graphify query`/`explain` for structure signal. Otherwise inspect with `Read`/`Grep`/`Glob`. Never invent evidence; a dimension you cannot assess scores low with evidence saying so.
3. **Emit ONE JSON block yourself.** Merge investigator reports in sorted `projectKey` order and write a single JSON file to the given path.

## Anti-explosion rule (binding)
Investigators are single-level: they MUST NOT re-fan-out. YOU merge and write the JSON.

## Output contract (write EXACTLY this JSON shape to the given path)
```json
{
  "projects": [
    {
      "projectKey": "<key>",
      "projectName": "<name>",
      "dimensions": {
        "testSafetyNet":        { "score": 0, "evidence": "" },
        "legibility":           { "score": 0, "evidence": "" },
        "typeContractCoverage": { "score": 0, "evidence": "" },
        "conventionDensity":    { "score": 0, "evidence": "" },
        "structureClarity":     { "score": 0, "evidence": "" },
        "aiScaffolding":        { "score": 0, "evidence": "" }
      },
      "topGaps": ["<gap>"]
    }
  ]
}
```

- Write ONLY this JSON to the absolute path you are given. Edit nothing in any repo.
- After writing, emit a short assistant note with the absolute path.

## Graph tooling
If the prompt says **graphify** is available for a project, use it via the exact dispatch the system-prompt instruction specifies (Skill tool, Bash, or read `graphify-out/`). If unavailable, proceed with Glob/Grep/Read.
```

- [ ] **Step 2: Write the meta JSON**

```json
{
  "key": "readinessAuditor",
  "displayName": "Readiness Audit",
  "description": "score repos for AI-readiness",
  "color": "amber",
  "icon": "<path d=\"M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 21l-5.4-2.8.9-5.5-4-3.9 5.5-.8z\" stroke-linejoin=\"round\"/>",
  "agentFile": "maestro-readiness-auditor.md",
  "runnerType": "producer",
  "loopSource": false,
  "fanOut": true,
  "produces": ["readiness"],
  "consumes": ["userPrompt"],
  "connectsTo": [],
  "order": 0.4,
  "scope": "workspace-only"
}
```

- [ ] **Step 3: Verify JSON parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('agents/readinessAuditor.meta.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add agents/maestro-readiness-auditor.md agents/readinessAuditor.meta.json
git commit -m "feat(readiness): auditor agent body + registry meta"
```

---

## Task 3: Mock role `readiness-audit`

**Files:**
- Modify: `src/core/claude-runner.mjs:401` (add to `MOCK_FANOUT_ROLES`)
- Modify: `src/core/claude-runner.mjs:482` (add `case`) and the mock-fn region near line 910

- [ ] **Step 1: Write the failing test**

```javascript
// add to test/readiness-rubric.test.mjs is wrong place; create a focused mock test inline in engine test (Task 5).
// For this task, prove the mock writes valid JSON via a direct runClaude mock call.
// test/readiness-mock.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaude } from '../src/core/claude-runner.mjs';

test('mock readiness-audit: writes valid JSON with per-project dimensions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-rdmock-'));
  const out = join(dir, 'readiness.json');
  const prompt =
    '## Member projects to audit\n\n' +
    '- **svc-a** (`k-aaaa`): audit `/tmp/a`\n' +
    '- **svc-b** (`k-bbbb`): audit `/tmp/b`\n\n' +
    '<!--MOCK_ROLE=readiness-audit-->\n' +
    `<!--MOCK_OUT=${out}-->\n` +
    '<!--MOCK_BASE=Acme-->\n';
  await runClaude({ cwd: dir, prompt, systemPrompt: '', mock: true, onEvent() {} });
  const json = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(json.projects.length, 2);
  assert.ok('testSafetyNet' in json.projects[0].dimensions);
  assert.equal(typeof json.projects[0].dimensions.testSafetyNet.score, 'number');
  await rm(dir, { recursive: true, force: true });
});
```

> NOTE: confirm `runClaude` accepts `{ mock: true }` the same way other mocks are reached (via `mockEnabled(opts)` at `claude-runner.mjs:95`). If mock is keyed off `process.env.MAESTRO_MOCK`, set `process.env.MAESTRO_MOCK='1'` in the test instead of passing `mock:true`.

- [ ] **Step 2: Run test to verify it fails**

Run: `MAESTRO_HOME=.maestro-test node --test test/readiness-mock.test.mjs`
Expected: FAIL — mock falls to default role, no JSON written (`ENOENT` on readFile)

- [ ] **Step 3: Register the fan-out role**

In `src/core/claude-runner.mjs`, add `'readiness-audit'` to the `MOCK_FANOUT_ROLES` set (line ~401):

```javascript
const MOCK_FANOUT_ROLES = new Set([
  'planner-plan', 'refiner', 'implementer', 'plan-review',
  'workspace-reviewer', 'workspace-scan', 'readiness-audit',
]);
```

- [ ] **Step 4: Add the switch case**

In `runMock`'s switch (after the `workspace-scan` case, line ~484):

```javascript
    case 'readiness-audit':
      text = await mockReadinessAudit(m, prompt, onEvent);
      break;
```

- [ ] **Step 5: Add the mock function**

After `mockWorkspaceScan` (line ~910), add (mirrors its member-key parsing):

```javascript
/**
 * Mock the off-pipeline readiness auditor. Parses `(`backtick-key`)` member markers
 * from the prompt, emits one `AUDITING <key>` line per project plus `SCORING readiness`,
 * and writes a deterministic readiness JSON to MOCK_OUT so the engine + rubric run
 * fully offline. Scores descend slightly per project so output is non-uniform.
 */
async function mockReadinessAudit(m, prompt, onEvent) {
  const out = m.MOCK_OUT;
  const members = [];
  for (const line of String(prompt || '').split(/\r?\n/)) {
    const mm = line.match(/^\s*-\s+\*\*(.+?)\*\*\s+\(`([^`]+)`\)/);
    if (mm) members.push({ projectName: mm[1], projectKey: mm[2] });
  }
  if (!members.length) members.push({ projectName: 'project-a', projectKey: 'k-aaaa' });
  for (const p of members) await emitLog(onEvent, `AUDITING ${p.projectKey}`);
  await emitLog(onEvent, 'SCORING readiness');

  const dimKeys = [
    'testSafetyNet', 'legibility', 'typeContractCoverage',
    'conventionDensity', 'structureClarity', 'aiScaffolding',
  ];
  const projects = members.map((p, i) => ({
    projectKey: p.projectKey,
    projectName: p.projectName,
    dimensions: Object.fromEntries(dimKeys.map((k, j) => [k, {
      score: Math.max(0, 70 - i * 10 - j * 2), evidence: `[mock] ${k} evidence`,
    }])),
    topGaps: [`[mock] top gap for ${p.projectName}`],
  }));

  if (!out) return '[mock] readiness-audit: no MOCK_OUT given';
  await ensureDir(out);
  await writeFile(out, JSON.stringify({ projects }, null, 2), 'utf8');
  safeEmit(onEvent, { type: 'tool_use', text: `wrote ${out}`, raw: { mock: true, file: out } });
  return `[mock] readiness JSON written to ${out}`;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `MAESTRO_HOME=.maestro-test node --test test/readiness-mock.test.mjs`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/claude-runner.mjs test/readiness-mock.test.mjs
git commit -m "feat(readiness): deterministic readiness-audit mock role"
```

---

## Task 4: Phase runner `runReadinessAudit` + store path

**Files:**
- Modify: `src/core/store.mjs` (add `readinessStorePath`)
- Modify: `src/core/phases.mjs` (add `runReadinessAudit`, after `runWorkspaceScan` at line 827)

- [ ] **Step 1: Write the failing test**

```javascript
// test/readiness-phase.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReadinessAudit } from '../src/core/phases.mjs';

const AGENTS_DIR = fileURLToPath(new URL('../agents', import.meta.url));

test('runReadinessAudit (mock): writes JSON to outPath, returns parsed scores', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-rdphase-'));
  const out = join(dir, 'readiness.json');
  const ctx = {
    projectDir: dir,
    pipelineDir: dir,
    projects: [
      { projectKey: 'k-aaaa', projectName: 'svc-a', projectDir: '/tmp/a', graphify: false },
      { projectKey: 'k-bbbb', projectName: 'svc-b', projectDir: '/tmp/b', graphify: false },
    ],
    workspaceName: 'Acme',
    toolInstruction: '',
    agentPrompts: { readinessAuditor: '' },
    fanOut: true,
    claudeOpts: { mock: true },
    onEvent() {},
  };
  const r = await runReadinessAudit(ctx, { outPath: out, name: 'Acme' });
  assert.equal(r.outPath, out);
  const json = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(json.projects.length, 2);
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MAESTRO_HOME=.maestro-test node --test test/readiness-phase.test.mjs`
Expected: FAIL — `runReadinessAudit is not a function`

- [ ] **Step 3: Add `readinessStorePath` to store.mjs**

```javascript
/** Per-key readiness store dir: <store>/<key>/readiness or <store>/workspaces/<key>/readiness. */
export function readinessStorePath(key, { workspace = false } = {}) {
  return join(workspace ? workspaceStorePath(key) : projectStorePath(key), 'readiness');
}
```

- [ ] **Step 4: Add `runReadinessAudit` to phases.mjs**

Insert after `runWorkspaceScan` (line 827). Mirrors it exactly but with the readiness role, JSON template, and `readinessAuditor` body key:

```javascript
export async function runReadinessAudit(ctx, opts = {}) {
  const role = 'readiness-audit'; // MOCK_ROLE marker; FALLBACK prompt-role lookup
  const projects = Array.isArray(ctx.projects) ? ctx.projects : [];
  const name = opts.name || ctx.workspaceName || 'Repo';
  const outPath = opts.outPath || joinPipeline(ctx.pipelineDir, 'readiness.json');
  const systemPrompt = buildSystemPrompt(ctx.toolInstruction, resolveAgentBody(ctx, 'readinessAuditor'), role, undefined);

  const memberLines = projects.map((p) =>
    `- **${p.projectName || p.projectKey}** (\`${p.projectKey}\`): audit \`${p.scanDir || p.projectDir}\`` +
    `${p.graphify ? ' (graphify-out/ available)' : ''}`,
  ).join('\n');

  const prompt =
    `# Task: Audit AI-readiness — ${name}\n\n` +
    `Pipeline directory (shared artifacts): ${ctx.pipelineDir}\n\n` +
    `## Member projects to audit\n\n${memberLines || '(no members)'}\n\n` +
    '## What to do\n\n' +
    'Score each project 0-100 across the 6 readiness dimensions (testSafetyNet, legibility, ' +
    'typeContractCoverage, conventionDensity, structureClarity, aiScaffolding) with one evidence ' +
    'string per dimension and 1-3 topGaps.\n\n' +
    fanOutDirective(true) +
    'Dispatch ONE read-only investigator per member project (cap 4); merge in sorted `projectKey` ' +
    'order and write the JSON yourself. Investigators MUST NOT re-fan-out.\n\n' +
    'Announce each with `AUDITING <projectKey>` and the merge with `SCORING readiness`.\n\n' +
    '## Output JSON shape (write EXACTLY this to the path below)\n\n' +
    '```json\n' +
    '{ "projects": [ { "projectKey": "", "projectName": "", "dimensions": { ' +
    '"testSafetyNet": {"score":0,"evidence":""}, "legibility": {"score":0,"evidence":""}, ' +
    '"typeContractCoverage": {"score":0,"evidence":""}, "conventionDensity": {"score":0,"evidence":""}, ' +
    '"structureClarity": {"score":0,"evidence":""}, "aiScaffolding": {"score":0,"evidence":""} }, ' +
    '"topGaps": [""] } ] }\n' +
    '```\n\n' +
    `Write the readiness JSON to: ${outPath}\n\n` +
    mockMarkers({ MOCK_ROLE: 'readiness-audit', MOCK_OUT: outPath, MOCK_BASE: name });

  const { text } = await runClaude(
    runOpts(ctx, { role, prompt, systemPrompt, allowedTools: READ_WRITE_TOOLS }),
  );

  let raw = '';
  try {
    const { readFile } = await import('node:fs/promises');
    raw = await readFile(outPath, 'utf8');
  } catch {
    raw = (text || '').trim();
  }
  return { raw, outPath };
}
```

> NOTE: confirm `joinPipeline`, `mockMarkers`, `runOpts`, `runClaude`, `READ_WRITE_TOOLS`, `buildSystemPrompt`, `resolveAgentBody`, `fanOutDirective` are all in scope in phases.mjs (they are — used by `runWorkspaceScan`). `resolveAgentBody(ctx, 'readinessAuditor')` reads `ctx.agentPrompts.readinessAuditor`.

- [ ] **Step 5: Run test to verify it passes**

Run: `MAESTRO_HOME=.maestro-test node --test test/readiness-phase.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/store.mjs src/core/phases.mjs test/readiness-phase.test.mjs
git commit -m "feat(readiness): runReadinessAudit phase + readinessStorePath"
```

---

## Task 5: The `ReadinessAudit` engine

**Files:**
- Create: `src/core/readiness-audit.mjs`
- Test: `test/readiness-audit.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// test/readiness-audit.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createReadinessAudit } from '../src/core/readiness-audit.mjs';
import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after);
const AGENTS_DIR = fileURLToPath(new URL('../agents', import.meta.url));
const created = [];
after(() => Promise.all(created.map((d) => rm(d, { recursive: true, force: true }))));

async function freshRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-rd-'));
  created.push(dir);
  const g = (a) => spawnSync('git', a, { cwd: dir });
  g(['init', '-q', '-b', 'main']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  await writeFile(join(dir, 'README.md'), '# hi\n');
  g(['add', '-A']); g(['commit', '-qm', 'init']);
  return dir;
}

async function runAudit(opts) {
  const audit = createReadinessAudit({ agentsDir: AGENTS_DIR, claude: { mock: true }, ...opts });
  const events = [];
  for (const n of ['readiness-progress', 'readiness-done', 'readiness-error']) {
    audit.on(n, (p) => events.push({ type: n, ...p }));
  }
  const result = await audit.run();
  return { audit, events, result };
}

test('run() (mock): one readiness-done with overall score, band, persisted report', async () => {
  const a = await freshRepo();
  const b = await freshRepo();
  const { events, result } = await runAudit({ projectPaths: [a, b], name: 'Acme' });
  const done = events.filter((e) => e.type === 'readiness-done');
  const errs = events.filter((e) => e.type === 'readiness-error');
  assert.equal(errs.length, 0);
  assert.equal(done.length, 1);
  assert.equal(typeof done[0].overall, 'number');
  assert.equal(typeof done[0].band, 'string');
  assert.ok(done[0].reportPath && existsSync(done[0].reportPath), 'report markdown persisted');
  assert.ok(done[0].jsonPath && existsSync(done[0].jsonPath), 'readiness JSON persisted');
  const md = await readFile(done[0].reportPath, 'utf8');
  assert.match(md, /# AI-Readiness Report: Acme/);
  assert.equal(result.status, 'done');
});

test('run() (mock): progress messages change; scratch dir removed in finally', async () => {
  const a = await freshRepo();
  const audit = createReadinessAudit({ projectPaths: [a], name: 'Single', agentsDir: AGENTS_DIR, claude: { mock: true } });
  const scratch = audit.getState().scratchDir;
  const msgs = [];
  audit.on('readiness-progress', (p) => msgs.push(p.message));
  await audit.run();
  assert.ok(new Set(msgs).size >= 2, `message must change; saw ${msgs.join(' | ')}`);
  assert.ok(!existsSync(scratch), 'scratch removed in finally');
});

test('run() never throws: 0 members -> readiness-error, resolves', async () => {
  const { events, result } = await runAudit({ projectPaths: [], name: 'Empty' });
  assert.equal(result.status, 'error');
  assert.equal(events.filter((e) => e.type === 'readiness-error').length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MAESTRO_HOME=.maestro-test node --test test/readiness-audit.test.mjs`
Expected: FAIL — `Cannot find module '../src/core/readiness-audit.mjs'`

- [ ] **Step 3: Write the engine**

```javascript
// src/core/readiness-audit.mjs
//
// Off-pipeline AI-Readiness engine. Mirrors workspace-scan.mjs: an EventEmitter
// driven over a `readiness-*` event family, phases graph -> audit -> score. Reuses
// the throwaway-worktree graphify build (D4 cleanup) and the fan-out auditor agent
// (runReadinessAudit in phases.mjs). UNLIKE scan, the rendered report + JSON are
// PERSISTED to the readiness store. run() NEVER throws (emits readiness-error).

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join, basename } from 'node:path';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';

import { maestroHome } from './projects.mjs';
import { projectKey, canonicalProjectRoot, readinessStorePath } from './store.mjs';
import { slugify, today } from './artifacts.mjs';
import { detectToolsPerProject, runGraphifyUpdate } from './preflight.mjs';
import { createWorktree, removeWorktree, resolveDefaultBranch, sanitizeBranchName } from './worktree.mjs';
import { runReadinessAudit } from './phases.mjs';
import { fanoutCap, mapWithCap } from './fanout.mjs';
import { scoreProject, aggregate, band, renderReport } from './readiness-rubric.mjs';

const AUDITOR_AGENT_FILE = 'maestro-readiness-auditor.md';

export function createReadinessAudit(opts = {}) {
  return new ReadinessAudit(opts);
}

class ReadinessAudit extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts || {};
    this.name = (typeof this.opts.name === 'string' && this.opts.name.trim()) || 'Repo';
    this.agentsDir = this.opts.agentsDir || null;
    this.claude = this.opts.claude || {};
    this.mock = this.opts.mock !== undefined ? !!this.opts.mock : !!this.claude.mock;
    this.graphBuildTimeoutMs = Number(this.opts.graphBuildTimeoutMs)
      || Number(process.env.MAESTRO_GRAPH_TIMEOUT_MS) || 120000;
    this.cap = Number(this.opts.fanoutCap) > 0 ? Number(this.opts.fanoutCap) : fanoutCap();
    // workspace persistence namespace (true when given a workspaceKey)
    this.workspaceKey = typeof this.opts.workspaceKey === 'string' ? this.opts.workspaceKey : null;

    const raw = Array.isArray(this.opts.projectPaths) ? this.opts.projectPaths : [];
    const seen = new Set();
    const members = [];
    for (const dir of raw) {
      if (typeof dir !== 'string' || !dir) continue;
      let root; try { root = canonicalProjectRoot(dir); } catch { root = dir; }
      if (seen.has(root)) continue;
      seen.add(root);
      members.push({ projectDir: dir, projectKey: projectKey(dir), projectName: basename(dir) });
    }
    members.sort((a, b) => (a.projectKey < b.projectKey ? -1 : a.projectKey > b.projectKey ? 1 : 0));
    this.projects = members;

    this.auditId = `rdns_${randomUUID()}`;
    this.shortId = this.auditId.slice(5, 13);
    this.scratchDir = join(maestroHome(), 'tmp', 'readiness', this.shortId);
    this.outPath = join(this.scratchDir, 'readiness.json');

    this.abort = new AbortController();
    this.warnings = [];
    this.phase = 'graph';
    this.projectsTotal = members.length;
    this.projectsDone = 0;
    this.message = 'preparing audit…';
    this.status = 'created';
    this._terminal = false;
  }

  getState() {
    return {
      auditId: this.auditId, phase: this.phase, projectsTotal: this.projectsTotal,
      projectsDone: this.projectsDone, message: this.message, status: this.status,
      scratchDir: this.scratchDir,
    };
  }

  stop() {
    if (['done', 'stopped', 'error'].includes(this.status)) return;
    this.status = 'stopped';
    try { this.abort.abort(); } catch { /* ignore */ }
  }

  async run() {
    const cleanup = [];
    let graphifyUsed = false;
    try {
      this.status = 'running';
      this._checkAbort();
      if (!this.projects.length) throw new Error('a readiness audit needs at least 1 project');

      this._setPhase('graph', `detecting tooling across ${this.projectsTotal} project(s)…`);
      graphifyUsed = await this._graphPhase(cleanup);
      this._checkAbort();

      this._setPhase('audit', `auditing ${this.projectsTotal} project(s)…`);
      await mkdir(this.scratchDir, { recursive: true });
      const raw = await this._runAuditAgent();
      this._checkAbort();

      this._setPhase('score', 'scoring readiness…');
      const { overall, bnd, projectResults, reportMd, parsed } = this._score(raw, graphifyUsed);
      const { reportPath, jsonPath } = await this._persist(reportMd, parsed, overall, bnd);

      this.status = 'done';
      const payload = {
        overall, band: bnd, graphify: { used: graphifyUsed },
        projects: projectResults.map((p) => ({ projectKey: p.projectKey, projectName: p.projectName, overall: p.overall })),
        reportPath, jsonPath,
      };
      this._emitTerminal('readiness-done', payload);
      return { status: 'done', warnings: this.warnings, ...payload };
    } catch (err) {
      if (isAbort(err) || this.status === 'stopped') {
        this.status = 'stopped';
        this._emitTerminal('readiness-error', { message: 'stopped' });
        return { status: 'stopped', warnings: this.warnings };
      }
      this.status = 'error';
      const message = (err && err.message) || String(err);
      this._emitTerminal('readiness-error', { message });
      return { status: 'error', message, warnings: this.warnings };
    } finally {
      for (const c of cleanup) {
        try {
          const r = await removeWorktree({ projectDir: c.projectDir, worktreeDir: c.worktreeDir, branch: c.branch, force: true });
          if (r && r.ok === false) this.warnings.push(`readiness worktree cleanup incomplete for ${c.branch}`);
        } catch (e) {
          this.warnings.push(`readiness worktree cleanup failed for ${c.branch}: ${(e && e.message) || e}`);
        }
      }
      await rm(this.scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Graph phase — identical strategy to workspace-scan._graphPhase.
  async _graphPhase(cleanup) {
    if (this.mock) {
      this._progress(`mock mode — auditors will source-read ${this.projectsTotal} project(s)`);
      return false;
    }
    const tools = await detectToolsPerProject(this.projects.map((p) => p.projectDir));
    const slug = slugify(this.name);
    const date = today();
    let used = false;
    await mapWithCap(this.projects, this.cap, async (p) => {
      this._checkAbort();
      const info = tools.get(p.projectDir) || {};
      if (info.kind !== 'cli') { this._progress(`${p.projectName}: no graphify CLI — source-reading`); return; }
      this._progress(`building graph for ${p.projectName}…`);
      try {
        const source = await resolveDefaultBranch(p.projectDir);
        const branch = sanitizeBranchName(`maestro/rdns-${slug}-${date}-${this.shortId}`);
        const pipelineId = `rdns-${this.shortId}`;
        const wt = await createWorktree({
          projectDir: p.projectDir, pipelineId, sourceBranch: source, featureBranch: branch, signal: this.abort.signal,
        });
        cleanup.push({ projectDir: p.projectDir, worktreeDir: wt.worktreeDir, branch: wt.branch });
        const res = await runGraphifyUpdate({ dir: wt.worktreeDir, cwd: wt.worktreeDir, timeoutMs: this.graphBuildTimeoutMs });
        if (res && res.ok) { p.scanDir = wt.worktreeDir; p.graphify = true; used = true; this._progress(`graph built for ${p.projectName}`); }
        else this._progress(`${p.projectName}: graph build failed — source-reading`);
      } catch (e) {
        if (isAbort(e)) throw e;
        this._progress(`${p.projectName}: graph unavailable — source-reading`);
      }
    });
    return used;
  }

  async _runAuditAgent() {
    const agentBody = await this._loadAuditorBody();
    const ctx = {
      projectDir: this.projects[0]?.projectDir,
      pipelineDir: this.scratchDir,
      projects: this.projects.map((p) => ({
        projectKey: p.projectKey, projectName: p.projectName, projectDir: p.projectDir,
        scanDir: p.scanDir, graphify: !!p.graphify,
      })),
      workspaceName: this.name,
      toolInstruction: '',
      agentPrompts: { readinessAuditor: agentBody },
      fanOut: true,
      claudeOpts: {
        permissionMode: this.claude.permissionMode || 'acceptEdits',
        model: this.claude.model, bin: this.claude.bin, mock: this.claude.mock,
      },
      signal: this.abort.signal,
      onEvent: (e) => this._onAgentEvent(e),
    };
    const { raw } = await runReadinessAudit(ctx, { outPath: this.outPath, name: this.name });
    let text = raw;
    try { text = await readFile(this.outPath, 'utf8'); } catch { /* keep returned */ }
    return text;
  }

  // Parse the auditor JSON, run each project through the pure rubric, roll up.
  _score(raw, graphifyUsed) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('the audit produced invalid JSON'); }
    const list = Array.isArray(parsed?.projects) ? parsed.projects : [];
    if (!list.length) throw new Error('the audit produced no project scores');
    const projectResults = list.map((p) => {
      const dimScores = {};
      for (const [k, v] of Object.entries(p.dimensions || {})) dimScores[k] = v && typeof v === 'object' ? v.score : v;
      return {
        projectKey: p.projectKey, projectName: p.projectName,
        ...scoreProject(dimScores), topGaps: Array.isArray(p.topGaps) ? p.topGaps : [],
      };
    });
    const { overall, band: bnd } = aggregate(projectResults);
    const reportMd = renderReport({ name: this.name, projectResults, overall, band: bnd, graphifyUsed });
    return { overall, bnd, projectResults, reportMd, parsed };
  }

  // Persist report + JSON to the readiness store (workspace ns when workspaceKey set,
  // else under the primary member's project key). Filesystem only.
  async _persist(reportMd, parsed, overall, bnd) {
    const key = this.workspaceKey || this.projects[0].projectKey;
    const dir = readinessStorePath(key, { workspace: !!this.workspaceKey });
    await mkdir(dir, { recursive: true });
    const stem = `${today()}-${this.shortId}`;
    const reportPath = join(dir, `${stem}-READINESS.md`);
    const jsonPath = join(dir, `${stem}-readiness.json`);
    await writeFile(reportPath, reportMd, 'utf8');
    await writeFile(jsonPath, JSON.stringify({ name: this.name, overall, band: bnd, ...parsed }, null, 2), 'utf8');
    return { reportPath, jsonPath };
  }

  _onAgentEvent(e) {
    if (!e || typeof e !== 'object') return;
    const text = typeof e.text === 'string' ? e.text : '';
    const m = text.match(/AUDITING\s+(\S+)/i);
    if (m) {
      this.projectsDone = Math.min(this.projectsTotal, this.projectsDone + 1);
      this._progress(`auditing ${this._nameForKey(m[1]) || m[1]}…`);
      return;
    }
    if (/SCORING/i.test(text)) this._progress('scoring readiness…');
  }

  _nameForKey(key) { const p = this.projects.find((x) => x.projectKey === key); return p ? p.projectName : null; }

  _setPhase(phase, message) { this.phase = phase; this._progress(message); }

  _progress(message) {
    if (this._terminal) return;
    if (message) this.message = message;
    this.emit('readiness-progress', {
      auditId: this.auditId, phase: this.phase, projectsTotal: this.projectsTotal,
      projectsDone: this.projectsDone, message: this.message,
    });
  }

  _emitTerminal(type, payload) {
    if (this._terminal) return;
    this._terminal = true;
    this.emit(type, { auditId: this.auditId, ...payload });
  }

  async _loadAuditorBody() {
    if (!this.agentsDir) return '';
    try { return await readFile(join(this.agentsDir, AUDITOR_AGENT_FILE), 'utf8'); } catch { return ''; }
  }

  _checkAbort() {
    if (this.abort.signal.aborted || this.status === 'stopped') {
      const err = new Error('stopped'); err.name = 'AbortError'; throw err;
    }
  }
}

function isAbort(err) {
  return err && (err.name === 'AbortError' || /aborted|stopped/i.test(err.message || ''));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `MAESTRO_HOME=.maestro-test node --test test/readiness-audit.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/readiness-audit.mjs test/readiness-audit.test.mjs
git commit -m "feat(readiness): ReadinessAudit engine — graph reuse, rubric scoring, persisted report"
```

---

## Task 6: `maestro readiness` CLI subcommand

**Files:**
- Modify: `src/cli/maestro.mjs` (`SUBCOMMANDS` line 575, dispatch in `main` line 579, new `cmdReadiness`, HELP line ~159)
- Test: `test/readiness-cli.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// test/readiness-cli.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli/maestro.mjs', import.meta.url));
const created = [];
after(() => Promise.all(created.map((d) => rm(d, { recursive: true, force: true }))));

async function freshRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-rdcli-'));
  created.push(dir);
  const g = (a) => spawnSync('git', a, { cwd: dir });
  g(['init', '-q', '-b', 'main']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  await writeFile(join(dir, 'README.md'), '# hi\n');
  g(['add', '-A']); g(['commit', '-qm', 'init']);
  return dir;
}

test('maestro readiness --project <dir> --mock: prints score + report path', async () => {
  const a = await freshRepo();
  const home = await mkdtemp(join(tmpdir(), 'maestro-rdhome-'));
  created.push(home);
  const res = spawnSync('node', [CLI, 'readiness', '--project', a, '--mock'], {
    encoding: 'utf8', env: { ...process.env, MAESTRO_HOME: home, MAESTRO_MOCK: '1' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Overall Score:\s*\d+\/100/);
  assert.match(res.stdout, /READINESS\.md/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MAESTRO_HOME=.maestro-test node --test test/readiness-cli.test.mjs`
Expected: FAIL — `readiness` is unknown; exits non-zero / no score line

- [ ] **Step 3: Register the subcommand**

In `src/cli/maestro.mjs` line 575:

```javascript
const SUBCOMMANDS = new Set(['add', 'list', 'remove', 'resume', 'readiness']);
```

Add the import near the top (after line 24's store import region):

```javascript
import { createReadinessAudit } from '../core/readiness-audit.mjs';
```

In `main` dispatch (line 581 region):

```javascript
    if (sub === 'readiness') return cmdReadiness(rest);
```

- [ ] **Step 4: Implement `cmdReadiness`**

Add near the other subcommand handlers (after `cmdResume`, line ~504). Accepts repeated `--project <dir>` (and bare positionals) + `--mock`:

```javascript
function parseReadinessArgs(argv) {
  const projects = [];
  let mock = false;
  let name = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') { mock = true; continue; }
    if (a === '--name') { name = argv[++i] || ''; continue; }
    if (a.startsWith('--name=')) { name = a.slice(7); continue; }
    if (a === '--project') { const v = argv[++i]; if (v) projects.push(resolve(process.cwd(), v)); continue; }
    if (a.startsWith('--project=')) { projects.push(resolve(process.cwd(), a.slice(10))); continue; }
    if (!a.startsWith('--')) projects.push(resolve(process.cwd(), a));
  }
  if (!projects.length) projects.push(process.cwd());
  return { projects, mock, name };
}

async function cmdReadiness(argv) {
  const { projects, mock, name } = parseReadinessArgs(argv);
  if (mock) process.env.MAESTRO_MOCK = '1';
  const agentsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents');
  const wsKey = projects.length > 1; // multi-project rolls up; single persists under its project key
  const audit = createReadinessAudit({
    projectPaths: projects, name: name || basename(projects[0]),
    agentsDir, claude: { mock },
    workspaceKey: wsKey ? `wks-cli-${projects.map((p) => basename(p)).join('-')}` : null,
  });
  audit.on('readiness-progress', (p) => out(c('dim', `  ${p.message}`)));
  out(c('bold', `readiness audit — ${projects.length} project(s)`));
  if (mock) out(c('yellow', 'mock mode: no claude will be spawned'));
  const result = await audit.run();
  if (result.status !== 'done') { fail(`readiness audit ${result.status}: ${result.message || ''}`); return 1; }
  out('');
  out(c('bold', `Overall Score: ${result.overall}/100 — ${result.band}`));
  for (const p of result.projects) out(`  ${p.projectName}: ${p.overall}/100`);
  out('');
  out(`Report: ${result.reportPath}`);
  out(`JSON:   ${result.jsonPath}`);
  return 0;
}
```

> NOTE: confirm `out`, `c`, `fail`, `resolve`, `dirname`, `fileURLToPath`, `basename` are already imported/defined in maestro.mjs (they are — `resolve/dirname/join/basename` from `node:path` line 14, `fileURLToPath` line 13; `out`/`c`/`fail` are local helpers used by other subcommands).

- [ ] **Step 5: Add a HELP line**

In the `HELP` template (line ~159 region), under subcommands, add:

```
  maestro readiness --project <dir> [--project <dir> ...] [--name <n>] [--mock]
                           Score repo(s) for AI-readiness; writes a report + JSON
```

- [ ] **Step 6: Run test to verify it passes**

Run: `MAESTRO_HOME=.maestro-test node --test test/readiness-cli.test.mjs`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/cli/maestro.mjs test/readiness-cli.test.mjs
git commit -m "feat(readiness): maestro readiness CLI subcommand"
```

---

## Task 7: Full suite green + smoke

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — all existing tests plus the 5 new readiness test files. If any existing registry test enumerates `agents/*.meta.json` and asserts a fixed count, update that count to include `readinessAuditor` (search: `grep -rn "meta.json" test/ | grep -i count`).

- [ ] **Step 2: Manual mock smoke**

Run:
```bash
MAESTRO_HOME=.maestro-smoke MAESTRO_MOCK=1 node src/cli/maestro.mjs readiness --project examples/sandbox --mock
```
Expected: prints `Overall Score: <n>/100 — <band>` and two artifact paths; the files exist under `.maestro-smoke/store/.../readiness/`.

- [ ] **Step 3: Commit any test-count fixups**

```bash
git add -A
git commit -m "test(readiness): align registry counts; full suite green"
```

---

## Self-Review

**Spec coverage** (against the lean-MVP scope):
- Scored report across 6 dimensions → Task 1 rubric + Task 2 agent ✔
- Reuses graph phase / read-only / D4 cleanup → Task 5 engine mirrors scan ✔
- Persisted markdown + JSON (the sellable deliverable) → Task 5 `_persist` ✔
- GTM-runnable command → Task 6 CLI ✔
- Offline/demoable without claude → Task 3 mock role ✔
- Deferred (UI/PDF/continuous/DB/skill-gen) → explicitly out, noted ✔

**Placeholder scan:** every code step has full code; no TODO/TBD. Three `NOTE:` callouts are verification reminders (confirm in-scope symbols), not placeholders — each names the exact symbols and where they already exist.

**Type consistency:** `scoreProject` returns `{ overall, dimensions }`; engine spreads it into `projectResults` and reads `p.overall`/`p.dimensions` — consistent. `renderReport` consumes `projectResults` + `band(p.overall)` — matches. Engine event family is `readiness-progress|done|error` throughout. Mock role string `readiness-audit` matches `MOCK_FANOUT_ROLES`, the switch `case`, and `runReadinessAudit`'s `MOCK_ROLE` marker. Agent body key `readinessAuditor` matches `resolveAgentBody(ctx, 'readinessAuditor')` and `ctx.agentPrompts.readinessAuditor`.

**Open verification items for the implementer (resolve at Task time, don't guess):**
1. `runClaude` mock entry — confirm whether mock is reached via `mock: true` opt or `process.env.MAESTRO_MOCK` (`claude-runner.mjs:95 mockEnabled`). Task 3 test note covers both.
2. `today()` / `slugify()` signatures in `artifacts.mjs` — confirm `today()` returns the `DD-MM-YY` stem used elsewhere.
3. Registry tests that count `agents/*.meta.json` — adjust counts (Task 7 step 1).
```

