---
name: orchestrate
description: Run the deterministic multi-agent orchestrator (Plan -> Refine -> Implement -> Review) over a software task in the current project. Triggers on "/maestro", "/maestro <prompt>", "/maestro --ui", and on requests to orchestrate, run the orchestration pipeline, or drive Claude Code through plan/refine/implement/review for a task.
---

# Orchestrate

Drive the current project through the orchestrator pipeline: **Preflight -> Plan -> Refine (loop) -> Implement -> Review (loop) -> Done**. Orchestration is performed by a deterministic Node.js script; this skill just launches it. Artifacts (plans, reviews, pipeline audit logs) are written under `ai-artifacts/` in the project.

The orchestrator repo lives wherever it was installed. `/Users/bulibas/dev/repo/maestro` below is the absolute path of that repo (the directory containing `src/cli/maestro.mjs`). If you installed via `scripts/install.mjs`, the installer rewrites `/Users/bulibas/dev/repo/maestro` in this file to the real path automatically; otherwise substitute it yourself (or set an `MAESTRO_REPO` environment variable and use `"$MAESTRO_REPO"`).

## /maestro <prompt> — run the pipeline (default action)

When invoked as `/maestro <prompt>`, run the CLI with the user's text as the prompt and the user's current project as the working directory:

```bash
node /Users/bulibas/dev/repo/maestro/src/cli/maestro.mjs --project "$PWD" --prompt "<args>"
```

- `--project "$PWD"` — operate inside the user's current project (the orchestrator does all file writes here).
- `--prompt "<args>"` — everything the user typed after `/maestro`. Quote it.
- The CLI streams phase changes and live agent logs to the terminal. When the planner needs a decision it shows 3 options plus a free-text field; when a refine/review loop hits its cap it shows the open critical/major issues and asks whether to continue or approve another cycle. Answer interactively.
- On completion it prints the pipeline directory under `ai-artifacts/pipelines/`.

Useful flags (pass through when the user asks):
- `--file <path.md>` — use a markdown file as the prompt instead of `--prompt`.
- `--title "<name>"` — label the pipeline.
- `--max-refine <N>` / `--max-review <N>` — change loop caps (default 5 each).
- `--model <m>` / `--permission-mode <m>` — Claude model / permission mode (default `acceptEdits`).
- `--mock` — run the full pipeline offline with canned agents (no Claude spawn, no tokens); great for a dry run. Equivalent to setting `MAESTRO_MOCK=1`.
- `--yes` / `--non-interactive` — auto-answer (clarify picks the first option; gates choose "continue"). Use for unattended runs.

Example:

```bash
node /Users/bulibas/dev/repo/maestro/src/cli/maestro.mjs \
  --project "$PWD" --prompt "Add rate limiting to the public API"
```

## /maestro --ui — launch the web UI

To start the web app (new-pipeline form, step tracker, live log window, question + loop-gate panels, Stop button, run history):

```bash
node /Users/bulibas/dev/repo/maestro/src/cli/maestro.mjs --ui
```

This starts `ui/server.mjs` (Express + WebSocket, default port `4317`; set `PORT` to change). Open the printed URL in a browser. In the UI you pick the project folder to operate in, supply a prompt OR a markdown document (plus optional extra files), optionally toggle mock mode, and Start. The UI also has an "Install agents into this folder" button.

## Installing the agents + skill into another project

So a teammate can open Claude Code in their own repo and type `/maestro <prompt>`, copy the agents and this skill into that project's `.claude/`:

```bash
node /Users/bulibas/dev/repo/maestro/scripts/install.mjs "<targetDir>"
```

- Copies `agents/*.md` into `<targetDir>/.claude/agents/` and `skills/maestro/` into `<targetDir>/.claude/skills/maestro/`.
- Add `--force` to overwrite existing copies.
- Prints a next-step hint. After installing, open Claude Code in `<targetDir>` and run `/maestro <prompt>`.
- You can also trigger this from the CLI (`--install <targetDir>`) or the UI ("Install agents into this folder").

## Notes
- The orchestrator auto-initializes a git repo in the target project (initial commit) if none exists, so the reviewer can diff the implementation.
- Preflight auto-detects `graphify` and `code-review-graph`; if both are present it always uses graphify and tells the agents to ground their work in it.
- Prefer `--mock` first if you just want to see the pipeline run end-to-end without spending tokens.
