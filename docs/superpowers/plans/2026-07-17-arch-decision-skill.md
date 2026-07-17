# Maestro Arch-Decision Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `maestro-arch-decision` project skill that auto-triggers on maestro feature discussions, applies a six-rung extension-point ladder, and records each verdict as a mini-ADR in `docs/adr/`.

**Architecture:** One new skill file at `.claude/skills/maestro-arch-decision/SKILL.md` (sibling of the existing `orchestrate` project skill) plus a one-line pointer in `docs/ARCHITECTURE.md`. The `docs/adr/` directory is created by the skill on first real use, not by this implementation. No engine code, hooks, or settings changes.

**Tech Stack:** Markdown only (Claude Code project-skill format with YAML frontmatter, as in `.claude/skills/orchestrate/SKILL.md`).

**Spec:** `docs/superpowers/specs/2026-07-17-arch-decision-skill-design.md`

## Global Constraints

- Skill decides *where* a feature lives, never *how* to build it; it hands off to brainstorming/planning after the ADR.
- Skill must skip itself for pure bugfixes/refactors (no new capability = no rung decision).
- Verdict requires verifying codebase anchors against the working tree, not memory.
- Single user confirmation before writing the ADR; ADR is ~15 lines and committed.
- `NNN` in `docs/adr/NNN-<slug>.md` is the next zero-padded 3-digit sequence number.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Create the skill file

**Files:**
- Create: `.claude/skills/maestro-arch-decision/SKILL.md`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the skill file whose existence Task 2's pointer line references and whose content Task 3 validates.

- [ ] **Step 1: Write the skill file**

Write `.claude/skills/maestro-arch-decision/SKILL.md` with exactly this content:

````markdown
---
name: maestro-arch-decision
description: Use BEFORE designing or planning any new maestro feature or capability — decides which extension point it belongs to (agent, runner, workflow, platform, external skill) and records the verdict as a mini-ADR. Triggers on "add a feature to maestro", "new agent", "new pipeline", "new workflow", "should this be an agent or …", and any discussion of extending maestro. Do NOT invoke for pure bugfixes or refactors (no new capability).
---

# Maestro architectural decision

You decide **where** a proposed maestro feature lives — never **how** to build it.
Run this BEFORE brainstorming or plan mode; your verdict is an input to the design,
not a replacement for it. When the verdict is confirmed, record it as a mini-ADR,
then hand off to the normal flow (brainstorming → writing-plans → implementation).

**Skip rule:** if the request is a pure bugfix or refactor — no new capability —
say so in one line and exit this skill immediately. No rung decision, no ADR.

## The decision ladder

Rungs are ordered cheapest-first. Core rule: **pick the lowest rung that fully
expresses the feature.** For each candidate rung, answer its gate question by
checking the anchor in the working tree — never from memory.

| # | Rung | Gate question | Anchor (verify in tree) |
|---|------|---------------|-------------------------|
| 1 | Config/prompt tweak | Can an existing agent's `.md` prompt or `meta.json` express it? | `agents/*.md`, `agents/*.meta.json` |
| 2 | New agent, reuse runner | Is it a producer or verifier over existing artifact types? | `docs/ADDING-AGENTS.md`, `src/core/agent-registry.mjs` |
| 3 | New agent + new runner branch | Does it need a new artifact type or a new loop target? | `src/core/runners.mjs`, `src/core/phases.mjs`, `src/core/channels.mjs`, `AGENT_FILES`, mock case |
| 4 | New workflow/topology | Is it a composition of existing agents in a different order/loop? | Pipeline Composer, `src/core/builtin-workflows.mjs` |
| 5 | Platform capability | Does it need new engine semantics — orchestrator states, DB schema, channels, gates, UI surface, CLI? | `docs/ARCHITECTURE.md` (a contract update is mandatory) |
| 6 | External skill on top | Does it orchestrate maestro from outside without touching internals? | `.claude/skills/orchestrate` as precedent |

## Tie-breakers and smells

- A feature that crosses two rungs should be **split into two features** — decide
  each separately.
- Unsure between rung 2 and rung 3: prototype at rung 2; escalate only when runner
  reuse actually breaks.
- Smell: an agent prompt encoding control flow (loops, phase sequencing) is a
  hidden rung-4/5 feature wearing an agent costume.
- A rung-5 verdict must name the `docs/ARCHITECTURE.md` sections that change; if
  none change, the verdict is probably wrong.

## Procedure

1. Restate the proposed feature in one sentence.
2. Walk the ladder bottom-up. For each rung up to and including your verdict,
   check its anchor in the working tree (Read/Grep/Glob) and answer the gate
   question honestly.
3. Present to the user:
   - **Verdict:** rung number + name.
   - **Rationale:** one paragraph grounded in what you verified.
   - **Rejected rungs:** one line each for every rung below the verdict (why it
     cannot fully express the feature) and, when relevant, the rung above (why
     it is not needed).
4. Ask a **single confirmation** (AskUserQuestion or plain prompt). If the user
   overrides, adopt their rung and note the override in the ADR context.
