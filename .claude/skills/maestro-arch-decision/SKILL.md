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
