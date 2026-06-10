# AGENTS.md — Shared Protocol for Claude Code & Cursor

Single source of truth for how the two AI agents collaborate on this project. Both agents must read this before starting work. Anything here applies to **both** agents — agent-specific rules belong in `CLAUDE.md` (Claude only) or a Cursor-specific file, not here.

## Project pointer

**Upside** is a mobile-first PWA portfolio intelligence layer for Interactive Brokers. Product spec: see `spec/README.md` for the file map. Work batches: `BUILD_QUEUE.md` (un-done) + `BUILD_QUEUE_DONE.md` (history). Active and historical claim state: `CLAIMS.md` (recent) + `CLAIMS_DONE.md` (archive).

Claude web is used as a read-only **ideation surface** upstream of the queue — it raises ideas and research leads, it does not execute. See "Ideation handoff (Claude web → code)" below.

## Repo & branches

- `dev` — shared working branch. Both agents commit directly. Always `git pull --ff-only origin dev` before claiming.
- `prod` — promoted snapshot of `dev` once stable. Only the user merges into `prod`.
- No feature branches in the normal flow.

## File ownership

| File | Owner | Notes |
|---|---|---|
| `spec/**` | user | Frozen reference. Agents may propose `spec:` edits but should not freelance changes. See `spec/README.md` for the file map; invoke the `spec-edit` skill before editing. |
| `BUILD_QUEUE.md` | user | Declares the work. The user updates it by pasting their offline working copy, so agents must **never** write state into it. Status tags like `[READY]` / `[PENDING]` reflect user intent only. |
| `BUILD_QUEUE_DONE.md` | shared archive | One-paragraph summaries of completed batches. Append on finish. |
| `CLAIMS.md` | agents | Records active claims + the most recent completed batches. The user does not normally edit this. |
| `CLAIMS_DONE.md` | agents | Older completed entries archived from `CLAIMS.md`. Reference-only. |
| `AGENTS.md`, `CLAUDE.md` | shared | Either party may edit; use `meta:` commits. |
| `client/`, `server/`, etc. | shared | Use `batch-N:` commits when working on a claimed batch. |

## Spec layout

The spec lives in `spec/`, split across root files + two sub-folders. **See `spec/README.md` for the full file map.** Don't read the whole spec on every turn — pull only the files relevant to the work in front of you, and start from the per-folder README (`spec/signals/README.md`, `spec/screens/README.md`) when reading into a sub-folder.

For the editing protocol (concern-matching, cross-reference rule, archive rule, propagation to `BUILD_QUEUE.md`, persisting design decisions), invoke the **`spec-edit` skill** — its body is the procedure. **Policy:** design decisions made with the user must be persisted to `spec/**` and `BUILD_QUEUE.md` before moving on; the transcript is not a substitute.

## Protocol reliability (in design)

This whole protocol currently lives as prose and is honor-system — nothing *enforces* that the right skill fires at the right time, and a skipped step (an unwritten batch, a missed `finish-batch`) surfaces only if a human notices. The design brief for closing that gap — executable invariants (`bin/protocol-check`), layered enforcement (Claude hooks → git hooks → CI), an observability trail, and a possible repo-agnostic npm spinoff — is in [`docs/process/agent-discipline.md`](docs/process/agent-discipline.md); the work is queued as **Batch PROC** in `BUILD_QUEUE.md`.

## Ideation handoff (Claude web → code)

Claude web is an **ideation and research surface**, not an executor. It has no repo access, never claims batches, never commits, and everything it produces is vetted by the user + a code agent before anything changes. Because that vet-pass is the correctness filter, web does **not** need ground truth — and over-feeding it repo detail narrows its output toward what already exists. Keep its context minimal on purpose.

**What web reads:** exactly two files — `spec/README.md` (product identity + domain map) and `spec/roadmap.md` (post-MVP frontier). Nothing else. Not the queue, schema, screens, flows, or code. Deduping a web idea against those is the code agent's job on the vet-pass, not web's.

**What web emits:** a structured worklist, one tagged line per item — not prose:

```
[CHECK]    <does X already happen / is Y true?>   — why it matters
[ADD]      <new feature/idea>                      — rationale — what to verify before queueing
[REFINE]   <existing thing> → <change>             — why
[RESEARCH] <open question>                          — what a good answer unblocks
```

**What the code agent does** when the user pastes that list — triage each item against the live repo, with the user:

| Tag | Action |
|---|---|
| `CHECK` | Inspect code/DB now; report the actual current behavior. |
| `ADD` | Confirm it isn't already built or queued; if it survives, draft a `BUILD_QUEUE.md` batch. |
| `REFINE` | Confirm against the current design; if it survives, draft a `spec:` edit. |
| `RESEARCH` | Run the search / doc-dig with the user. |

