# Maestro

A **deterministic multi-agent pipeline** that drives Claude Code (headless) through
**Plan -> Refine -> Implement -> Review** for a software task. It ships three ways to
run the same pipeline: a **CLI**, an installable **`/maestro` skill**, and a **web
UI**.

Plain Node.js ESM (`.mjs`), Node `>=18`. Minimal dependencies: `express` + `ws` only.
The frontend is vanilla HTML/CSS/JS — no framework, no build step.

> The full, binding contract for every module, event, and on-disk file lives in
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Read it before changing any signature.

---

## What it is

You give the orchestrator a **project folder** and a **prompt** (or a markdown brief).
A deterministic state machine then runs the agents of the selected workflow in sequence, looping until the work
clears quality gates:

1. **Planner** writes an initial plan (with code snippets) and, instead of *assuming*
   anything, asks you conceptual questions — each with **3 options plus a free-text
   field**. The Q&A is appended to the plan so reviewers see it.
2. **Plan Refiner** reviews the plan (including its code snippets), writes a refined
   `-v2`, `-v3`, ... and re-runs until only minor/suggestion issues remain (or you
   approve continuing past the cycle cap).
3. **Implementer** follows the latest plan with no deviation, using TDD
   (red-green-refactor).
4. **Code Reviewer** reviews the git diff, writes a review, and hands back to the
   implementer to fix — looping Implement -> Review until only minor/suggestion issues
   remain (or you approve continuing past the cap).

