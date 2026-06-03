---
name: finish-batch
description: Use when wrapping up a claimed batch — final commit, SHA capture, CLAIMS.md move-to-completed, `meta: complete` commit, push, `/compact` reminder.
---

# Finish a claimed batch

The full procedure. AGENTS.md carries only the 2-line policy pointer to this file.

## Wrap-up

1. Make the final work commit and push. **Note its short SHA** — you'll record it in `CLAIMS.md`.

   ```
   git log --oneline -1     # capture the SHA
   ```

2. Edit `CLAIMS.md`. Move the batch's entry from `## In progress` to the **top** of `## Completed`, adding:

   ```
   - Finished: YYYY-MM-DD HH:MM
   - Commit: <short SHA>
   ```

   Same UTC convention as `Started:`. Keep any `Handoff note:` / `Reclaim note:` lines from the in-progress entry; they're part of the historical record.

3. Add a "What shipped" summary under the entry — what changed, where, the manual prereqs for live-flip if any, verification steps, follow-ups deferred. Look at existing entries in `## Completed` for the format. The point is that a future agent (or you, after `/compact`) can reconstruct the batch's outcome from this entry alone.

4. Commit `meta: complete batch-N` and `git push origin dev`.

## Hand the context back — compose a *specific* `/compact` suggestion

5. Prompt the user to run `/compact` with **concrete** keep-args, not a generic "preserve relevant threads." A useful suggestion has three pieces:

   - **2–4 named items worth keeping.** Things the next batch's reasoning will lean on: durable artifacts shipped (new skills, new patterns, new infrastructure), design decisions made or reaffirmed in this session, forward pointers (next likely batch and why).
   - **A one-line rationale** explaining what's being dropped vs. preserved — the *shape* of the trim, not a list of every excluded thread.
   - **Honesty about your own role.** End with "I can't run /compact for you" so it's clear this is a reminder, not a queued action.

   What to *drop*: blow-by-blow execution detail, specific file paths / SHAs (git + `CLAIMS.md` own those), debug threads that are now resolved, intermediate states.

   Template:

   > Batch N done. Suggest `/compact keep <item-1>, <item-2>, <item-3>` to drop <execution-detail descriptor> but preserve <the enduring pieces>. I can't run /compact for you.

   Concrete example (from Batch M1, 2026-06-03):

   > Batch M1 done. Suggest `/compact keep M1 measurement, claim/finish/spec-edit skills, S3 next` to drop M1's execution detail but preserve the skill model and the next-batch pointer. I can't run /compact for you.

   If nothing about the closed batch is worth preserving (rare — usually the *patterns* it established are), say so plainly and suggest a bare `/compact` instead.

## Next

6. Decide: claim the next eligible batch (invoke the `claim-batch` skill) or stop. Either is fine — don't auto-chain unless the user has asked you to.
