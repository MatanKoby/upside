# Upside — Specification

Upside is a mobile-first PWA portfolio intelligence layer for Interactive Brokers. Displays your IB portfolio positions with real-time data, AI-powered signals (sell windows, entry points, event alerts), and contextual insights. Built for a solo intraday/swing trader on NYSE/NASDAQ, phone-first, 24/7.

The spec is split across 6 domain files plus an archive. Each file covers one concern and gets edited as a unit. When two sections always change in tandem, they belong in the same file.

## Files

- **`architecture.md`** — Tech stack, Oracle VPS infrastructure, Docker containers, public URL discovery (Cloudflare Quick Tunnel + self-healing), Upside auth (Google OAuth + whitelist), IB auth (on-demand IBeam), connection status, multi-source price polling, three loops, security policy, project structure, MVP build order.
- **`signal-model.md`** — Unified SELL+BUY analysis, Zod output schema, atomic-snapshot supersede semantics, signal pill rendering, mutability rules, held+watchlisted behavior, signal expiry, accuracy tracking, info badges, profit-taking zone detection, LLM provider abstraction, data sources.
- **`flows.md`** — Signal engine flow (user-triggered), profit-taking zone flow (continuous), signal-range entry flow (continuous), accuracy cron flow (daily). Data flow between IB / Backend / Frontend / Supabase / Redis / Finnhub.
- **`schema.md`** — Supabase tables (positions, analyses, signals, user_preferences, analysis_locks, access_attempts, contracts, external_api_metrics, app_config). Redis usage. Finnhub rate-limited queue. IB API rate limits.
- **`screens.md`** — All screens (Portfolio Home, Ticker Detail, Alerts Feed, Settings — plus Watchlists / Single Watchlist as post-MVP forward-spec). Design system (typography, colors, dark mode, spacing, animations). Primitives catalog. TickerCard generalization. PWA requirements. Key metrics & calculations.
- **`roadmap.md`** — Post-MVP tracks 1-8, contextual settings pattern, dependencies between tracks. Editable as design intent for features deferred past MVP completion (Batch 16).
- **`archive.md`** — Historical content not reflecting current code: abandoned IB-auth approaches, dropped features, deprecated decisions. Read when investigating "why didn't we do X?"; not on every turn.

## Reading order

For someone new to the project: README → `architecture.md` → `signal-model.md` → `screens.md`. That gives you the product, the system, the data shapes, and the surfaces in ~4 files.

For a coding agent claiming a batch: read the queue entry first, then the 2-4 spec files relevant to the batch's domain. Don't read everything.

For a design conversation: pull just the files the topic touches. Most changes affect 1-2 files.

## Operational pointers (not in spec/)

- **`BUILD_QUEUE.md`** (repo root) — execution units (batches). What to build, dependencies, verification.
- **`CLAIMS.md`** (repo root) — who's working on what + completion log. Single source of truth for execution state.
- **`AGENTS.md`** (repo root) — shared protocol for Claude Code & Cursor (claim/finish/handoff, commit conventions). Includes the spec-layout subsection mirroring the file list above.
- **`CLAUDE.md`** (repo root) — Claude-specific pointer; defers to AGENTS.md.

## Editing convention

When you edit the spec, edit the file matching the concern. If a change naturally crosses multiple files, that's a signal the concern might be miscarved — flag it before adding the same content to two places. Cross-reference by file path (`see schema.md → Supabase Schema`) rather than duplicating.

The spec describes the **current intended design** — not the history of how we got there. Move historical context to `archive.md` when it stops being part of the live system.
