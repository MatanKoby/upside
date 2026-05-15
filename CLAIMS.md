# Batch Claims

Agent-managed batch state for both Claude Code and Cursor. **Do not put claim fields inside `BUILD_QUEUE.md`** — that file is user-owned and gets pasted over when the user adds or revises batches, which would wipe any state stored in it.

This file is the single source of truth for *who is working on what* and *what has been completed*. `BUILD_QUEUE.md` defines *what to build*; `CLAIMS.md` records *what has happened*.

See `AGENTS.md` for the full claim / finish / handoff / reclaim protocols.

## In progress

(none)

## Known issues (deferred fixes)

- **`analysis_locks` permission denied** — `signalRunner` cleanup cron logs `permission denied for table analysis_locks` every 30s. The `SUPABASE_SECRET_KEY` should bypass RLS, so this is a grants problem, not RLS. Likely connected to "auto-expose tables OFF" spec change (commits fd07a90 / 1734633). Must be resolved before Batch 14 (signal pipeline depends on this table).

## Completed

### Batch 10 — Deploy BE compose stack to Oracle VPS
- Owner: claude
- Started: 2026-05-14 20:36
- Finished: 2026-05-15 (today)
- Commits: 1d97339 (un-comment ib-gateway service), a87c8c3 (axios https + self-signed cert), d7ecc41 (compose IB_GATEWAY_URL → https)
- Notes: surfaced and fixed http→https scheme bug for IB Client Portal Gateway. Filed `analysis_locks` grants issue as deferred.

### Batch 8 — Supabase project provisioning
- Owner: Me!
- Started: 2026-05-14 20:26
- Finished: 2026-05-14 20:41

### Batch 9 — Real-time price loop + frontend wiring
- Owner: claude
- Started: 2026-05-14 19:50
- Finished: 2026-05-14 20:00
- Commit: c90b33b

### Batch 7.5 — Collapse migrations into single baseline
- Owner: claude
- Started: 2026-05-14 19:49
- Finished: 2026-05-14 19:50
- Commit: 6ed224b

### Batch 6 — Schema reconciliation + IB mappers + snapshot fix
- Owner: claude
- Started: 2026-05-14 17:50
- Finished: 2026-05-14 18:03
- Commit: f7cdfef

### Batch 7 — Raw IB Client Portal data capture
- Owner: claude
- Started: 2026-05-14 13:35
- Finished: 2026-05-14 16:26
- Commit: babbca8

### Batch 5 — Docker Compose + Supabase schema + Node.js API scaffold
- Owner: claude
- Started: 2026-05-14 10:14
- Finished: 2026-05-14 10:48
- Commit: 182fd29

### Batch 4 — Oracle VPS + Docker setup
- Owner: Me!
- Started: 2026-05-14 08:07
- Finished: 2026-05-14 10:07
- Commit: 41162b4

### Batch 3 — Ticker detail - chart integration
- Owner: cursor
- Started: 2026-05-11 10:14
- Finished: 2026-05-11 10:18
- Commit: 41162b4

### Batch 2 — Ticker detail - layout & static components
- Owner: cursor
- Started: 2026-05-11 10:07
- Finished: 2026-05-11 10:13
- Commit: 49f8740

### Batch 1 — Portfolio home screen
- Owner: claude
- Started: 2026-05-10 18:36
- Finished: 2026-05-11 09:01
- Commit: 86b0b83
