# Upside — Specification

Upside is a mobile-first PWA portfolio intelligence layer for Interactive Brokers. Displays your IB portfolio with real-time data plus watchlists with user-defined price markers, dynamic entry-zone signals, and (when warranted) LLM-powered analyses. Built for a solo intraday/swing trader on NYSE/NASDAQ, phone-first, 24/7.

The spec is split across concern-focused folders. Each file is small and edited as a unit. When two sections always change in tandem, they belong in the same file.

## Top-level files

- **`architecture.md`** — Tech stack, Oracle VPS, Docker, public URL discovery (Cloudflare Quick Tunnel), Upside auth (Google OAuth + whitelist), IB auth (on-demand IBeam), connection status, multi-source price polling, **single source of truth for current price**, three loops, security, project structure, MVP build order.
- **`flows.md`** — End-to-end flows: signal engine, profit-taking zone, signal-range entry, accuracy cron, connect/disconnect, watchlist import, marker hit, entry-zone update, intraday-stats update, screener universe sweep, pre-market refresh + dynamic universe inclusion, band walk, band-touch notification. Data-flow maps.
- **`job-queue.md`** — **Post-MVP screener-track infrastructure:** async Postgres-backed job queue (`screener_jobs`) decoupling producers from per-pool workers (ib / finnhub / compute). Partial unique index on `job_key` for dedup; `SELECT FOR UPDATE SKIP LOCKED` for safe concurrent claim; lease + reaper for stuck-worker recovery. Used by every cron touching a rate-limited or intermittently-available upstream.
- **`schema.md`** — Supabase tables, Redis, Finnhub rate-limited queue, IB API rate limits.
- **`roadmap.md`** — Post-MVP tracks, contextual settings pattern, deferred work (structure-feature redesign, LLM-engine refinement, Track 10 screener deferred items). Track 1 (watchlists) **moved into MVP** by the pivot.
- **`archive.md`** — Historical content not reflecting current code.

## Sub-folders (one README per folder — open it first, not every file)

- **`signals/`** → see [`signals/README.md`](signals/README.md). LLM playbook, profit-taking zone, markers, entry-zones, intraday-stats, screener-universe, band-engine, curated-list, dip-bounce-scorer, risk-flags, LLM-provider.
- **`screens/`** → see [`screens/README.md`](screens/README.md). Design system + Portfolio / Ticker Detail / Watchlist / Screener / Alerts / Settings.
- **`data/`** → see [`data/README.md`](data/README.md). Data-flow catalog: `sources.md` (external sources → requests → storage) + `consumers.md` (crons/engines/UI → reads). The SSOT / pipeline map.

## Reading order

For someone new to the project: README → `architecture.md` → `signals/playbook.md` (or `signals/markers.md` + `signals/entry-zones.md` for the watchlist surface) → `screens/_design-system.md` + `screens/portfolio.md` + `screens/watchlist.md`.

For a coding agent claiming a batch: read the queue entry first, then the 2-4 spec files relevant to the batch's domain. Pull the sub-folder README before reading individual files there. Don't read everything.

For a design conversation: pull just the files the topic touches. Most changes affect 1-2 files.

## Operational pointers (not in `spec/`)

- **`BUILD_QUEUE.md`** (repo root) — execution units (batches). What to build, dependencies, verification. Completed history in **`BUILD_QUEUE_DONE.md`**.
- **`CLAIMS.md`** (repo root) — who's working on what + recent completion log. Older completed batches archived in **`CLAIMS_DONE.md`**.
- **`AGENTS.md`** (repo root) — shared protocol for Claude Code & Cursor. Procedures (claim / finish / spec-edit) live in skills under `.claude/skills/`.
- **`CLAUDE.md`** (repo root) — Claude-specific pointer; defers to AGENTS.md.

## Editing convention

Edit the file matching the concern. If a change crosses multiple files, that's a signal the concern might be miscarved — flag it before duplicating content. Cross-reference by file path (`see signals/zone.md` or `see screens/ticker-detail.md → Refresh policy`) rather than restating.

The spec describes the **current intended design** — not the history. Move historical context to `archive.md` when it stops being part of the live system.

For the full spec-edit procedure (concern-matching, archive rule, propagation to `BUILD_QUEUE.md`, persisting design decisions made in session), invoke the `spec-edit` skill — its body is the procedure.
