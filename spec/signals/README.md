# `spec/signals/` — Signal-generation domain

One file per signal concern. When two sections always change in tandem, they belong in the same file. When a concern is large enough to want its own file, add it here and update this README.

## Files

- **`playbook.md`** — LLM playbook engine: schema, freshness guard, supersede semantics, signal pill, mutability, expiry, accuracy tracking, info badges, realtime, contextual triggers.
- **`zone.md`** — Profit-taking zone detection (continuous, LLM-independent).
- **`markers.md`** — User-defined price markers + Discord alerts (watchlist pivot, Batch A2).
- **`entry-zones.md`** — Dynamic entry-zone engine (continuous, LLM-free, recomputed per poll cycle; Batch A+).
- **`stats.md`** — Intraday-stats engine (nightly cron over 5-min bars; typical-intraday-low band alerts; Batch B).
- **`screener-universe.md`** — **Post-MVP screener track:** universe (Ring 0/1) + trait scoring (intraday_range_trader / catalyst_reversal / post_earnings_drift), sweep schedule, dynamic universe inclusion. The "what makes a ticker eligible + what kind of opportunity it is" file.
- **`band-engine.md`** — **Post-MVP screener track:** three adaptive band layers (session_regime classifier, today's vol scalar, walking band-state machine). Turns surfaced screener tickers + held positions into walking buy/sell bands.
- **`llm-provider.md`** — Provider abstraction (Groq / Mistral / OpenAI / Gemini), runtime selection, failure classification.
- **`data-sources.md`** — IB / Finnhub / computed feature pack (current); SEC EDGAR / FDA RSS / PR wires / Nasdaq Trader (planned, screener track).

## Cross-references

- Schema (tables backing these signals): `../schema.md`
- End-to-end flows wiring signals to pollers + notifications: `../flows.md`
- Screens that surface signals: `../screens/watchlist.md`, `../screens/ticker-detail.md`, `../screens/screener.md`
