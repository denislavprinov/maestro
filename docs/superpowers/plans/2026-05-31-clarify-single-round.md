# Clarify Single-Round Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the planner clarify phase run exactly one round instead of looping up to 3, and remove the now-pointless `--max-clarify` flag.

**Architecture:** Collapse `orchestrator.mjs:_clarifyLoop()` (a `while` loop bounded by `maxClarifyCycles`) into a single-pass `_clarify()`. Delete the `maxClarifyCycles` field and the `--max-clarify` plumbing from the CLI and UI server. Leave `phases.mjs` untouched — its prior-answers machinery stays as tested pure functions, simply never called with `round ≥ 2` anymore.

**Tech Stack:** Node.js ESM (`.mjs`), `node:test` runner, no build step. Offline mock via `MAESTRO_MOCK=1` / `--mock --yes`.

**Spec:** `docs/superpowers/specs/2026-05-31-clarify-single-round-design.md`

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `src/core/orchestrator.mjs` | Modify | `_clarifyLoop()` → single-pass `_clarify()`; drop `maxClarifyCycles` field + jsdoc |
| `src/cli/maestro.mjs` | Modify | Remove `--max-clarify` flag, alias, coercion, help line, orchestrator wiring |
| `ui/server.mjs` | Modify | Remove `maxClarifyCycles` clamp + pass-through |
| `test/clarify.test.mjs` | Modify | Swap cap tests for single-round tests; drop the help-advertises test |
| `README.md` | Modify | Reword "Clarify loop" bullet to single-round |
| `docs/ARCHITECTURE.md` | Modify | Reword clarify-loop mentions to single-round |

Confirmed facts (verified against current code, 2026-05-31):
- Current full mock run emits BOTH `clarify #1` and `clarify #2` phase events — so "no clarify phase with cycle ≥ 2" is a valid red→green discriminator.
- `createOrchestrator({}).maxClarifyCycles` is currently `3`.
- The constructor only reads named opts, so a leftover `maxClarifyCycles:` passed by CLI/UI between tasks is harmless (ignored). Task order is therefore flexible.

---

## Task 1: Collapse the clarify loop to a single round

**Files:**
- Modify: `src/core/orchestrator.mjs` (constructor ~line 83, jsdoc ~line 65, `run()` ~line 213, `_clarifyLoop` lines 297–332)
- Test: `test/clarify.test.mjs`

- [ ] **Step 1: Replace the `maxClarifyCycles defaults to 3` test with single-round tests**

In `test/clarify.test.mjs`, delete this test:

```js
test('maxClarifyCycles defaults to 3 and is overridable', () => {
  assert.equal(createOrchestrator({}).maxClarifyCycles, 3);
  assert.equal(createOrchestrator({ maxClarifyCycles: 2 }).maxClarifyCycles, 2);
});
```

Replace it with these two tests (structural + behavioral):

```js
test('orchestrator no longer exposes a clarify round cap', () => {
  const orch = createOrchestrator({});
  assert.equal(orch.maxClarifyCycles, undefined, 'maxClarifyCycles field should be gone');
});

test('clarify runs exactly one round (no clarify phase past cycle 1)', async () => {
  const projectDir = await makeTmpDir();
  const orch = createOrchestrator({
    projectDir,
    prompt: 'demo task',
    auto: true,
    claude: { mock: true },
  });
  const clarifyCycles = [];
  let clarifyQuestions = 0;
  orch.on('phase', ({ phase, cycle }) => {
    if (phase === 'clarify') clarifyCycles.push(cycle);
  });
  orch.on('question', ({ kind }) => {
    if (kind === 'clarify') clarifyQuestions += 1;
  });
  const res = await orch.run();
  assert.equal(res.status, 'done', 'mock pipeline should finish');
  assert.ok(clarifyCycles.length > 0, 'clarify phase should run');
  assert.ok(
    clarifyCycles.every((c) => c === 1),
    `clarify must stay on cycle 1, saw cycles ${clarifyCycles.join(',')}`,
  );
  assert.equal(clarifyQuestions, 1, 'clarify must be asked exactly once');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/clarify.test.mjs`
