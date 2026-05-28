# AGENTS.md — Shared Protocol for Claude Code & Cursor

Single source of truth for how the two AI agents collaborate on this project. Both agents must read this before starting work. Anything here applies to **both** agents — agent-specific rules belong in `CLAUDE.md` (Claude only) or a Cursor-specific file, not here.

## Project pointer

**Upside** is a mobile-first PWA portfolio intelligence layer for Interactive Brokers. The product spec is in the `spec/` directory (see "Spec layout" below). Work batches are declared in `BUILD_QUEUE.md`. Active and historical claim state is in `CLAIMS.md`. This file does not duplicate any of those.

Claude web is used as a read-only **ideation surface** upstream of the queue — it raises ideas and research leads, it does not execute. See "Ideation handoff (Claude web → code)" below.

## Repo & branches

- `dev` — shared working branch. Both agents commit directly. Always `git pull --ff-only origin dev` before claiming.
- `prod` — promoted snapshot of `dev` once stable. Only the user merges into `prod`.
- No feature branches in the normal flow.

## File ownership

| File | Owner | Notes |
|---|---|---|
| `spec/**` | user | Frozen reference. Agents may propose `spec:` edits but should not freelance changes. See "Spec layout" below for the file split. |
| `BUILD_QUEUE.md` | user | Declares the work. The user updates it by pasting their offline working copy, so agents must **never** write state into it. Status tags like `[READY]` / `[PENDING]` reflect user intent only. |
| `CLAIMS.md` | agents | Records active claims and completion log. The user does not normally edit this. |
| `AGENTS.md`, `CLAUDE.md` | shared | Either party may edit; use `meta:` commits. |
| `client/`, `server/`, etc. | shared | Use `batch-N:` commits when working on a claimed batch. |

## Spec layout

The spec lives in the `spec/` directory, split across 6 domain files plus an archive. Each file is one concern, edited as a unit. Read only the files relevant to the work in front of you — don't read the whole spec on every turn.

| File | Domain |
|------|--------|
| `spec/README.md` | Index + cross-references. Start here. |
| `spec/architecture.md` | Tech stack, infra, Docker, public URL discovery, Upside auth, IB auth (on-demand IBeam), multi-source price polling, **single source of truth for current price**, three loops, security, project structure, MVP build order. |
| `spec/flows.md` | All end-to-end flows: signal engine, profit-taking zone, signal-range entry, accuracy cron, connect/disconnect, **watchlist import**, **marker hit**, **entry-zone update**. Data-flow maps. |
| `spec/schema.md` | Supabase tables (positions, analyses, signals, **quotes**, **watchlist_lists**, **watchlist_items**, **watchlist_markers**, **entry_zones**, ...). Redis. Finnhub rate-limited queue. IB API rate limits. |
| `spec/signals/playbook.md` | LLM playbook engine — schema, freshness guard, supersede semantics, pill rendering, mutability, expiry, accuracy tracking, info badges, realtime. |
| `spec/signals/zone.md` | Profit-taking zone detection (continuous, LLM-independent). |
| `spec/signals/markers.md` | User-defined price markers + Discord alerts (watchlist pivot). |
| `spec/signals/entry-zones.md` | Dynamic entry-zone engine (continuous, LLM-free, recomputed per poll cycle). |
| `spec/signals/llm-provider.md` | Provider abstraction (Groq / Mistral / OpenAI / Gemini), runtime selection, failure classification. |
| `spec/signals/data-sources.md` | IB / Finnhub / computed feature pack. |
| `spec/screens/_design-system.md` | Typography, colors, dark mode, spacing, primitives catalog, TickerCard, PWA, metrics formulas. |
| `spec/screens/portfolio.md` | Portfolio Home (held positions). |
| `spec/screens/ticker-detail.md` | Ticker Detail (works for held AND watchlist tickers). |
| `spec/screens/watchlist.md` | Watchlist tab (Track 1, moved into MVP). |
| `spec/screens/alerts.md` | Alerts feed. |
| `spec/screens/settings.md` | App-level Settings. |
| `spec/roadmap.md` | Post-MVP tracks. Contextual settings pattern. Deferred work (structure-feature redesign, LLM-engine refinement). |
| `spec/archive.md` | Historical content not reflecting current code. |

**Editing convention:** when you edit the spec, edit the file matching the concern. If a change naturally crosses multiple files, that's a signal the concern might be miscarved — flag it before duplicating content. Cross-reference by file path (`see schema.md → Supabase Schema`) rather than restating.

The spec describes the **current intended design** — not the history of how we got there. Move historical context to `archive.md` when it stops being part of the live system.

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

`BUILD_QUEUE.md` declares each batch. Eligibility is read from the tag in the batch heading:

- **No tag** — claimable, subject to the dependency check below.
- `[MANUAL]` — the user will execute this batch (e.g., infrastructure provisioning). Agents skip entirely: don't claim, don't log, don't propose changes unless asked.
- `[NOT READY]` — blocked on external work or design that isn't done yet. Don't claim.
- Any other tag you don't recognize — treat as exclusionary and ask the user before acting.

Each batch may also list `Depends on: Batch X[, Batch Y]`. A batch is only eligible to claim once **every** listed dependency appears in `CLAIMS.md` `## Completed`.

The queue itself carries **no** Owner / Started / Finished / Status fields — those live in `CLAIMS.md`. The user may overwrite `BUILD_QUEUE.md` at any time without breaking agent state.

Multiple batches can run simultaneously when their "Files this batch creates/edits" + "Does NOT touch" declarations confirm they don't overlap. When two batches do touch overlapping files, run them sequentially.

