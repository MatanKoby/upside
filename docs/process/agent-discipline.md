# Agent Discipline & Skill-Usage Reliability — Design Brief

Status: **research / design seed** (not yet a finalized protocol change). This is the
scope + framing for **Batch PROC** in `BUILD_QUEUE.md`; the batch deepens it into a full
design + drafts the implementation sub-batches. Companion to the human-readable protocol
in [`AGENTS.md`](../../AGENTS.md) and the skills under `.claude/skills/`.

## The problem

The whole spec / batch / claim / skill protocol lives as **prose** — in `AGENTS.md`,
`CLAUDE.md`, and the skill bodies. It is therefore only as reliable as each agent
re-reading and choosing to obey it. There is:

- **No enforcement** — nothing fails when a rule is broken. An agent can edit code without
  claiming a batch, push without running the gates, or edit `spec/` without invoking
  `spec-edit`, and nothing stops it.
- **No observability** — there is no record of *whether the right skill fired at the right
  time*. When a protocol step is skipped (a batch not written, `finish-batch` not run, a
  decision not persisted), the omission is silent until a human happens to notice.

The trigger for this work: during the ARCH-3 effort, the agent-discipline research had no
`BUILD_QUEUE` batch and that absence didn't surface to the user — they found it by
inspection. Silent omission is exactly the failure mode this work exists to kill, so it
must never be the thing that demonstrates the gap. (See `feedback_surface_skipped_work`.)

## Goals

1. **Skill-usage reliability** — the right skill fires at the right moment, every time:
   `claim-batch` before code work, `spec-edit` before any `spec/**` edit or persisted design
   decision, `finish-batch` on completion, the wrapper tools (`bin/upside-psql` /
   `bin/upside-discord`) instead of raw equivalents. Today these are honor-system.
2. **Observability** — a durable, inspectable trail of which protocol steps ran, which were
   skipped, and surfaced to the user automatically (e.g. at session end / on commit) so an
   omission floats up *without* a human hunting for it.
3. **Agent discipline (invariants enforced at chokepoints)** — turn each prose rule into an
   executable predicate checked at a point an agent can't skip, with first-class **carve-outs**
   (doc-only diffs, `meta:`/`spec:` commits, handoffs, reclaims) so the checker never fights
   legitimate work and trains agents toward `--no-verify`.

## Approach (to be validated in the batch)

**The keystone — one executable checker.** Write the invariants once as `bin/protocol-check`
(exits non-zero with a message on violation) and invoke that *same* script from every layer.
Skills shrink to thin wrappers that call it instead of re-describing it in prose. Candidate
invariants, all currently honor-system:

- **Claim-before-work** — every changed file in a non-`meta`/`spec` commit maps to exactly one
  `## In progress` batch in `CLAIMS.md` whose `Owner` matches the committer.
- **State-leak guard** — `BUILD_QUEUE.md` carries no `Owner:`/`Started:`/claim lines
  (`feedback_queue_state_separation`).
- **Commit grammar** — matches `meta:` / `batch-N:` / `spec:` / `refactor(scope):` … and carries
  the `Co-Authored-By` trailer.
- **Doc-update exemption** — `spec/`-or-queue-only diffs are allowed *without* a claim
  (`feedback_doc_updates_no_batch`); this exception must live in the checker too.
- **TableModule-style grep manifest** — generalize "no `from('<table>')` outside its module" into
  a `table → module` manifest the script enforces table-by-table.
- **Skill-fired assertions** — where detectable, that a `spec/**` change was accompanied by a
  `spec-edit` invocation, a batch claim by `claim-batch`, etc.

**Enforcement layers** (fast → authoritative; each maps to *chokepoint · who-it-binds ·
prevents-vs-detects*):

1. **Claude Code hooks** (`PreToolUse`/`Stop`, via the `update-config` skill) — fastest, but bind
   *only Claude*. Block an `Edit`/`Write` to a path not covered by the owned claim; block
   `git push --force` on `dev`; a `Stop` hook flags unpushed commits + protocol violations.
2. **Versioned git hooks** (`core.hooksPath` → `.githooks/`, no new dependency) — bind *both*
   agents because every commit/push flows through them. `commit-msg` (grammar) + `pre-push` (run
   `protocol-check` + the cheap gates). Locally bypassable with `--no-verify` → fast feedback,
   not a wall.
3. **CI + branch protection** — the only **unbypassable** layer (server-side). A GitHub Action
   runs `protocol-check` + typecheck + tests; branch protection on `dev` blocks force-push.

**Observability** — `protocol-check` (or a sibling) emits a structured event/record of which
checks ran + their verdicts; a session-end / `Stop`-hook summary surfaces skipped-but-expected
steps to the user. The point is that "a batch wasn't written" reports *itself*.

## Open decisions (resolve with the user when the batch is claimed)

1. **Prevention vs. velocity.** Keep **direct-push-to-`dev`** (CI runs *after* the push →
   *detects* + enables fast-revert; a bad commit briefly lands and Vercel may deploy it) — or move
   to **one-batch-one-branch → PR → CI gate → merge** (CI *prevents*, truly unbypassable, but
   overturns `AGENTS.md`'s "commit directly, no feature branches" and adds merge ceremony).
   *Recommendation:* keep direct-push + CI-as-detect + branch-protection-blocks-force-push; revisit
   PR-per-batch only if violations actually recur.
2. **Who it must bind.** **Both Claude + Cursor** (weight sits in versioned git hooks + CI, the
   shared chokepoints; `.claude/` hooks are a Claude-only bonus) — or mainly **harden Claude's
   runs** (leans on the existing `.claude/hooks/`). *Recommendation:* bind both — `CLAIMS.md` exists
   *because* Cursor is a real second writer.

## Spinoff: a standalone, repo-agnostic library

The protocol here is not Upside-specific — "spec-first / claim-before-work / skill-at-the-right-time
/ grep-enforced module boundaries, with carve-outs and an observability trail" generalizes to any
repo where one or more coding agents commit to a shared branch. Design `protocol-check` from day one
as **config-driven** (an invariant manifest + a carve-out list the host repo supplies), so it can be
extracted into its **own GitHub repo and published to npm** as released versions, with this repo as
the first consumer. Implications for the design: a clean lib/host boundary (no hard-coded Upside
paths, table names, or skill names — all injected via config), a documented config schema, and a
versioning/release story. Treat "could this be the npm package's API?" as a design constraint on
every interface, even while the first implementation lives in-repo.

## Non-goals (for the first pass)

- Rewriting the product `spec/` or app architecture — this is build-*process* tooling.
- Auto-applying fixes — the checker reports/blocks; humans (or a follow-up) remediate.
- The eventual `db/ → adapters/supabase/` move and other ARCH-track work — separate.