Expected: FAIL — `maxClarifyCycles` is still `3` (structural test) and the full run still emits a `clarify` phase with cycle `2` (behavioral test).

- [ ] **Step 3: Remove the `maxClarifyCycles` field and its jsdoc**

In `src/core/orchestrator.mjs`, delete the jsdoc line in the `createOrchestrator` doc block:

```js
 * @param {number} [opts.maxClarifyCycles=3]
```

And delete this line from the constructor:

```js
    this.maxClarifyCycles = numOr(this.opts.maxClarifyCycles, 3);
```

(Leave `maxRefineCycles` and `maxReviewCycles` exactly as they are.)

- [ ] **Step 4: Replace `_clarifyLoop()` with a single-pass `_clarify()`**

In `src/core/orchestrator.mjs`, replace the entire method (and its doc comment) — currently:

```js
  /**
   * The clarify loop: run planner clarify; if it returns questions, emit a
   * clarify question, await answers, persist, and re-run until no questions
   * remain. Returns the accumulated answers array.
   */
  async _clarifyLoop() {
    const collected = [];
    let round = 0;
    // Guard against a pathological agent that never stops asking. Configurable
    // via maxClarifyCycles (default 3); also the natural exit is questions === 0.
    const maxRounds = this.maxClarifyCycles;
    while (round < maxRounds) {
      round += 1;
      this._phase('clarify', round, 'start');
      const { questions } = await runPlannerClarify(this._phaseCtx('planner'), {
        round,
        priorAnswers: collected,
      });
      this._checkAbort();
      if (!Array.isArray(questions) || questions.length === 0) {
        this._phase('clarify', round, 'done');
        await appendAudit(this.pipeline.dir, `Clarify round ${round}: no further questions.`);
        break;
      }
      this._artifact('clarify', join(this.pipeline.dir, 'clarify.json'));
      const id = `clarify-${round}`;
      const answer = await this._ask({ id, kind: 'clarify', questions });
      this._checkAbort();
      const answers = normalizeClarifyAnswer(answer, questions);
      // Persist this round's Q&A and reuse the enriched (question-text-bearing)
      // result for the fed-back prompt + the later plan phase.
      const enriched = await this._writeClarifyAnswers(questions, answers);
      for (const a of enriched) collected.push(a);
      await appendAudit(
        this.pipeline.dir,
        `Clarify round ${round}: answered ${answers.length} question(s).`,
      );
      this._phase('clarify', round, 'done');
    }
    return collected;
  }
```

Replace with:

```js
  /**
   * Single clarify round: run the planner once (it asks up to four questions),
   * record the answers, then return them for the plan phase. There is no
   * re-ask loop — when the planner has no questions we skip straight to plan.
   * Returns the answers array ([{ id, question, choice }]).
   */
  async _clarify() {
    this._phase('clarify', 1, 'start');
    const { questions } = await runPlannerClarify(this._phaseCtx('planner'), {
      round: 1,
      priorAnswers: [],
    });
    this._checkAbort();
    if (!Array.isArray(questions) || questions.length === 0) {
      this._phase('clarify', 1, 'done');
      await appendAudit(this.pipeline.dir, `Clarify: no questions; proceeding to plan.`);
      return [];
    }
    this._artifact('clarify', join(this.pipeline.dir, 'clarify.json'));
    const answer = await this._ask({ id: 'clarify-1', kind: 'clarify', questions });
    this._checkAbort();
    const answers = normalizeClarifyAnswer(answer, questions);
    const enriched = await this._writeClarifyAnswers(questions, answers);
    await appendAudit(this.pipeline.dir, `Clarify: answered ${answers.length} question(s).`);
    this._phase('clarify', 1, 'done');
    return enriched;
  }
```

- [ ] **Step 5: Update the call site in `run()`**

