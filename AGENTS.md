# AGENTS.md — Shared Protocol for Claude Code & Cursor

Single source of truth for how the two AI agents collaborate on this project. Both agents must read this before starting work. Anything here applies to **both** agents — agent-specific rules belong in `CLAUDE.md` (Claude only) or a Cursor-specific file, not here.

## Project pointer

**Upside** is a mobile-first PWA portfolio intelligence layer for Interactive Brokers. The product spec is `UPSIDE_MVP_SPEC.md` (frozen reference). Work batches are declared in `BUILD_QUEUE.md`. Active and historical claim state is in `CLAIMS.md`. This file does not duplicate any of those.

## Repo & branches

- `dev` — shared working branch. Both agents commit directly. Always `git pull --ff-only origin dev` before claiming.
- `prod` — promoted snapshot of `dev` once stable. Only the user merges into `prod`.
- No feature branches in the normal flow.

## File ownership

| File | Owner | Notes |
|---|---|---|
| `UPSIDE_MVP_SPEC.md` | user | Frozen reference. Agents may propose `spec:` edits but should not freelance changes. |
| `BUILD_QUEUE.md` | user | Declares the work. The user updates it by pasting their offline working copy, so agents must **never** write state into it. Status tags like `[READY]` / `[PENDING]` reflect user intent only. |
| `CLAIMS.md` | agents | Records active claims and completion log. The user does not normally edit this. |
| `AGENTS.md`, `CLAUDE.md` | shared | Either party may edit; use `meta:` commits. |
| `client/`, `server/`, etc. | shared | Use `batch-N:` commits when working on a claimed batch. |

## The work queue

`BUILD_QUEUE.md` declares each batch with a `[READY]` or `[PENDING]` tag in its heading:
- `[READY]` — designed; eligible to be claimed.
- `[PENDING]` — still being designed; do not start.

The queue itself carries **no** Owner / Started / Finished / Status fields — those live in `CLAIMS.md`. The user may overwrite `BUILD_QUEUE.md` at any time without breaking agent state.

Multiple batches can be in progress simultaneously when their "Files this batch creates/edits" + "Does NOT touch" declarations confirm they don't overlap. When two batches do touch overlapping files, run them sequentially.

## The claims file

`CLAIMS.md` has two sections:

- `## In progress` — one entry per actively claimed batch.
- `## Completed` — log of finished batches, newest at the top.

Entry format:

```
### Batch N — <short title>
- Owner: claude | cursor
- Started: YYYY-MM-DD HH:MM
- Finished: YYYY-MM-DD HH:MM        (only in Completed)
- Commit: <short SHA of the work commit>   (only in Completed)
- Handoff note: ...                  (only when mid-batch handoff occurred)
```

## Claim protocol

1. `git pull --ff-only origin dev`. If it fails, resolve before claiming.
2. Open `BUILD_QUEUE.md` and pick a batch tagged `[READY]` that is not already listed in `CLAIMS.md` `## In progress` or `## Completed`. If you're considering working in parallel with the other agent, confirm "Files this batch creates/edits" doesn't overlap with any in-progress batch.
3. Edit `CLAIMS.md`: add an entry under `## In progress`:
   ```
   ### Batch N — <title>
   - Owner: claude   (or cursor)
   - Started: YYYY-MM-DD HH:MM
   ```
4. Commit `meta: claim batch-N (claude)` and `git push origin dev`.
5. Do the work. Commit incrementally with `batch-N: <imperative description>` messages and push at sensible checkpoints.

## Finish protocol

1. Make the final work commit and push. Note its short SHA.
2. Edit `CLAIMS.md`: move the batch's entry from `## In progress` to the top of `## Completed`, adding:
   - `Finished: YYYY-MM-DD HH:MM`
   - `Commit: <short SHA of the final work commit>`
3. Commit `meta: complete batch-N` and push.
4. Decide: claim the next `[READY]` batch (re-run claim protocol) or stop. Either is fine.

## Mid-batch handoff (rare)

If you must stop before finishing:

1. Edit the batch's entry in `CLAIMS.md` `## In progress`:
   - Change `Owner:` to `none`.
   - Add a `Handoff note:` line describing what's done, what's left, files touched, gotchas.
2. Commit `meta: handoff batch-N` and push.

The next agent runs the claim protocol but only updates `Owner:` (Started stays as the original timestamp).

## Stale-claim recovery

If a batch has been `## In progress` with no new commits for >24h and the other agent wants to take over:

1. Update `Owner:` in the existing entry; add a `Reclaim note:` line explaining why.
2. Commit `meta: reclaim batch-N from <prior owner>` and push.

Use sparingly — prefer to wait or ping the user.

## Commit message convention

| Prefix | When to use |
|---|---|
| `batch-N: <imperative>` | Code/asset change toward batch N |
| `meta: claim batch-N (<agent>)` | Claiming a batch |
| `meta: complete batch-N` | Marking a batch done in `CLAIMS.md` |
| `meta: handoff batch-N` | Mid-batch hand-off (Owner cleared) |
| `meta: reclaim batch-N from <prior owner>` | Stale-claim recovery |
| `meta: <other>` | Changes to `AGENTS.md`, `CLAUDE.md`, `CLAIMS.md` structure (not entries), tooling, lint config |
| `spec: <change>` | Edits to `UPSIDE_MVP_SPEC.md` |

`git log --oneline` is the change log — there is no separate `CHANGELOG.md`.

## Editing rules

- Treat `BUILD_QUEUE.md` and `UPSIDE_MVP_SPEC.md` as user-owned. Don't write claim/state into them. If you need a `spec:` edit, propose it; the user may accept it or replace your version on the next paste.
- Anyone may add new entries to `CLAIMS.md`, but only the current Owner of a batch should mutate that batch's entry (except for stale-claim recovery).
- Always `git pull` before claiming so you don't race the other agent.

## What does NOT belong in this file

- The product spec, file paths for components, design tokens — all in `UPSIDE_MVP_SPEC.md`.
- The batch list — in `BUILD_QUEUE.md`.
- Per-batch state, timestamps, ownership — in `CLAIMS.md`.
- Per-language style guides — create a `STYLE.md` later if needed.
- Agent-specific quirks — Claude-only goes in `CLAUDE.md`, Cursor-only in a Cursor file. If a rule applies to both, it belongs **here**.
