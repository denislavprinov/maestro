# Plan: Crash recovery for hard-stopped pipelines

**Goal:** A pipeline whose maestro process dies hard (`kill -9`, crash, panic, power loss) is
detected on next startup, reclassified from a stale `running` to `interrupted`, and made
resumable from the last completed step — reusing the existing pause/resume machinery.

**Non-goal:** auto-restart. The reaper only *reclassifies + leaves a resume trail*; resuming
stays an explicit user action (`maestro resume <id>` / UI button), same as a paused run.

---

## Root problem (why hard stop is unrecoverable today)

Two independent gaps:

1. **No resume trail on crash.** `resume_point` is written ONLY on graceful pause
   ([orchestrator.mjs:1237](src/core/orchestrator.mjs:1237), and the preflight fallback at
   :499). During normal forward dispatch it stays NULL. A crash leaves NULL → nothing to
   resume from.
2. **No liveness signal.** Nothing records WHICH process owns a `running` row. On crash the
   row stays `running` forever (stale). `resume()` refuses anything but `paused`
   ([orchestrator.mjs:562](src/core/orchestrator.mjs:562), [maestro.mjs:545](src/cli/maestro.mjs:545)).
   The worktree is never torn down (the `finally` never runs) — work survives on the feature
   branch checkout, but no automation reaches it.

Fix = close both gaps + a startup sweep that bridges them.

---

## Design decisions (recommended defaults)

- **Liveness = host + pid + heartbeat_at**, not PID alone. PID reuse and cross-host runs make
  bare `kill -0 pid` unsafe. Rule: a `running`/`pausing` row is *dead* iff
  (`host` == this host AND `pid` not alive) OR (`heartbeat_at` older than
  `STALE_MS`, default 90s, regardless of host). Cross-host rows are only ever reclassified by
  the stale-heartbeat arm — never PID-probed.
- **Reaper reclassifies, never auto-resumes.** `running`→`interrupted`. Keeps a human/UI in the
  loop; avoids two processes racing the same worktree.
- **Incremental resume point** persisted at every step boundary during a normal run — this is
  the core enabler. Reuse `_buildResumePoint()` verbatim (it is already JSON-safe and
  boundary-aware).
- **Reaper runs at startup only** (CLI command dispatch + UI server boot), scoped + cheap — NOT
  inside `getDb()` (opened on every command; would add contention and surprise writes).

---

## Work breakdown

### 1. Schema v9 — liveness columns
[src/core/db.mjs](src/core/db.mjs) — add `SCHEMA_V9`, bump `SCHEMA_VERSION` to 9, add the
`if (current < 9) db.exec(SCHEMA_V9)` ladder rung.

```js
const SCHEMA_V9 = `
ALTER TABLE pipelines ADD COLUMN owner_pid    INTEGER;
ALTER TABLE pipelines ADD COLUMN owner_host   TEXT;
ALTER TABLE pipelines ADD COLUMN heartbeat_at TEXT;
`;
```

Legacy rows stay NULL → treated as "unknown owner": reclassified only via the stale-heartbeat
arm (NULL heartbeat = infinitely stale), never PID-probed. Safe.

### 2. Claim ownership + heartbeat (orchestrator)
[src/core/orchestrator.mjs](src/core/orchestrator.mjs)

- On `run()` / `resume()` right after `_setStatus('running')`: stamp
  `owner_pid=process.pid`, `owner_host=os.hostname()`, `heartbeat_at=now` onto the row.
- Start a heartbeat timer (≈30s, well under `STALE_MS`) that updates `heartbeat_at` while
  status is `running`/`pausing`. `unref()` it so it never holds the process open. Clear it in
  the `run()`/`resume()` `finally`.
- On clean terminal status (`done`/`stopped`/`error`/`paused`): clear the three columns (NULL)
  in the final persist, so a finished row is never a reaper candidate.

Add the three fields to the persist UPSERT in
[artifacts.mjs](src/core/artifacts.mjs) (the `upsertPipeline`/state-write path, alongside
`resume_point`).

### 3. Persist resume point incrementally (the enabler)
[src/core/orchestrator.mjs](src/core/orchestrator.mjs) `_dispatch` loop — after each step
completes and the pointer advances (around the `if (!rewound) i += 1` at
[:1233](src/core/orchestrator.mjs:1233)), set
`this.state.resumePoint = this._buildResumePoint({ plan, stepIndex: <next i>, stepCycle, loopState, bus })`
and `await this._persist()`.