In `src/core/orchestrator.mjs`, change:

```js
      // 4) Planner clarify loop.
      const answers = await this._clarifyLoop();
```

to:

```js
      // 4) Planner clarify (single round).
      const answers = await this._clarify();
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/clarify.test.mjs`
Expected: PASS — all clarify tests green, including the two new single-round tests. The `CLI advertises --max-clarify in help` test still passes here (flag removed in Task 2).

- [ ] **Step 7: Commit**

```bash
git add src/core/orchestrator.mjs test/clarify.test.mjs
git commit -m "fix: clarify runs a single round (collapse the clarify loop)"
```

---

## Task 2: Remove the `--max-clarify` CLI flag

**Files:**
- Modify: `src/cli/maestro.mjs` (lines 39, 56, 69, 107, 151, 347)
- Test: `test/clarify.test.mjs`

- [ ] **Step 1: Replace the help-advertises test with a help-omits test**

In `test/clarify.test.mjs`, delete this test:

```js
test('CLI advertises --max-clarify in help', () => {
  const r = spawnSync(process.execPath, ['src/cli/maestro.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--max-clarify/);
});
```

Replace it with:

```js
test('CLI no longer advertises --max-clarify in help', () => {
  const r = spawnSync(process.execPath, ['src/cli/maestro.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /--max-clarify/);
});
```