The worklist is **ephemeral** — a triage input, never a record. The durable outcome of the pass lands in `BUILD_QUEUE.md` (new batches) and `spec/**` (design edits) per the normal conventions. Any item not echoed into the queue or spec is dropped on purpose: the list is not stored, not committed, and is never a source of truth.

## The work queue

`BUILD_QUEUE.md` declares each un-done batch (completed history in `BUILD_QUEUE_DONE.md`). Eligibility is read from the tag in the batch heading:

- **No tag** — claimable, subject to the dependency check below.
- `[MANUAL]` — the user will execute this batch (e.g., infrastructure provisioning). Agents skip entirely: don't claim, don't log, don't propose changes unless asked.
- `[NOT READY]` — blocked on external work or design that isn't done yet. Don't claim.
- Any other tag you don't recognize — treat as exclusionary and ask the user before acting.

Each batch may also list `Depends on: Batch X[, Batch Y]`. A batch is only eligible to claim once **every** listed dependency appears in `CLAIMS.md` `## Completed` (or `CLAIMS_DONE.md` for older history).

The queue itself carries **no** Owner / Started / Finished / Status fields — those live in `CLAIMS.md`. The user may overwrite `BUILD_QUEUE.md` at any time without breaking agent state.

Multiple batches can run simultaneously when their "Files this batch creates/edits" + "Does NOT touch" declarations confirm they don't overlap. When two batches do touch overlapping files, run them sequentially.

## The claims file

`CLAIMS.md` has two sections:

- `## In progress` — one entry per actively claimed batch.
- `## Completed` — log of recently-finished batches, newest at the top. (Older history archived to `CLAIMS_DONE.md`.)

Entry format:

```
### Batch N — <short title>
- Owner: claude | cursor
- Started: YYYY-MM-DD HH:MM
- Finished: YYYY-MM-DD HH:MM        (only in Completed)
- Commit: <short SHA of the work commit>   (only in Completed)
- Handoff note: ...                  (only when mid-batch handoff occurred)
```

## Claim / finish / handoff / reclaim — invoke skills

The full procedures live in skills under `.claude/skills/`:

- **`claim-batch`** — pull, eligibility check, dependency check, parallelism check, `CLAIMS.md` entry, `meta: claim` commit, push-race recovery, mid-batch handoff, stale-claim recovery. **Invoke before starting any new batch.**
- **`finish-batch`** — final commit + SHA capture, move-to-Completed in `CLAIMS.md`, `meta: complete` commit, push, `/compact` reminder. **Invoke when wrapping up.**

Policy that overrides all of the above: **never** force-push to `dev`. The only acceptable response to a rejected push is `git fetch + reset` (claim commit) or `git pull --rebase` (work commit) and re-push.

## Commit message convention

| Prefix | When to use |
|---|---|
| `batch-N: <imperative>` | Code/asset change toward batch N |
| `meta: claim batch-N (<agent>)` | Claiming a batch |
| `meta: complete batch-N` | Marking a batch done in `CLAIMS.md` |
| `meta: handoff batch-N` | Mid-batch hand-off (Owner cleared) |
| `meta: reclaim batch-N from <prior owner>` | Stale-claim recovery |
| `meta: <other>` | Changes to `AGENTS.md`, `CLAUDE.md`, `CLAIMS.md` structure (not entries), tooling, lint config |
| `spec: <change>` | Edits to any `spec/*.md` file |

`git log --oneline` is the change log — there is no separate `CHANGELOG.md`.

## Editing rules

- Treat `BUILD_QUEUE.md` and `spec/**` as user-owned in terms of execution state (claim/Owner/timestamps live in `CLAIMS.md`, not here). Design intent may be written to both per the `spec-edit` skill.
- Anyone may add new entries to `CLAIMS.md`, but only the current Owner of a batch should mutate that batch's entry (except for stale-claim recovery — see the `claim-batch` skill).
- Always `git pull` before claiming so you don't race the other agent.

## What does NOT belong in this file

- The product spec, file paths for components, design tokens — all in `spec/`.
- The batch list — in `BUILD_QUEUE.md` (un-done) / `BUILD_QUEUE_DONE.md` (history).
- Per-batch state, timestamps, ownership — in `CLAIMS.md` (recent) / `CLAIMS_DONE.md` (archive).
- Procedures (claim / finish / spec-edit) — in `.claude/skills/`. AGENTS.md carries only the 2-line policy pointers.
- Per-language style guides — create a `STYLE.md` later if needed.
- Agent-specific quirks — Claude-only goes in `CLAUDE.md`, Cursor-only in a Cursor file. If a rule applies to both, it belongs **here**.
