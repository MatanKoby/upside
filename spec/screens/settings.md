# Settings (app-level)

> **App-level only. Per-screen settings live on their own screens** (gear icon in screen header → contextual sheet). E.g. watchlist hide/unhide lives in `watchlist.md`. See `../roadmap.md` → Contextual Settings Pattern.

**Settings persistence:** All preferences live in `user_preferences` (see `../schema.md`). FE writes through BE (`PUT /api/user/preferences`) for centralized validation. On app load, FE reads once and subscribes to Realtime so multi-device users see changes propagate.

## App-level Settings (MVP scope)

- **IB Connection**: status indicator (connected/disconnected/session expired/stopped), last sync time, Connect/Disconnect button (uses on-demand IBeam flow — see `../architecture.md` → IB Authentication Flow).
- **Signal Generation Threshold**: minimum `signalQuality` below which the BE doesn't generate a signal. Acts at generation time. Distinct from the Alerts feed display filter.
- **Signal min market value** ($): persists to `user_preferences.signal_min_market_value`.
- **Suppressed symbols**: text list — symbols where Analyze is disabled.
- **Profit-Taking Zone Threshold**: slider 0.5%-10%, default 2%, persists to `user_preferences.profit_zone_threshold_pct`. See `../signals/zone.md`.
- **Risk flags**: the tunable thresholds for the daily-grain danger flags (see `../signals/risk-flags.md`) — surge **X%** + window **N** sessions, volume **Y×** avg, RSI **Z**, near-52w-high **W%**, micro-cap **$C**, earnings-imminent **D** days. Persists to `user_preferences.risk_flag_config` (jsonb). Defaults seeded by the calibration pass; app-level because the flags apply to every ticker, not one screen.
- **Theme**: Dark / Light / System.
- **Analysis engine**: Provider dropdown listing only providers with a key configured on the server + an optional model field (blank = provider default). Persists to `app_config` via `POST /api/config/llm`. See `../signals/llm-provider.md`.
- **Notifications** (Batch 16): PWA push permission status, quiet-hours toggle.
- **Account**: Email, sign out.

## Reserved for per-screen settings (NOT here)

- Watchlist list activation (hide/unhide) → `watchlist.md` (gear icon in Watchlist screen header).
- TickerDetail Market Stats config (`stat_config`) → already in-screen ("Edit" link in Market Stats panel).
