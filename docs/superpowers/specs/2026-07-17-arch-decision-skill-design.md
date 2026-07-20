# Maestro architectural-decision skill — design

**Date:** 2026-07-17
**Status:** Approved (design), pending implementation
**Deliverable:** a project skill, `.claude/skills/maestro-arch-decision/SKILL.md`, plus a `docs/adr/` convention it maintains.

## Problem

When a new maestro feature is proposed there is no explicit step that decides *where* it
belongs: a new agent, a new runner branch, a workflow topology, a platform (engine/UI)
capability, or an external skill. The extension ladder is implicit in
`docs/ADDING-AGENTS.md` and `docs/ARCHITECTURE.md`, so each feature discussion re-derives
it ad hoc, and the reasoning is never recorded.

## Solution overview

A repo-versioned Claude Code skill that auto-triggers whenever a new maestro
feature/capability is being discussed, applies a fixed decision ladder against real
codebase facts, presents a verdict with rationale for a single user confirmation, then
records the decision as a mini-ADR in `docs/adr/` before handing off to normal
design/planning flow.

## 1. Placement and triggering

- Skill directory: `.claude/skills/maestro-arch-decision/` (sibling of the existing
  `orchestrate` project skill), containing only `SKILL.md`. Versioned with the repo, so
  every contributor session discovers it automatically.
- Frontmatter description is written for auto-invocation, along the lines of:
  "Use BEFORE designing or planning any new maestro feature or capability — decides which
  extension point it belongs to (agent, runner, workflow, platform, external skill).
  Triggers: 'add a feature to maestro', 'new agent', 'new pipeline', 'should this be X or
  Y', any discussion of extending maestro."
- Ordering rule stated inside the skill: it runs **before** brainstorming/plan mode. Its
  verdict is an input to the design, not a replacement for it.
- Skip rule: pure bugfixes and refactors introduce no new capability, so no rung decision
  is needed and the skill exits immediately.

## 2. The decision ladder

Rungs are ordered cheapest-first. Core rule: **pick the lowest rung that fully expresses
the feature**. Each rung has a gate question and a codebase anchor the skill must check
(not recall from memory):

| # | Rung | Gate question | Anchor |
|---|------|---------------|--------|
| 1 | Config/prompt tweak | Can an existing agent's `.md` prompt or `meta.json` express it? | `agents/*` |
| 2 | New agent, reuse runner | Is it a producer or verifier over existing artifact types? | `docs/ADDING-AGENTS.md`, `src/core/agent-registry.mjs` |
| 3 | New agent + new runner branch | Does it need a new artifact type or a new loop target? | `src/core/runners.mjs`, `phases.mjs`, `channels.mjs`, `AGENT_FILES`, mock case |
| 4 | New workflow/topology | Is it a composition of existing agents in a different order/loop? | Composer, `src/core/builtin-workflows.mjs` |
| 5 | Platform capability | Does it need new engine semantics — orchestrator states, DB schema, channels, gates, UI surface, CLI? | `docs/ARCHITECTURE.md` (contract update mandatory) |
| 6 | External skill on top | Does it orchestrate maestro from outside without touching internals? | `.claude/skills/orchestrate` as precedent |

> **Note (post-validation, commit 7882858):** the shipped skill tightens the rung-2/3
> gate wording (the distinguisher is whether another agent's channel branch must
> special-case the new key) and drops the stale `AGENT_FILES` anchor, which is no
> longer a code symbol in `src/`. The skill file is authoritative for ladder wording.

Tie-breakers and smells, stated in the skill:

- A feature that crosses two rungs should be split into two features.
- Unsure between rung 2 and 3: prototype at 2; escalate only when runner reuse actually
  breaks.
- Smell: an agent prompt encoding control flow (loops, phase sequencing) is a hidden
  rung-4/5 feature wearing an agent costume.
- Rung 5 verdicts must name the ARCHITECTURE.md sections that change; if none change, the
  verdict is probably wrong.

## 3. Output: verdict and mini-ADR

Runtime behavior after applying the rubric:

1. Verify anchors against the working tree (registry, runners, workflows) rather than
   answering from memory.
2. Present: **verdict rung**, a one-paragraph rationale, and each rejected rung with a
   one-line reason.
3. Ask a single confirmation (AskUserQuestion or plain prompt).
4. On confirm, write `docs/adr/NNN-<slug>.md` and commit it. `NNN` is the next zero-padded
   sequence number; the skill creates `docs/adr/` on first use.

ADR template (~15 lines):

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

## 4. Boundaries and doc integration

- The skill decides *where* a feature lives, never *how* to build it. After the ADR is
  committed it hands off to the normal flow (brainstorming → writing-plans →
  implementation).
- `docs/ARCHITECTURE.md` gains one pointer line referencing the skill and the `docs/adr/`
  directory so readers of the contract find the decision history.
- No engine code, hooks, or settings changes are part of this feature — it is one skill
  file, one doc line, and a directory convention.

## Testing / acceptance

- Skill file passes a dry read: description triggers on feature-discussion phrasings and
  not on bugfix phrasings.
- Walkthrough of three historical examples produces sensible verdicts: `planReviewer`
  (rung 3), `manualTestsChecklist` (rung 2), pipeline composer itself (rung 5).
- First real invocation creates `docs/adr/001-*.md` with all template sections filled.

## Clarifications Q&A

- **Form?** Repo skill, auto-invoked (over doc-only, skill+doc pair, hook-enforced).
- **Outcomes?** Full six-rung ladder (over three coarse buckets).
- **Record?** Mini-ADR per decision in `docs/adr/` (over no record / ARCHITECTURE.md log).
- **Mode?** Rubric applied by Claude, verdict + single confirmation (over interactive
  interview or silent rubric).