## The claims file

`CLAIMS.md` has two sections:

- `## In progress` — one entry per actively claimed batch.
- `## Completed` — log of finished batches, newest at the top. This **is** the project's completion log; if `BUILD_QUEUE.md` references a `COMPLETION_LOG.md`, that role is served here.

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
2. **Eligibility.** Open `BUILD_QUEUE.md` and pick a candidate batch — one with no exclusionary tag (`[MANUAL]`, `[NOT READY]`, or any tag you don't recognize) and not already listed in `CLAIMS.md` `## In progress` or `## Completed`.
3. **Dependency check.** If the candidate lists `Depends on: Batch X[, Batch Y]`, verify each listed batch appears in `CLAIMS.md` `## Completed`. If any are missing, pick a different candidate.
4. **Parallelism check.** If any batch is currently in `## In progress`, compare your candidate's "Files this batch creates/edits" against that batch's same field. If they overlap, pick a different candidate or wait.
5. Edit `CLAIMS.md`: add an entry under `## In progress`:
   ```
   ### Batch N — <title>
   - Owner: claude   (or cursor)
   - Started: YYYY-MM-DD HH:MM
   ```
6. Commit `meta: claim batch-N (claude)` and `git push origin dev`. If the push is rejected as non-fast-forward, follow **Push race recovery** below — do not force-push.
7. Do the work. Commit incrementally with `batch-N: <imperative description>` messages and push at sensible checkpoints. (Same rule on a rejected push: pull-rebase, resolve, push again — never force.)

## Finish protocol

1. Make the final work commit and push. Note its short SHA.
2. Edit `CLAIMS.md`: move the batch's entry from `## In progress` to the top of `## Completed`, adding:
   - `Finished: YYYY-MM-DD HH:MM`
   - `Commit: <short SHA of the final work commit>`
3. Commit `meta: complete batch-N` and push.
4. Prompt the user to run `/compact` to reset the context window now that the batch is closed, suggesting which threads are worth preserving (e.g. `/compact keep <topic> data`). You cannot run `/compact` yourself — it's a user-driven command — so this is a reminder, not an action.
5. Decide: claim the next eligible batch (re-run the claim protocol) or stop. Either is fine.

## Push race recovery

If `git push` after your claim commit (step 6 of the claim protocol) is rejected as non-fast-forward, the other agent committed to `dev` first. Recover without force-pushing:

1. `git fetch origin dev`.
2. `git reset --hard origin/dev` — drops your local claim commit. Safe because the only change in it was the `CLAIMS.md` edit.
3. Re-read `CLAIMS.md`. If your target batch is now in `## In progress`, the other agent has it — pick a different claimable batch and re-run the claim protocol.
4. If your target batch is still unclaimed (the other agent raced for a *different* batch), re-run the claim protocol from step 1 with the same target.

For a rejected push on a *work* commit (`batch-N: ...`), don't reset — pull-rebase instead: `git pull --rebase origin dev`, resolve any conflicts, push again.

**Never** resolve a rejected push with `git push --force` or `git push -f`. Force-pushing to `dev` clobbers the other agent's commits and breaks the shared history. The only acceptable response to a non-fast-forward rejection is to incorporate the remote's commits first.

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
| `spec: <change>` | Edits to any `spec/*.md` file |

`git log --oneline` is the change log — there is no separate `CHANGELOG.md`.

## Editing rules

- Treat `BUILD_QUEUE.md` and `spec/**` as user-owned in terms of execution state (claim/Owner/timestamps live in `CLAIMS.md`, not here). Design intent may be written to both per the "Design and spec decisions" section below.
- Anyone may add new entries to `CLAIMS.md`, but only the current Owner of a batch should mutate that batch's entry (except for stale-claim recovery).
- Always `git pull` before claiming so you don't race the other agent.

## Design and spec decisions

When a design or specification decision is made, the agent involved must
persist it to the spec and queue before moving on. The path depends on where
the decision originated:

**Decision made in a working session with the user:**
1. Update the relevant file(s) in `spec/` to reflect the new design, with a `spec:` commit. Match the change to the file's concern (architecture vs. signal-model vs. screens vs. etc.).
2. Update `BUILD_QUEUE.md` to revise the relevant in-flight batch or add new
   batches that flow from the decision, with a `meta:` commit.
3. Then proceed to implementation.

**Decision encountered by an agent mid-execution (no user input yet):**
The agent must **not** quietly make and persist the decision. Instead:
1. Surface it to the user — describe the choice and the tradeoffs.
2. Wait for the user's call.
3. Once the user has decided, follow the working-session flow above.

Scope: **design/spec only** — architecture, data model, public behavior, batch
scope. Day-to-day implementation forks (library choice, internal file naming,
refactor shape) stay agent discretion.

The spec and queue are the durable record. A decision discussed in a session
but not written into these files will be re-litigated or silently contradicted
by a future agent. The conversation transcript is not a substitute.

This addition does *not* override the rule that execution state (claim /
Owner / timestamps) never goes into `BUILD_QUEUE.md` — that still lives in
`CLAIMS.md`. The queue holds *design intent*; the claims file holds *execution
state*.

## What does NOT belong in this file

- The product spec, file paths for components, design tokens — all in `spec/`.
- The batch list — in `BUILD_QUEUE.md`.
- Per-batch state, timestamps, ownership — in `CLAIMS.md`.
- Per-language style guides — create a `STYLE.md` later if needed.
- Agent-specific quirks — Claude-only goes in `CLAUDE.md`, Cursor-only in a Cursor file. If a rule applies to both, it belongs **here**.
