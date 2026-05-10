# AGENTS.md — Shared Protocol for Claude Code & Cursor

This is the single source of truth for how the two AI agents working on this project (Claude Code and Cursor) collaborate. Both agents must read this before starting any work. Anything in this file applies to **both** agents — agent-specific rules belong in `CLAUDE.md` (Claude only) or a Cursor-specific file, not here.

## Project pointer

**Upside** is a mobile-first PWA portfolio intelligence layer for Interactive Brokers. The full product spec is `UPSIDE_MVP_SPEC.md` — treat it as the frozen reference. Operational work is tracked in `BUILD_QUEUE.md`. This file does not duplicate either of those; if you need spec details, read the spec.

## Repo & branches

- `dev` — the shared working branch. Both agents commit directly to `dev`. Always `git pull --ff-only origin dev` before claiming a batch.
- `prod` — a promoted snapshot of `dev` once stable. Only the user merges into `prod`. Agents do not touch `prod`.
- No feature branches in the normal flow. Hand-off is sequential (one agent at a time per batch), so a linear `dev` history is the goal.

## The work queue

`BUILD_QUEUE.md` is the live state of all work.

- Process batches in FIFO order unless a batch is explicitly marked otherwise.
- A batch is **locked** once `Status: IN PROGRESS`. Scope edits to a locked batch must go into a new batch appended at the bottom.
- Every batch carries four state fields:
  - `Status:` — `READY` | `PENDING` | `IN PROGRESS` | `DONE`
  - `Owner:` — `none` | `claude` | `cursor`
  - `Started:` — timestamp (`YYYY-MM-DD HH:MM`) or `—`
  - `Finished:` — timestamp or `—`

## Claim protocol

When you (Claude or Cursor) decide to work on the next batch:

1. `git pull --ff-only origin dev`. If it fails, resolve before claiming — never claim against stale state.
2. Open `BUILD_QUEUE.md` and find the next `READY` batch. Confirm `Owner: none`.
3. Edit that batch:
   - `Status: IN PROGRESS`
   - `Owner: claude` (or `cursor`)
   - `Started: YYYY-MM-DD HH:MM` (local time; no timezone needed)
4. Commit: `meta: claim batch-N (<agent>)`. Push to `origin dev`.
5. Now do the work. Commit incrementally with `batch-N: <imperative description>` messages. Push at sensible checkpoints so the other agent (and the user) can see progress.

## Finish protocol

When the batch's work is complete:

1. Make the final work commit.
2. Edit the batch in `BUILD_QUEUE.md`:
   - `Status: DONE`
   - `Owner: none`
   - `Finished: YYYY-MM-DD HH:MM`
   - Move the entire batch (state fields + scope/instructions/deliverables) verbatim under the `## Completed` section. Do not rewrite or summarize.
3. Commit: `meta: complete batch-N`. Push.
4. Decide: claim the next `READY` batch (re-run the claim protocol) or stop. Either is fine — the other agent can pick up next.

## Hand-off mid-batch (rare)

If you must stop before finishing:

1. Leave `Status: IN PROGRESS` (the batch is still claimed for someone), but set `Owner: none`.
2. Add a `**Handoff note:**` line directly under the state fields, describing: what's done, what's left, any gotchas, files touched.
3. Commit: `meta: handoff batch-N`. Push.

The next agent runs the claim protocol — sets `Owner` to themselves; `Status` is already `IN PROGRESS`.

## Stale-claim recovery

If a batch has been `IN PROGRESS` with no new commits for >24h and the other agent wants to take over:

1. Reclaim by editing `Owner` to yourself and adding a `**Reclaim note:**` line explaining why.
2. Commit: `meta: reclaim batch-N from <prior owner>`. Push.

Use sparingly — prefer to wait or ping the user.

## Commit message convention

| Prefix | When to use |
|---|---|
| `batch-N: <imperative>` | Any code/asset change toward batch N |
| `meta: claim batch-N (<agent>)` | Claiming a batch |
| `meta: complete batch-N` | Marking a batch DONE |
| `meta: handoff batch-N` | Mid-batch hand-off (Owner cleared, Status still IN PROGRESS) |
| `meta: reclaim batch-N from <prior owner>` | Stale-claim recovery |
| `meta: <other>` | Changes to `AGENTS.md`, `CLAUDE.md`, `BUILD_QUEUE.md` structure, tooling, lint config, etc. |
| `spec: <change>` | Edits to `UPSIDE_MVP_SPEC.md` |

`git log --oneline` is the change log — there is no separate `CHANGELOG.md`. Keep messages short and imperative.

## Editing rules

- While a batch is `IN PROGRESS`, only the current `Owner` may modify its scope. Other agents may still add comments at the bottom of the queue or open new batches.
- Anyone may append new batches at the bottom of the queue at any time.
- The user may edit anything anytime. Always `git pull` before claiming so you don't overwrite their edits.
- Don't reorder existing batches without a `meta:` commit explaining why.

## What does NOT belong in this file

- The product spec, file paths for components, design tokens — all in `UPSIDE_MVP_SPEC.md`.
- Per-language style guides — create a `STYLE.md` later if needed.
- Agent-specific quirks — Claude-only goes in `CLAUDE.md`, Cursor-only goes in a Cursor file. If a rule applies to both, it belongs **here**.
