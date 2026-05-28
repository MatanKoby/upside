# Upside — Specification

Upside is a mobile-first PWA portfolio intelligence layer for Interactive Brokers. Displays your IB portfolio with real-time data plus watchlists with user-defined price markers, dynamic entry-zone signals, and (when warranted) LLM-powered analyses. Built for a solo intraday/swing trader on NYSE/NASDAQ, phone-first, 24/7.

The spec is split across concern-focused folders. Each file is small and edited as a unit. When two sections always change in tandem, they belong in the same file.

## Files

- **`architecture.md`** — Tech stack, Oracle VPS, Docker, public URL discovery (Cloudflare Quick Tunnel), Upside auth (Google OAuth + whitelist), IB auth (on-demand IBeam), connection status, multi-source price polling, **single source of truth for current price**, three loops, security, project structure, MVP build order.
- **`flows.md`** — End-to-end flows: signal engine, profit-taking zone, signal-range entry, accuracy cron, connect/disconnect, **watchlist import**, **marker hit**, **entry-zone update**. Data-flow maps.
- **`schema.md`** — Supabase tables (positions, analyses, signals, **quotes**, **watchlist_lists**, **watchlist_items**, **watchlist_markers**, **entry_zones**, user_preferences, analysis_locks, contracts, external_api_metrics, app_config). Redis. Finnhub rate-limited queue. IB API rate limits.
- **`signals/`** — Signal-generation domain, one file per concern:
  - `playbook.md` — LLM playbook engine: schema, freshness guard, supersede semantics, signal pill, mutability, expiry, accuracy tracking, info badges, realtime, contextual triggers.
  - `zone.md` — Profit-taking zone detection (continuous, LLM-independent).
  - `markers.md` — User-defined price markers + Discord alerts (watchlist pivot, Batch A2).
  - `entry-zones.md` — Dynamic entry-zone engine (continuous, LLM-free, recomputed per poll cycle; Batch A+).
  - `llm-provider.md` — Provider abstraction (Groq / Mistral / OpenAI / Gemini), runtime selection, failure classification.
  - `data-sources.md` — IB / Finnhub / computed feature pack.
- **`screens/`** — UI surfaces, one file per screen + shared design system:
  - `_design-system.md` — Typography, colors, dark mode, spacing, primitives catalog, TickerCard, PWA, metrics formulas.
  - `portfolio.md` — Portfolio Home (held positions).
  - `ticker-detail.md` — Ticker Detail (works for held AND watchlist tickers).
  - `watchlist.md` — Watchlist tab (Track 1, moved into MVP via the 2026-05-28 pivot).
  - `alerts.md` — Alerts feed.
  - `settings.md` — App-level Settings.
- **`roadmap.md`** — Post-MVP tracks, contextual settings pattern, deferred work (structure-feature redesign, LLM-engine refinement). Track 1 (watchlists) **moved into MVP** by the pivot.
- **`archive.md`** — Historical content not reflecting current code.

## Reading order

For someone new to the project: README → `architecture.md` → `signals/playbook.md` (or `signals/markers.md` + `signals/entry-zones.md` for the watchlist surface) → `screens/_design-system.md` + `screens/portfolio.md` + `screens/watchlist.md`.

For a coding agent claiming a batch: read the queue entry first, then the 2-4 spec files relevant to the batch's domain. Don't read everything.

For a design conversation: pull just the files the topic touches. Most changes affect 1-2 files.

## Operational pointers (not in `spec/`)

- **`BUILD_QUEUE.md`** (repo root) — execution units (batches). What to build, dependencies, verification.
- **`CLAIMS.md`** (repo root) — who's working on what + completion log. Single source of truth for execution state.
- **`AGENTS.md`** (repo root) — shared protocol for Claude Code & Cursor.
- **`CLAUDE.md`** (repo root) — Claude-specific pointer; defers to AGENTS.md.

## Editing convention

Edit the file matching the concern. If a change crosses multiple files, that's a signal the concern might be miscarved — flag it before duplicating content. Cross-reference by file path (`see signals/zone.md` or `see screens/ticker-detail.md → Refresh policy`) rather than restating.

The spec describes the **current intended design** — not the history. Move historical context to `archive.md` when it stops being part of the live system.