(Keep the `import { spawnSync } from 'node:child_process';` line — it is still used by this test.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/clarify.test.mjs`
Expected: FAIL — `--help` still prints `--max-clarify` (the line is still present in `src/cli/maestro.mjs`).

- [ ] **Step 3: Remove the flag default**

In `src/cli/maestro.mjs`, delete from the `out` defaults object:

```js
    maxClarify: undefined,
```

- [ ] **Step 4: Remove the flag from `takesValue` and `map`**

Delete `'--max-clarify',` from the `takesValue` Set, and delete this line from the `map` object:

```js
    '--max-clarify': 'maxClarify',
```

- [ ] **Step 5: Remove the numeric-coercion arm**

Change:

```js
      if (key === 'maxRefine' || key === 'maxReview' || key === 'maxClarify') {
```

to:

```js
      if (key === 'maxRefine' || key === 'maxReview') {
```

- [ ] **Step 6: Remove the help line**

Delete from the `HELP` template string:

```
  --max-clarify <N>        Max clarify rounds before moving to planning (must be >=1; default 3)
```

- [ ] **Step 7: Remove the orchestrator wiring**

In the `createOrchestrator({ ... })` call, delete:

```js
    maxClarifyCycles: flags.maxClarify,
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `node --test test/clarify.test.mjs`
Expected: PASS — `--help` no longer mentions `--max-clarify`.

- [ ] **Step 9: Sanity-check the CLI still parses and rejects the removed flag**

Run: `node src/cli/maestro.mjs --max-clarify 2 --prompt x --mock --yes 2>&1 | head -1`
Expected: `orchestrate: Unknown flag: --max-clarify` (proves the flag is fully gone, not silently accepted).

- [ ] **Step 10: Commit**

```bash
git add src/cli/maestro.mjs test/clarify.test.mjs
git commit -m "feat: remove --max-clarify CLI flag (clarify is now single-round)"
```

---

## Task 3: Remove `maxClarify` from the UI server

**Files:**
- Modify: `ui/server.mjs` (lines 218, 235)

(No front-end input exists for this value — `ui/public/` never sends `maxClarify` — and no UI test covers it, so this is a source edit verified by a syntax check.)

- [ ] **Step 1: Remove the clamp line**

In `ui/server.mjs`, delete:

```js
    const maxClarifyCycles = clampInt(body.maxClarify, 3);
```

- [ ] **Step 2: Remove the pass-through**

In the `createOrchestrator({ ... })` call, delete:

```js
      maxClarifyCycles,
```

- [ ] **Step 3: Verify the file still parses**

Run: `node --check ui/server.mjs`
Expected: no output, exit 0 (syntax OK).

- [ ] **Step 4: Confirm no dangling references remain**

Run: `grep -rni 'maxclarify\|max-clarify' src ui test`
Expected: no output (all references removed).

- [ ] **Step 5: Commit**

```bash
git add ui/server.mjs
git commit -m "feat: drop maxClarify from UI server (clarify is now single-round)"
```

---

## Task 4: Update the docs to describe a single clarify round

**Files:**
- Modify: `README.md:151`
- Modify: `docs/ARCHITECTURE.md` (lines ~76–77, ~343)

- [ ] **Step 1: Reword the README bullet**

In `README.md`, replace:

```
- **Clarify loop** — planner re-asks until there are no open questions; answers are
```

with:

```
- **Clarify** — planner asks one round of conceptual questions (up to four) before
```

Read the surrounding lines first and adjust the continuation wording so the sentence still reads correctly (the goal: convey a single up-front round, not a re-ask loop).

- [ ] **Step 2: Reword the ARCHITECTURE pipeline step**

In `docs/ARCHITECTURE.md`, replace:

```
3. **plan (planner)** — clarify loop then plan.
   - **clarify loop:** planner asks conceptual questions whenever it would otherwise
```

with:

```
3. **plan (planner)** — single clarify round then plan.
   - **clarify:** planner asks one round of conceptual questions whenever it would otherwise
```

Read the surrounding lines and keep the rest of the bullet's wording coherent.

- [ ] **Step 3: Reword the ARCHITECTURE event-flow mention**

In `docs/ARCHITECTURE.md` (~line 343), replace `planner clarify loop` with `planner clarify (single round)` in the numbered event-flow step. Read the line first to preserve the rest of its text.

- [ ] **Step 4: Confirm no "clarify loop" phrasing remains outside the specs**

Run: `grep -rni 'clarify loop\|re-ask\|max-clarify' README.md docs/ARCHITECTURE.md`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/ARCHITECTURE.md
git commit -m "docs: describe clarify as a single round, not a loop"
```

---

## Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: all tests pass (clarify + ui-theme), exit 0.

- [ ] **Step 2: Run the offline smoke pipeline**

Run: `npm run smoke`
Expected: the run reaches `done`. Crucially, the output shows `clarify #1 start` / `clarify #1 done` and **no** `clarify #2` line (previously it printed `clarify #2`).

- [ ] **Step 3: Confirm the smoke output has exactly one clarify cycle**

Run: `npm run smoke 2>&1 | grep -c 'clarify #'`
Expected: `2` (one `start`, one `done` — i.e. only cycle 1; never a `#2`).

- [ ] **Step 4: Final commit if any verification fixups were needed**

If steps 1–3 required no changes, nothing to commit. Otherwise:

```bash
git add -A
git commit -m "test: verification fixups for single-round clarify"
```

---

## Self-Review

**Spec coverage:**
- Clarify exactly one round → Task 1 (`_clarify()`).
- Zero questions → skip to plan → Task 1, Step 4 (early `return []`).
- Remove `--max-clarify` (CLI/UI/orchestrator/tests) → Task 1 (orchestrator field + tests), Task 2 (CLI), Task 3 (UI).
- Refine/review loops untouched → no task modifies them (verified by `npm run smoke` still completing).
- `phases.mjs` untouched → no task edits it; convergence/cap unit tests remain (not removed).
- Docs reflect single round → Task 4.

**Placeholder scan:** No TBD/TODO/"handle edge cases". Doc-reword steps (Task 4) intentionally say "read surrounding lines first" because exact continuation text spans lines not quoted here; the target wording is given explicitly.

**Type/name consistency:** Method renamed `_clarifyLoop` → `_clarify` and updated at its sole call site (Task 1, Step 5). `maxClarifyCycles` removed everywhere it is read (orchestrator) or passed (CLI Task 2 Step 7, UI Task 3 Step 2). `clampInt` / `numOr` left intact for the refine/review paths.
