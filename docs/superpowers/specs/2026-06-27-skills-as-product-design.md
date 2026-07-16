# Skills as product — design

**Date:** 2026-06-27
**Status:** Approved (design); pending implementation plan.

## Problem

Maestro agents reference skills by bare name in their prose (e.g. the Art
Director "uses the `imagegen` skill"). A skill is resolved by the headless
`claude -p` child only when an agent actually invokes it mid-run, by scanning two
directories: `<cwd>/.claude/skills/` and `~/.claude/skills/`. Nothing verifies the
skill exists before the run.

Consequences:

- **Silent failure.** A missing skill yields no error — the Art Director records
  the asset as `NOT GENERATED` and the pipeline scores it a minor issue. The real
  blocker (no image) is invisible until a human inspects output.
- **Drift / per-machine fragility.** Skills live outside the repo (in
  `~/.claude/skills/`, or worse a desktop session sandbox). They are not versioned
  with maestro, so a fresh checkout, another machine, or a divergent global copy
  silently changes behavior. This is exactly the failure that motivated this work:
  `imagegen` existed only in a desktop local-agent-mode sandbox, invisible to the
  headless agents maestro spawns.

The agents run with `cwd = the target project's worktree checkout`
(`orchestrator.mjs` `workDir`). Maestro's own repo `skills/` directory is on
neither scan path, so simply committing a skill into the repo does **not** make it
reachable by agents. The sync mechanism is therefore essential, not optional.

## Goal

Make skills a versioned part of the maestro product: bundled in the repo,
declared as dependencies by the agents that need them, injected onto the agent
scan path at run time, and validated before any node runs so a missing skill is a
loud, early, actionable failure instead of a silent one.

## Non-goals (YAGNI)

- **Environment keys are out of scope.** `imagegen` still requires
  `GEMINI_API_KEY`; its script already exits with a clear 401/key error when the
  key is absent. No `requiresEnv` declaration this pass — noted as a possible
  follow-up.
- **Marketing agents stay user-layer.** The 19 marketing agents in
  `~/.maestro/agents` are not being committed. Only the new `requiresSkills` field
  is added to the two that need it. The *skill* becomes product; the marketing
  agents remain user data.
- **Bundle = `imagegen` only.** It is the single hard skill dependency across all
  agents (named by `art-director` and `visual-identity-director`). No speculative
  skills are bundled.

## Design

### A. Bundle the skill in the repo

Commit `skills/imagegen/` into the maestro repo, beside the existing
`skills/maestro/`:

```
skills/imagegen/
  SKILL.md                      (python3-corrected variant)
  scripts/generate_image.py
  assets/bevup-logo-pink.png
  assets/bevup-logo-cream.png
```

This is the single source of truth, versioned with the code. The `python` →
`python3` correction travels with it (target machines have only `python3`).

### B. Declare skill dependencies per agent

Add an optional `requiresSkills: string[]` field to the agent meta schema. Absent
or empty means no skill dependencies. Set it on the two agents that need imagegen:

```jsonc
// artDirector.meta.json, visualIdentityDirector.meta.json
"requiresSkills": ["imagegen"]
```

These two meta files currently live in the user layer (`~/.maestro/agents`); the
field is added there. The registry already merges builtin + user layers, so the
preflight gate (D) reads the field regardless of which layer an agent comes from.

The meta-schema validator / test (`test/agents-meta.test.mjs`) is updated to allow
the new field.

### C. Inject bundled skills into the worktree per run

At run start, after the pipeline's agents are resolved and the worktree checkout
exists, the orchestrator:

1. Collects the union of `requiresSkills` across all resolved agents in the active
   pipeline.
2. For each required skill name, resolves it via a shared resolver (see below).
3. For any skill that resolves to the **maestro bundle**, copies
   `skills/<name>/` recursively into `<worktree>/.claude/skills/<name>/`.

Injected copies live inside the worktree and are removed when the worktree is torn
down. Because they are copied fresh from the repo bundle on every run, there is no
drift and no global-directory pollution.

### D. Preflight validation — hard fail before any node runs

The same resolver runs as a preflight gate *before the first node executes*. If
any required skill is unresolvable, the entire pipeline aborts immediately with a
message that names the requiring agent, the missing skill, and the directories
searched. This generalizes the existing single-skill probe in `preflight.mjs`
(which today detects `graphify` and injects an instruction).

### Shared resolver

C (inject) and D (validate) share one pure resolution function — single source of
truth, table-testable. For a skill name `foo`, resolve in priority order:

1. **Maestro bundle** — `skills/foo/SKILL.md` exists → `{ source: 'bundle', path }`
   (this is the one C copies into the worktree).
2. **Personal** — `~/.claude/skills/foo/SKILL.md` exists → `{ source: 'global' }`
   (already on the scan path; nothing to copy).
3. **Project** — `<project>/.claude/skills/foo/SKILL.md` committed → `{ source:
   'project' }` (already on the scan path).
4. **None** → `{ source: null }` → unresolvable → hard fail in D.

A skill is "present for an agent" when it is on that agent's scan path
(`<worktree>/.claude/skills` after injection, or `~/.claude/skills`). Source 1
makes that true by copying; sources 2 and 3 are already true; source 4 fails.

### Data flow

```
run start
  → resolve pipeline agents (registry: builtin + user layers)
  → union(requiresSkills) across agents
  → for each skill: resolve (bundle | global | project | none)
      ├─ all resolvable → inject bundle-sourced skills into worktree/.claude/skills
      │                   → proceed to nodes
      └─ any 'none'     → ABORT, naming agent + skill + searched paths
  → nodes run; art-director calls Skill imagegen, found on cwd scan path → PNG
```

## Components and boundaries

- **`resolveSkill(name, { repoRoot, projectDir })` — pure.** Returns
  `{ source, path }`. No side effects. Testable in isolation with mock dirs.
- **`collectRequiredSkills(agents)` — pure.** Union of `requiresSkills` across
  resolved agents. Returns `string[]`.
- **`validateSkills(required, ctx)` — preflight gate.** Maps each name through
  `resolveSkill`; throws a structured error listing unresolvable `{agent, skill,
  searched[]}` entries. Used by D.
- **`injectSkills(required, ctx)` — side-effecting.** For bundle-sourced skills,
  copies into the worktree. Used by C. Runs only after `validateSkills` passes.

`validateSkills` runs before `injectSkills`; injection never runs against an
unresolvable set.

## Error handling

- Unresolvable skill → single aggregated abort error before any node runs, listing
  every missing `(agent, skill, searched paths)` so the user fixes all at once.
- Copy failure during injection (permissions, disk) → abort the run with the
  underlying error; do not start nodes with a half-injected skill dir.
- A skill resolving to `global` or `project` is trusted as-is (not copied, not
  validated for content) — consistent with how `claude -p` treats those paths
  today.

## Testing

- **Unit — `resolveSkill`:** four cases (bundle hit, global hit, project hit,
  miss), table-driven against mock directories.
- **Unit — `validateSkills`:** aborts on miss with a message naming agent + skill;
  passes when all resolvable.
- **Integration — `injectSkills`:** places `skills/imagegen` into a temp worktree
  `.claude/skills/`; teardown removes it.
- **Meta schema:** `requiresSkills` accepted by the agent-meta validator/test.
- **Smoke:** existing `MAESTRO_MOCK=1` smoke pipeline stays green (no skill
  required in the coding pipeline → no injection, no gate failure).

## Follow-ups (not this pass)

- `requiresEnv` declaration + preflight check for skills that need API keys
  (`imagegen` → `GEMINI_API_KEY`).
- Decide whether marketing agents themselves should become committed product.