Everything is saved as markdown + JSON in a **machine-wide external store** (default
`~/.maestro/store/<projectKey>/`), keyed by repo identity and kept **outside your
project's working tree**, so history is never committed to your repo. See
[Artifact layout](#artifact-layout) for details.

### Preflight tooling

Before planning, the orchestrator probes for optional graph tools and, if present,
tells the agents to use them:

- [`graphify`](https://github.com/safishamsi/graphify)
- [`code-review-graph`](https://github.com/tirth8205/code-review-graph)

If **both** are installed, it **always uses graphify**. All probes fail safe — a
missing tool never breaks a run.

---

## Install

```bash
npm install
```

Requires Node `>=18` and the `claude` CLI on your `PATH` for real (non-mock) runs.

---

## Quick start

### CLI

Run a pipeline against a project folder:

```bash
npm run cli -- --project /path/to/your/project --prompt "Add a /search endpoint"
```

Or use a markdown brief as the prompt:

```bash
npm run cli -- --project /path/to/your/project --file ./brief.md --title "Search feature"
```

Useful flags: `--model <m>`,
`--permission-mode <m>`, `--yes`/`--non-interactive` (auto-answer clarify with the
first option and gates with "continue"). See `docs/ARCHITECTURE.md` §4.1 for the full
list.

### Web UI

```bash
npm start
```

Then open the printed URL (default `http://localhost:4317`). The UI lets you:

- start a run from a **prompt or markdown document**, pointed at any **project folder**,
  with optional extra files;
- watch a **steps tracker** (preflight / plan / refine #N / implement / review #N /
  done);
- answer **clarify questions** (3 options + free text) and **loop gates** ("Don't have
  another cycle and continue" / "I approve another cycle", with the open critical/major
  issues shown);
- follow a **live streaming log**;
- **Stop** a run;
- browse **history** of past pipelines and read their saved markdown.

There's also an **"Install agents into this folder"** button that copies the agents +
skill into a target project so you can use `/maestro` there.

### `/maestro` skill (inside your own project)

Copy the agents and the skill into your project's `.claude/`:

```bash
npm run install:agents -- /path/to/your/project
# or: node scripts/install.mjs /path/to/your/project [--force]
```

Then open Claude Code in that project and run:

```
/maestro Add a /search endpoint with pagination
```

The skill starts the same deterministic orchestrator script.

### Mock demo (offline, no tokens)

The whole pipeline can run **fully offline** without spawning `claude` — it produces
real artifact files using a deterministic mock:

```bash
npm run smoke
```

This is equivalent to:

```bash
MAESTRO_MOCK=1 node src/cli/maestro.mjs --project examples/sandbox --prompt "demo task" --mock --yes
```

Set `MAESTRO_MOCK=1` (or pass `--mock`) on any run to use the mock path.

---

## The agents

| Agent | File | Role |
| --- | --- | --- |
| Planner | `agents/maestro-planner.md` | Initial plan with code snippets; asks conceptual questions (3 options + free text) instead of assuming; appends Q&A to the plan. |
| Plan Refiner | `agents/maestro-plan-refiner.md` | Reviews + refines the plan (and its code snippets); writes `-vN`; emits a severity-tagged review per cycle. |
| Plan Review | `agents/maestro-plan-reviewer.md` | Reviews the plan (without rewriting it); writes review markdown + JSON; on blocking issues bounces back to the planner for a cold re-plan. |
| Implementer | `agents/maestro-implementer.md` | Follows the latest plan with no deviation; TDD red-green-refactor; also runs in "fix" mode against a review. |
| Code Reviewer | `agents/maestro-code-reviewer.md` | Reviews the git diff; writes review markdown + JSON; hands back to the implementer to fix. |

Maestro now ships **7 runnable agents** and the agent system is **data-driven**:
each agent is a prompt (`agents/maestro-<role>.md`) plus a metadata sidecar
(`agents/<key>.meta.json`), so new agents drop in without engine edits. Beyond
the five above, it adds **Manual Tests Checklist** (drafts manual test cases) and
**Manual web UI testing** (runs them against the live web UI via Playwright and
emits a pass/fail verdict). To add your own, see
[`docs/ADDING-AGENTS.md`](docs/ADDING-AGENTS.md).

---

## The phases and loops

- **Clarify** — planner asks one round of conceptual questions (up to four) before
  planning; answers are persisted and appended to the plan.
- **Refine loop** — Refiner runs repeatedly. It stops when no `critical`/`major` issues
  remain. Past the loop's **max cycles** (default 3) it asks you to **continue** or approve
  **another** cycle, escalating indefinitely.
- **Review loop** — Reviewer -> Implementer(fix) -> Reviewer ... stops when no
  `critical`/`major` issues remain. Past the loop's **max cycles** (default 3) it asks the
  same continue/another gate.

Each feedback loop's max-cycle count is set per loop in the New Pipeline window's
**Pipeline configuration** (default 3), not via a CLI flag.

A run is "blocked" only by `critical` or `major` issues; `minor`/`suggestion` issues do
not hold up the loop.

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

---

## Artifact layout

Plans, reviews, and pipeline history do **not** live in your project — they are written
to a single **machine-wide external store** outside every project's working tree, so
nothing is ever committed to your repo:

```
<maestroHome>/store/<projectKey>/
  meta.json     project name + canonical path (for the "All projects" view)
  plans/        <DD-MM-YY>-<name>.md, -v2.md, -v3.md ...   (plans + refinements)
  reviews/      <DD-MM-YY>-<name>-impl-review.md           (implementation reviews)
  pipelines/    <DD-MM-YY>-<slug>-<id>/                    (one folder per run)
    prompt.md            the prompt text (or copied markdown brief)
    extras/              any optional extra files you attached
    clarify.json         planner's open questions (3 options + free text each)
    clarify-answers.json your answers
    refine-review-cycle1.json  per-cycle refiner review JSON (one per refine cycle)
    impl-review-cycle1.json    per-cycle code-reviewer review JSON (one per review cycle)
    state.json           machine-readable run state snapshot
    pipeline.md          human-readable audit log (history view reads this)
```

- **`<maestroHome>`** = `<base>/.maestro`, where `<base>` is `MAESTRO_HOME` if set, else
  the persisted "Maestro root folder" from Settings, else your OS home. By default this
  is `~/.maestro`, so the store lives at `~/.maestro/store/`.
- **`<projectKey>`** = `<repo-basename-slug>-<sha1(canonicalRoot)[:8]>`, derived from the
  repository's identity (the parent of its shared `.git`). It is **stable across all git
  worktrees of the same repo**, so every worktree shares one history.

Because history is machine-wide and keyed by repo identity, the web UI adds an **"All
projects"** view (and `GET /api/history`) that lists runs across every project on the
machine. There is **no migration**: any old `<projectDir>/ai-artifacts/` directories
from before this change are simply left in place and no longer used.

The exact JSON shapes are specified in `docs/ARCHITECTURE.md` §5.

---

## Project structure

```
src/core/        protocol, store, artifacts, preflight, claude-runner, phases, orchestrator
src/cli/         orchestrate.mjs (CLI entry)
scripts/         install.mjs (copy agents + skill into a target project)
agents/          agent prompts + .meta.json sidecars (data-driven set)
skills/          orchestrate/SKILL.md (the /maestro skill)
ui/              server.mjs + public/ (single-page web UI)
docs/            ARCHITECTURE.md (single source of truth)
```

Generated plans, reviews, and pipeline run folders are **not** part of this repo: they
live in the machine-wide external store at `<maestroHome>/store/<projectKey>/` (default
`~/.maestro/store/...`). See [Artifact layout](#artifact-layout).
