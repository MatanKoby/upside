---
name: spec-edit
description: Use before editing any file under `spec/**`, or when persisting a design/spec decision the user has just made. Encodes concern-matching via per-folder README, size-watch, cross-reference rule, archive rule, propagation to `BUILD_QUEUE.md`, and the per-folder README pattern.
---

# Edit the spec (or persist a design decision)

The full procedure. AGENTS.md carries only the 2-line policy pointer to this file.

## Decide where to write — concern-matching

The spec lives in `spec/`, split into root files + two sub-folders. Open the relevant index **first** — don't read the whole spec:

- Top-level architecture / flows / schema / job-queue / roadmap / archive — see `spec/README.md`.
- Anything signal-generation related — see `spec/signals/README.md` (one file per signal concern).
- Anything UI / screen related — see `spec/screens/README.md` (one file per screen + the shared design system).

Pick the **single** file whose concern matches the change. If the change naturally crosses multiple files, that's a signal the concern might be miscarved — **flag it before duplicating content**. Surface the carving question to the user; don't just write to both files.

## Cross-reference, don't restate

When file A needs to refer to a concept that lives in file B, link by **file path** — e.g.

```
see `schema.md` → Supabase Schema
see `signals/zone.md`
see `screens/ticker-detail.md` → Refresh policy
```

Don't restate the concept. Restating creates a second source of truth that will drift.

## Move stale content to `archive.md`

The spec describes the **current intended design**, not the history. When a section stops reflecting live code — an abandoned approach, a removed table, a deprecated flow — move it to `spec/archive.md` rather than leaving it inline. Keep `archive.md` as the institutional memory; everything else is current.

## Size watch

When the file you're editing is heading toward >20k tokens (~600 lines), consider whether the next bite of content wants its own file. Per-folder READMEs (`spec/signals/README.md`, `spec/screens/README.md`) are the index pattern — when a sub-concern grows enough to warrant a file, add it and update the README.

## Persisting a design decision the user just made

A decision lives in two places: the **spec** (durable design) and the **queue** (work that flows from it). The transcript is not durable — if you don't write it down, a future agent will re-litigate it or silently contradict it.

**Decision made with the user (working session):**

1. Update the relevant file(s) in `spec/` to reflect the new design, with a `spec:` commit. Match the change to the file's concern.
2. Update `BUILD_QUEUE.md`: revise the relevant in-flight batch, or add new batches that flow from the decision, with a `meta:` commit. Per `feedback_queue_state_separation`, **never** put claim state (Owner / Started / Finished) into `BUILD_QUEUE.md` — that lives in `CLAIMS.md` only. The queue holds *design intent*; the claims file holds *execution state*.
3. Then proceed to implementation.

**Decision encountered mid-execution (no user input yet):**

The agent must **not** quietly make and persist the decision. Instead:

1. Surface it to the user — describe the choice and the tradeoffs.
2. Wait for the user's call.
3. Once decided, follow the working-session flow above.

Scope: this applies to **design/spec** — architecture, data model, public behavior, batch scope. Day-to-day implementation forks (library choice, internal file naming, refactor shape) stay agent discretion.

## Commit convention

| Prefix | When |
|---|---|
| `spec: <change>` | Edits to any `spec/*.md` file |
| `meta: <change>` | Edits to `BUILD_QUEUE.md`, `CLAIMS.md` structure (not entries), `AGENTS.md`, tooling |
| `batch-N: <change>` | Code/asset changes toward batch N |

A spec edit + a queue revision flowing from the same decision are normally two separate commits (`spec: ...` then `meta: ...`), but one combined commit is fine when the change is small and unambiguous (e.g. `spec + queue: M1 — expand scope to skills`).

## Per-folder README pattern

When a sub-folder gets dense enough to warrant its own index, add a `README.md` at the folder root listing one line per file with its concern. This lets the top-level `spec/README.md` stay slim — root files + pointer to each sub-folder README — instead of carrying every file's description directly.

When adding a new file to a sub-folder, **update its README** in the same commit. The README is the routing surface for the next agent's reads.
