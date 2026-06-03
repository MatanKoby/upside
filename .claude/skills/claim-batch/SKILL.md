---
name: claim-batch
description: Use when claiming a batch from BUILD_QUEUE.md — eligibility check, dependency check, parallelism check, CLAIMS.md entry, `meta: claim` commit, push-race recovery, handoff/reclaim flows. Invoke before starting any new batch.
---

# Claim a batch from `BUILD_QUEUE.md`

The full procedure. AGENTS.md carries only the 2-line policy pointer to this file.

## Pre-flight

1. `git pull --ff-only origin dev` — if it fails, resolve before claiming.

## Eligibility

2. Pick a candidate batch in `BUILD_QUEUE.md` (under "Un-done batches"):
   - **Skip** if it has an exclusionary tag: `[MANUAL]`, `[NOT READY]`, or any tag you don't recognize.
   - **Skip** if it's already listed in `CLAIMS.md` `## In progress` or `## Completed`.

3. **Dependency check.** If the batch lists `Depends on: Batch X[, Batch Y]`, verify each listed batch appears in `CLAIMS.md` `## Completed`. If any are missing, pick a different candidate.

4. **Parallelism check.** If any batch is currently in `## In progress`, compare your candidate's "Files this batch creates/edits" against that batch's same field. If they overlap, pick a different candidate or wait.

## Claim

5. Edit `CLAIMS.md`. Add an entry to the **top** of `## In progress`:

   ```
   ### Batch N — <title>
   - Owner: claude   (or cursor)
   - Started: YYYY-MM-DD HH:MM
   ```

   Use UTC for the timestamp (the same convention every existing entry uses).

6. Commit `meta: claim batch-N (claude)` and `git push origin dev`.

## Push-race recovery (rejected push on the claim commit)

If `git push` is rejected as non-fast-forward, the other agent committed to `dev` first. Recover **without force-pushing**:

1. `git fetch origin dev`
2. `git reset --hard origin/dev` — drops your local claim commit. Safe because the only change was `CLAIMS.md`.
3. Re-read `CLAIMS.md`:
   - If your target batch is now in `## In progress`, the other agent has it — pick a different claimable batch and start over.
   - If your target is still unclaimed (the other agent raced for a *different* batch), re-run this whole procedure from step 1 with the same target.

For a rejected push on a *work* commit (`batch-N: ...`), **don't reset** — pull-rebase: `git pull --rebase origin dev`, resolve any conflicts, push again.

**Never** `git push --force` or `-f` against `dev`. It clobbers the other agent's commits.

## Mid-batch handoff (rare)

If you must stop before finishing:

1. Edit the batch's entry in `CLAIMS.md` `## In progress`:
   - Change `Owner:` to `none`.
   - Add a `Handoff note:` line — what's done, what's left, files touched, gotchas.
2. Commit `meta: handoff batch-N` and push.

The next agent runs this same claim procedure but only updates `Owner:` (the `Started:` timestamp stays as the original).

## Stale-claim recovery

If a batch has been `## In progress` with no new commits for >24h and you want to take over:

1. Update `Owner:` in the existing entry; add a `Reclaim note:` line explaining why.
2. Commit `meta: reclaim batch-N from <prior owner>` and push.

Use sparingly — prefer to wait or ping the user.

## Doing the work

After step 6, you're the owner. Commit incrementally with `batch-N: <imperative description>` messages and push at sensible checkpoints. On any rejected push during work commits, pull-rebase (see above), never force.

When finishing, invoke the `finish-batch` skill.
