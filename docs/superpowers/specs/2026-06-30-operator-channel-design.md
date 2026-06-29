# Operator Channel — design

**Date:** 2026-06-30
**Status:** approved (brainstorm), pending implementation plan

## Problem

The maestro pipeline runs deterministically and non-interactively after the
initial planner clarify. Two human-in-the-loop needs are unmet:

- **A — inject context mid-run.** A user remembers a missing requirement,
  spots a problem in the logs, or wants to hand the agents a file/note —
  for the next node, or even for the node currently running.
- **B — agents ask the user open questions mid-run.** Today only the planner
  clarify can ask, and it is structured (2–4 options + free text), single
  round, start-only. Any agent should be able to ask a free-form question
  partway through the run and get an answer.

## Core insight — one primitive, two directions

Both needs are the **same pipe**: a persistent **operator channel** — a
bidirectional, append-only message log bound to a run, rendered as a chat
panel in the UI (and a prompt path in the CLI).

- **inbound** (user → pipeline): operator posts note / file / correction.
- **outbound** (pipeline → user): an agent posts a question, blocks for reply.

Same channel, same chat surface. The two directions differ only in **who
initiates** and **blocking vs non-blocking**. Reuse is therefore real: the
channel + the chat panel are shared; A is the cheap push half, B is the
harder pull half.

This rides existing maestro primitives rather than inventing new ones:

- **Transport to the user** = the existing `_ask` / `pendingQuestion` /
  `answer()` gate (`src/core/orchestrator.mjs`), already used by planner
  clarify, loop-cap gates, and recoverable-error recovery prompts. New
  question kinds: `kind: 'operator'` and `kind: 'agent-question'`.
- **Delivery to agents** = a bus channel `operatorContext` (schema-v2 custom
  channel) auto-injected as an `optionalConsumes` input on **every** node, so
  each node's prompt `## Inputs` block carries it. Modeled on how the
  read-only `workspace` metadata channel is seeded to every node
  (`_workspaceChannel`, `src/core/orchestrator.mjs`).

## Decisions (locked during brainstorm)

1. **One shared primitive**, not two unrelated mechanisms — the operator
   channel above.
2. **B is phased.** Phase 1 = clarify-style (rides existing infra). Phase 2 =
   live `ask_user` tool (the only piece needing new IPC).
3. **Apply timing is per-message.** When a user injects context, they pick
   *apply now* (pause → re-run current node with context) or *apply next*
   (silent append; next node reads it). Default *apply next* for safety.
4. **A dedicated `contextIntake` agent** normalizes raw operator messages +
   file paths into the structured `operatorContext` channel — honoring the
   "new maestro agent" framing and keeping noisy free-form notes from
   reaching downstream agents unfiltered.

## Components

| Piece | Location | Phase |
|---|---|---|
| `operatorContext` channel definition | `src/core/channels.mjs` | 1 |
| Auto-inject `operatorContext` as optionalConsumes on every node | `src/core/orchestrator.mjs` (`_bindNodeIo`) | 1 |
| `contextIntake` agent (`.md` + `.meta.json`) | `agents/` | 1 |
| `postOperatorMessage(text, file, timing)` API + `kind:'operator'` / `kind:'agent-question'` | `src/core/orchestrator.mjs` | 1 |
| Chat panel + WebSocket events | `ui/` | 1 |
| Generic `needs-input` protocol emit/detect | `src/core/protocol.mjs`, `src/core/orchestrator.mjs` | 1 |
| `ask_user` MCP bridge | new `src/core/operator-mcp.mjs` | 2 |

## Data flow

### A — inbound, "apply next"

1. User posts a message (+ optional file path) in the chat panel.
2. Orchestrator runs the `contextIntake` agent, which appends classified
   entries (requirement / correction / file-to-read / warning, deduped) to
   the `operatorContext` channel file.
3. The next node's runner picks it up via `## Inputs`. No disruption to the
   in-flight node.

### A — inbound, "apply now"

1. User posts, picks *apply now*.
2. Orchestrator triggers `pause()` — kills the in-flight node child via
   `pauseAbort` — then runs `contextIntake`.
3. `resume()` re-enters at that node; its `## Inputs` now includes the new
   context. Reuses the resume-point machinery exactly.
4. Race guard: if the node has already finished by the time the pause lands,
   downgrade transparently to *apply next*.

### B Phase 1 — outbound, clarify-style (any agent)

1. An agent emits a `questions.json` (the same protocol shape clarify already
   uses) and exits with a `needs-input` signal.
2. Orchestrator detects it and surfaces the question via
   `_ask({ kind: 'agent-question' })` in the same chat panel — **free-text**
   answer (not forced multiple-choice).
3. The answer is folded onto `operatorContext`; the node **re-runs** with the
   answer present in `## Inputs`. This generalizes `_runClarifyNode` off the
   planner — pure reuse of the clarify emit → ask → re-feed loop.

### B Phase 2 — outbound, live `ask_user` tool

- A maestro MCP server exposes an `ask_user(question)` tool to the headless
  Claude subprocess. The call blocks the subprocess, bridges to the
  orchestrator `_ask`, and returns the reply inline — **multi-turn within one
  running node, no re-run.** This is the only component requiring new IPC;
  everything else is Phase 1 reuse.

## Error handling

- **Intake agent fails** → fall back to a raw verbatim append (never lose the
  user's note); surface a warning in the chat panel.
- **Pause/resume race on "apply now"** → reuse the existing pause sentinel +
  resume-point persistence; if the node already finished mid-pause, downgrade
  to *apply next*.
- **Phase-2 subprocess dies while blocked on `ask_user`** → reuse the
  recoverable-error gate (retry / abort).

## Testing

- **Channel injection:** unit-test `_bindNodeIo` includes `operatorContext` in
  every node's bound inputs.
- **Apply-now:** integration test — pause → intake → resume re-runs the node
  with the injected context present in its prompt.
- **B clarify-style:** a stub agent emitting `questions.json` blocks, accepts a
  free-text answer, and re-runs with the answer folded in.
- **Phase 2:** MCP `ask_user` round-trip against a mock subprocess.

## Phasing summary

- **Phase 1 (low-hanging fruit):** operator channel + `contextIntake` agent +
  chat panel + A (both timings) + B clarify-style. All on existing primitives.
- **Phase 2:** live `ask_user` MCP bridge for true multi-turn, no-re-run chat
  inside a running node.

## Out of scope

- Persisting operator chat history across separate runs of the same project
  (this design scopes the channel to a single run).
- Cross-node "broadcast" questions (a question is owned by the asking node).
- Editing/retracting an already-answered operator message.
