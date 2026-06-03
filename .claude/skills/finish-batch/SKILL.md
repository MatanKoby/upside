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

## Hand the context back

5. Prompt the user to run `/compact` to reset the context window now that the batch is closed. Suggest which threads are worth preserving:

   > Batch N done. Suggest `/compact keep <topic>` — e.g. relevant design constraints, follow-ups you might want to claim next.

   You **cannot** run `/compact` yourself — it's a user-driven command. This is a reminder, not an action.

## Next

6. Decide: claim the next eligible batch (invoke the `claim-batch` skill) or stop. Either is fine — don't auto-chain unless the user has asked you to.