5. On confirm, write the ADR and commit it (see below), then hand off:
   "Decision recorded in `docs/adr/NNN-<slug>.md` — proceeding to design/planning."

## Recording the ADR

- Path: `docs/adr/NNN-<slug>.md`. Create `docs/adr/` if it does not exist. `NNN`
  is the next zero-padded 3-digit number (`ls docs/adr/` to find it; first is `001`).
- Commit the ADR file on its own with message `docs(adr): NNN <feature name>`.

Template (keep it ~15 lines):

```markdown
# NNN — <feature name>

- **Status:** accepted
- **Date:** YYYY-MM-DD
- **Decision:** rung N — <rung name>

## Context
One paragraph: the feature and why it came up.

## Decision
One paragraph: why this rung fully expresses it.

## Rejected
- Rung X — one line why not.
- Rung Y — one line why not.

## Consequences
One or two lines: what this commits us to (files touched, contracts updated).
```
````

- [ ] **Step 2: Verify frontmatter and structure**

Run:

```bash
head -5 .claude/skills/maestro-arch-decision/SKILL.md
grep -c '^| [1-6] |' .claude/skills/maestro-arch-decision/SKILL.md
```

Expected: first line `---`, second line `name: maestro-arch-decision`, third line starting `description: Use BEFORE designing or planning`; grep count `6` (all six ladder rows present).

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/maestro-arch-decision/SKILL.md
git commit -m "feat(skills): maestro-arch-decision project skill

Six-rung extension-point ladder (config tweak -> agent -> runner ->
workflow -> platform -> external skill), verified against tree anchors,
single-confirm verdict, mini-ADR record in docs/adr/.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: ARCHITECTURE.md pointer line

**Files:**
- Modify: `docs/ARCHITECTURE.md:5` (end of the opening authoritative-contract paragraph)

**Interfaces:**
- Consumes: the skill path created in Task 1 (`.claude/skills/maestro-arch-decision/SKILL.md`).
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Add the pointer line**

In `docs/ARCHITECTURE.md`, the opening paragraph currently ends at line 5:

```markdown
binding. Do not change a signature without updating this file first.
```

Append a new paragraph directly after it (between line 5 and the `**Product:**` paragraph):

```markdown
**Extension decisions:** where a new feature belongs (agent, runner, workflow,
platform, external skill) is decided by the `.claude/skills/maestro-arch-decision`
skill; each verdict is recorded as a mini-ADR in `docs/adr/`.
```

- [ ] **Step 2: Verify**

Run:

```bash
grep -n "maestro-arch-decision" docs/ARCHITECTURE.md
```

Expected: exactly one match, in the new paragraph after line 5.

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs(architecture): pointer to arch-decision skill + docs/adr

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Validate the rubric against historical examples

**Files:**
- Read only: `.claude/skills/maestro-arch-decision/SKILL.md`, `docs/ADDING-AGENTS.md`, `src/core/runners.mjs`, `src/core/builtin-workflows.mjs`

**Interfaces:**
- Consumes: the skill file from Task 1.
- Produces: a pass/fail validation report in the session (no repo files). On any failure, the fix is an edit to `SKILL.md` (amend Task 1's file, new commit `fix(skills): tighten maestro-arch-decision ladder wording`).

- [ ] **Step 1: Dry-read trigger check**

Read the skill's `description` as a fresh reader and check both directions:
- Would it trigger on: "add a feature to maestro", "should this be a new agent or a pipeline?", "I want maestro to support X"? Expected: yes for all three.
- Would it trigger on: "fix the flaky agents-meta test", "refactor channels.mjs"? Expected: no for both (skip rule / no-new-capability phrasing in the description).

- [ ] **Step 2: Walk three historical features through the ladder**

Apply the ladder exactly as written in the skill, checking anchors in the tree, to:

1. `planReviewer` (verifier that reviews a plan artifact and loops back to the planner). Expected verdict: **rung 3** — it needed its own `case` in `src/core/runners.mjs` and a new loop target; rung 2 rejected because no existing runner branch covered a plan-review verdict loop.
2. `manualTestsChecklist` (producer that writes a manual-test checklist markdown). Expected verdict: **rung 2** — producer over an existing artifact pattern, no engine edits; rung 1 rejected because no existing agent's prompt covers checklist production.
3. Pipeline Composer itself (drag-drop workflow topology editor). Expected verdict: **rung 5** — new engine semantics (workflow storage, validator, UI surface); rung 4 rejected because it is the mechanism that *enables* topologies, not a topology.

Expected: all three verdicts match. If any walkthrough lands on a different rung, the ladder's gate questions are ambiguous — fix the wording in `SKILL.md` and re-run this step.

- [ ] **Step 3: Confirm repo tests still green**

Run:

```bash
node --test test/agents-meta.test.mjs
```

Expected: PASS (doc/skill-only change; this guards against accidental stray edits).

- [ ] **Step 4: Report**

State validation outcome to the user: trigger check result, three walkthrough verdicts, test result. No commit unless Step 2 forced a `SKILL.md` fix.