- Reuse `_buildResumePoint` unchanged; `kind` resolves to `boundary` mid-run (no `_pauseGate`,
  no paused node).
- This means a normal `running` row now ALWAYS carries a valid boundary resume point for the
  next-to-run step. Crash → that point is the recovery position.
- On clean completion the existing `done` path already overwrites status; also NULL the
  resume_point there so a finished row is not resumable (mirrors today's pause-consumed clear).

> Edge: a crash *mid-step* loses that step's in-flight work, resume re-runs the whole step from
> its boundary. Acceptable — matches pause-at-boundary semantics. The session_id captured per
> step (v5) still lets the re-run `--resume` the Claude session where possible.

### 4. The reaper
New `src/core/reaper.mjs`:

```js
// reapInterruptedPipelines({ host, now, staleMs }) -> { reaped: string[] }
// Find rows WHERE status IN ('running','pausing'); for each, if isDead(row) flip to
// 'interrupted' (keep resume_point, owner_* cleared). Pure-ish: takes a db handle + clock.
```

- `isDead(row)`: `(row.owner_host === host && !pidAlive(row.owner_pid))` OR
  `(heartbeat_at == null || age(heartbeat_at) > staleMs)`.
- `pidAlive(pid)`: `try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }`
  (EPERM = alive but not ours).
- Single UPDATE per reaped row inside one transaction; idempotent.
- `interrupted` is a new terminal-ish status (resumable). Add it to any status enums / UI
  filters that whitelist statuses.

### 5. Allow resume of `interrupted`
- [orchestrator.mjs:562](src/core/orchestrator.mjs:562) `resume()`: accept
  `row.status === 'paused' || row.status === 'interrupted'`.
- [maestro.mjs:545](src/cli/maestro.mjs:545) `cmdResume`: same widening + message tweak.
- Worktree-missing guard already exists (`worktree missing: … — cannot resume`,
  [orchestrator.mjs:591](src/core/orchestrator.mjs:591)); on a crashed run the worktree was
  NOT torn down, so it should still be present. If absent → surface "cannot resume; work was on
  branch <feature>" and leave the row `interrupted`.

### 6. Wire the sweep at startup
- CLI: call `reapInterruptedPipelines()` once at the top of command dispatch in
  [src/cli/maestro.mjs](src/cli/maestro.mjs) `main`, after DB is reachable, before handling the
  subcommand. Log a one-line `reaped N interrupted pipeline(s)` when N>0.
- UI: call it on server boot in [ui/server.mjs](ui/server.mjs) (and surface `interrupted` rows
  in the History/Running lists with a Resume affordance — likely already rendered if the status
  filter is widened in step 4).

### 7. UX surfacing
- `maestro list` / status output: show `interrupted` distinctly with the resume hint
  (`maestro resume <id>`).
- UI: an `interrupted` chip + Resume button reusing the existing `/api/resume` path.

---

## Tests

- `test/reaper.test.mjs` (new): seed rows — live-pid same host (kept), dead-pid same host
  (reaped), fresh heartbeat other host (kept), stale heartbeat (reaped), NULL owner legacy
  (reaped via stale arm), already-terminal `done`/`error` (untouched). Inject host/now/staleMs.
- `test/orchestrator-recovery.test.mjs` (extend): after N steps run, assert the row carries a
  `boundary` resume_point mid-run; simulate crash (drop the orchestrator without clean exit) →
  reaper flips to `interrupted` → `resume()` continues from the boundary to `done`.
- Heartbeat: assert columns set on run start, advanced by the timer, NULLed on terminal status.
- Migration: open a v8 DB, migrate, assert v9 columns exist and existing rows are NULL.

---

## Sequencing / risk

1. Schema v9 (mechanical, additive). 2. Heartbeat + ownership. 3. Incremental resume point
   (highest value, lowest new surface — reuses `_buildResumePoint`). 4. Reaper module + tests.
   5. Widen resume to `interrupted`. 6. Startup wiring (CLI then UI). 7. UX polish.

Steps 1–3 alone already make a crashed run *recoverable in principle* (a valid resume_point
exists; you could manually flip status). 4–6 automate detection. Ship 1–3 first if you want the
safety net fast, 4–7 as the ergonomics layer.

**Main risk:** double-ownership — a reaper reclassifies a row whose process is actually alive
(PID reuse, clock skew). Mitigations: host-scoped PID probe; conservative `STALE_MS` (90s ≫ 30s
heartbeat); reaper only sets `interrupted` (resumable, non-destructive) and never touches the
worktree — so even a false positive costs nothing until a human explicitly resumes.
