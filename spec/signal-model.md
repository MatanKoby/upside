# Signal Model

How Upside reasons about positions and tickers via the LLM. What the analysis produces, how it's persisted, how it ages.

## Unified SELL + BUY analysis

Every Analyze call produces a single **unified analysis** that evaluates **both** directions. The LLM's output schema always carries `sellSignal` and `buySignal` fields, **either or both of which may be null**. There is no SELL-only or BUY-only analyze path in MVP — the user taps one Analyze button, the LLM speaks to both directions, and a null is informative (LLM looked at this direction and saw no actionable case).

This means MVP collects BUY signal data from day one — even though the dedicated Watchlists screen doesn't ship until post-MVP Track 1 (see `roadmap.md`). BUY signals fire Discord notifications, accumulate in the `signals` table, accuracy-track via the same daily hindsight cron, and render on TickerDetail's Signal Section alongside any SELL signal. By the time Track 1's Active Watchlist UI lands, you have weeks of empirical BUY signal data already in the database.

**Naming consistency:** the LLM's confidence in its analysis is called `signalQuality` in the schema/code (0-100) and displayed as "Quality" in the UI. Avoid the word "confidence" outside LLM prompts to prevent ambiguity with the separate Price Proximity metric.

## Trigger

Manual only. Two-step intentional friction:
1. User taps "Analyze" on ticker detail.
2. Button greys out for 1 second.
3. Button shows "Confirm analyze" — user taps again to confirm.
4. Analysis runs (~5-15 seconds).

**Re-analyze soft-block:** if the user re-triggers Analyze on the same symbol within 5 minutes of the last completed analysis, the BE returns HTTP 429 with `{ lastAnalyzedAt }`. The FE renders "Last analyzed 3 min ago — re-analyze anyway?" with a confirm button. Confirm re-POSTs with `force: true`. Spends no LLM tokens by accident; doesn't get in the way of testing.

## Concurrency lock (Supabase + Realtime)

- `analysis_locks` table with row per active analysis: `{ symbol, user_id, started_at, status }`. See `schema.md`.
- Supabase Realtime broadcasts lock to all connected clients → Analyze button disabled everywhere.
- On completion (success or error), lock row deleted → button re-enables, new signal(s) appear via Realtime.
- Stale locks (>5 min old) auto-cleaned by cron. TTL chosen to comfortably exceed worst-case LLM response time.

## Pre-LLM filters (skip analysis entirely)

- Skip held positions with market value < $1,000 (configurable threshold). Watchlist (non-held) tickers have no market-value filter — the user explicitly put them on a watchlist.
- Skip symbols where user has manually disabled signal generation.

## Cost ceiling

Env `MAX_LLM_CALLS_PER_DAY` (default 50). Per-day counter in Redis (`llm_calls:YYYY-MM-DD`), resets at midnight UTC. When exceeded, `/api/signals/analyze` returns 429 with `{ reason: 'daily_limit_reached' }` and the FE renders "Daily analysis limit reached — resets at midnight UTC". **Each unified analysis counts as one call** regardless of how many signals it produces. Cheap insurance against runaway spend, especially once a paid provider is in use.

## LLM response validation

Every LLM response is parsed against a Zod schema. Malformed responses trigger one retry with a stricter "respond only in this JSON shape" prompt. Second failure persists a no-signal record (both `sellSignal` and `buySignal` null) with reason "LLM response malformed" and releases the lock — analysis fails soft, never crashes the api.

## LLM output schema (Zod-enforced)

```ts
type Analysis = {
  analysisId: string;                  // primary key for the analysis
  symbol: string;
  conid: number;

  // Shared context — produced once per analysis, applies to both directions
  indicatorAnalysis: IndicatorReadings; // structured per-indicator readings
  indicatorSnapshot: IndicatorValues;   // raw values captured at analysis time
  reasoning: string;                    // overall narrative synthesis

  // Per-direction conclusions, either may be null
  sellSignal: {
    priceRangeLow: number;
    priceRangeHigh: number;
    optimalPrice: number;               // = priceRangeHigh for SELL (selling high = better)
    signalQuality: number;              // 0-100
    motivation: 'take_profit' | 'derisk' | 'avoid_downside';
    timeframe: string;                  // e.g. "3-7 days"
    rationale: string;                  // direction-specific reasoning bullet
  } | null;

  buySignal: {
    priceRangeLow: number;
    priceRangeHigh: number;
    optimalPrice: number;               // = priceRangeLow for BUY (buying low = better)
    signalQuality: number;
    motivation: 'pullback_entry' | 'breakout_continuation' | 'value';
    timeframe: string;
    rationale: string;
  } | null;

  analyzedAt: string;                   // ISO timestamp
  expiresAt: string;                    // analyzedAt + max(sell.timeframe, buy.timeframe)
};
```

## Persistence (one analyses row + 1-2 signals rows per call)

Each non-null signal in the Analysis above writes one row to the `signals` table. Both rows share `analysis_id` (foreign key into the parallel `analyses` table holding the shared context). If both `sellSignal` and `buySignal` are non-null, two rows are written. If only one is non-null, one row. If both are null, one row is written with `signalType: 'no_signal'` (for history visibility).

This shape gives each direction independent accuracy tracking (SELL row tracks `actualMaxSinceAnalysis`, BUY row tracks `actualMinSinceAnalysis`) while preserving the atomic-snapshot property of the parent analysis. Full table definitions in `schema.md`.

## Atomic snapshot — re-analysis fully supersedes prior

Every Analyze call is unified and produces a complete snapshot of the LLM's view at moment T. The new analysis fully supersedes any prior analysis for the same `(user, symbol)`: prior `signals` rows from any earlier analysis_id get `supersededByAnalysisId` set to the new analysis_id, regardless of which directions the new analysis filled in.

Because every analysis is unified, this works cleanly — there's no partial-supersede edge case. T2's analysis always speaks to both directions (with nulls counted as "looked and saw nothing"), so T2 is always the complete current truth. The "I lost my BUY signal by re-analyzing" failure mode is structurally impossible.

Old signals remain in history forever (never deleted). Latest analysis is shown by default on TickerDetail with "Last analyzed: 3h ago · N previous analyses". A Signal History collapsible section shows the chronological list.

## Signal pill rendering

Each signal pill carries: type, quality, motivation, range.
- Example SELL pill: `[Sell · 82% · profit · $193-198]`
- Example BUY pill: `[Buy · 71% · pullback · $135-138]`

On TickerCards both pills render when both signals are present. Pill row policy: fit comfortably, wrap if needed, never truncate a signal pill — info badges are the things that get truncated to the +N overflow first. Two-pill-plus-badges may use a two-row pill layout when needed; final compaction is a UX iteration after first render.

## Mutability rules for `signals` rows

- **Immutable** (set on insert): `signalType`, `signalQuality`, `priceRangeLow`, `priceRangeHigh`, `optimalPrice`, `motivation`, `reasoning`, `indicatorBullets`, `indicatorSnapshot`, `analyzedAt`, `expiresAt`, `analysisId`.
- **Mutating** (updated by background jobs): `actualMaxSinceAnalysis`, `actualMinSinceAnalysis`, `enteredRangeAt`, `exitedRangeAt`, `actedOnAt`, `supersededByAnalysisId`.

The LLM's call doesn't change after the fact; only the realized-outcome data accumulates.

## Held + watchlisted ticker behavior

A ticker that is both held in Portfolio and present on one or more watchlists renders differently per surface:
- **Portfolio screen card**: held variant (P&L tint, weight bar, P&L numbers in center). Signal pills show whatever signals exist (SELL, BUY, or both).
- **Watchlist screen card** (each watchlist the ticker is on): watchlist variant (no P&L, BUY range in center when BUY signal exists, empty center when not). Signal pills show whatever signals exist.

Same ticker, same signals, two surfaces, two card layouts. No merge logic; both surfaces query the same `signals` table.

The held + watchlist case is also why the engine must produce unified analyses — a held ticker with a watchlist presence might legitimately want both a SELL signal (take profit on the held shares) and a BUY signal (add at lower entry). Holders aren't barred from BUY signals.

## Signal expiry

`expiresAt = analyzedAt + LLM-provided timeframe`. On expiry, the signal is hidden from active TickerCard / TickerDetail UI but kept forever in history. Accuracy fields keep updating for ~30 days post-expiry so "price hit target 2 days *after* the predicted window" is still recorded — useful learning data for future signal post-mortem (see `roadmap.md` → Track 4).

## No-signal as valid output

When the LLM returns both `sellSignal: null` and `buySignal: null` (with reasoning explaining why), the persistence layer writes one row with `signalType: 'no_signal'`. Visible in history. Not actionable on cards.

## Accuracy tracking (daily hindsight cron, not live)

- Once daily at ~4:30 PM ET, `accuracyUpdater` cron walks all non-superseded signals from the last 30 days.
- For each: fetch today's intraday candles (5-min or hourly bars) from Finnhub via the rate-limited queue.
- Update `actualMaxSinceAnalysis = max(prior, today_high)` (relevant for SELL accuracy), `actualMinSinceAnalysis = min(prior, today_low)` (relevant for BUY accuracy).
- Stamp `enteredRangeAt` the first time intraday price entered `[priceRangeLow, priceRangeHigh]`; stamp `exitedRangeAt` on first subsequent exit.
- This runs IB-independent (Finnhub-only), so accuracy tracking works even when the user has IB disconnected most of the time.
- Daily granularity is sufficient — we don't need tick-level accuracy data to evaluate signal quality empirically over weeks/months.

## Info badges (non-signal context, shown on cards)

- Earnings date proximity (e.g. "Earnings · 12d")
- Upcoming dividend dates
- Insider transactions (size/direction)
- Unusual volume (today vs 30d avg)
- Material news (sentiment-flagged via Finnhub)
- Analyst rating changes
- Extreme social sentiment (very positive or very negative)

All shown horizontally on the compact card with right-edge ellipsis (a small "+N" pill) if there are more badges than fit. Trading signal pills render FIRST, info badges after. Signal pills are never truncated.

## Profit-Taking Zone Detection (continuous)

A position enters "profit-taking zone" when its unrealized P&L percent crosses a user-configurable threshold (default +2.0%, configurable in Settings under `user_preferences.profit_zone_threshold_pct`). This unifies what would otherwise be separate concepts (pre-market gap alerts, run-up alerts, news rallies, drawdown recoveries) into one mechanism: any cause that pushes P&L across the threshold triggers the same flow. Dedicated pre-market gap detection is **dropped** in favor of this unified model; gap-driven entries get a small visual marker but no separate notification.

**State tracking (fields on `positions`):**
- `zone_entered_at timestamptz null` — when current zone-membership began. NULL when not in zone.
- `zone_exited_at timestamptz null` — when last zone-membership ended (kept for post-mortem).
- `last_zone_notification_at timestamptz null` — cooldown anchor.
- `entered_zone_via_gap boolean default false` — true if zone-entry happened between yesterday's close and today's open. Cleared at end of regular session.

Zone state is recomputed on every `positions` row write by both `ibPricePoller` and `finnhubPricePoller`. A position is `inZone` when `pnl_percent >= profit_zone_threshold_pct`.

**Notifications:**
- On zone-entry (transition `!inZone → inZone`), fire one Discord notification to `#upside-zone-profit` (one channel per alert type — separate from signal-range and any future zone channels — so the user can independently mute/enable each in Discord). Env var `DISCORD_WEBHOOK_ZONE_PROFIT`.
- Re-entry suppressed by a 4-hour cooldown keyed on `last_zone_notification_at`. Position can enter, exit, and re-enter within the cooldown window without triggering a new notification. Avoids chop spamming the user near the threshold.
- Zone-exit does NOT fire a notification in MVP (would create noise). Exit data is recorded for post-MVP analysis ("opportunity to take profit at +2.3% passed, position now at +0.8%").

**UI emphasis on TickerCard (held variant):**
- When `inZone === true`, render a small icon (specific glyph TBD at implementation; candidates: ⇡, lightning bolt, upward arrow) next to the P&L number on the card.
- On hover (desktop) or long-press (mobile), show tooltip: `"Profit-taking zone — P&L crossed +{threshold}% threshold. Consider analyzing."`.
- When `entered_zone_via_gap`, additionally render a small "GAP" badge near the zone icon for the current trading day. Reasoning: gap-driven moves frequently fade at open due to overnight profit-taking by others.
- Gap badge persists from market open until end of regular session, then clears. Zone state itself persists as long as P&L stays above threshold.
- Card structural layout is NOT altered — the icon and badge are the only affordances. Tapping either expands a small inline "Analyze for profit-taking?" shortcut that pre-fills the contextualTrigger.

**LLM context — `contextualTriggers`:**
- `signalEngine` includes a `contextualTriggers` field on every LLM analysis request, structured as:
  ```ts
  {
    inProfitTakingZone: { thresholdPct: number, currentPnlPct: number, viaGap: boolean } | null,
    // post-MVP: imminentEarnings, recentInsiderTransaction, unusualVolume, etc.
  }
  ```
- The LLM prompt reserves a "Contextual triggers" section. When triggers are non-null, the prompt instructs the LLM to address them specifically. For zone: "should we take profit here, or hold for more?" — and if `viaGap`, additionally: "zone entry was caused by an overnight gap, which often fades at open due to others taking profit."
- The framework is forward-compatible: new trigger types can be added without prompt re-engineering. **Reserved in the prompt structure from Batch 14a onward** even though only `inProfitTakingZone` is populated initially.
- **Status (2026-05-26):** zone *detection*, the Discord ping, and the card UI shipped in Batch 14c. Wiring `inProfitTakingZone` into the actual LLM prompt is **deferred** alongside the single-direction signal-engine redesign (see `CLAIMS.md` → Known issues) — no point tuning prompt context while the prompt itself is about to change.

## Realtime Update Architecture

- All clients subscribe to Supabase Realtime on `positions`, `signals`, `analysis_locks` tables.
- Backend writes to Supabase → Realtime pushes change notification to clients → clients pull updated data from Supabase (source of truth).
- Push notifications DROPPED from initial MVP and **re-added in Batch 16** as PWA push (web-push library, VAPID keys). Discord remains the developer/admin channel; PWA push is user-facing. Both fire on the same triggers (zone-entry, signal-range-entry).
- Offline users see updates when they next open the app (Realtime catches them up).

## LLM Provider Abstraction

- Provider-agnostic interface: `analyze(context) → unified analysis`, in `server/src/services/llm.ts`.
- **Current: Groq `llama-3.3-70b-versatile`** — proven in use, free tier. Served by `OpenAiCompatibleProvider`, one provider for every OpenAI chat-completions host (presets = base URL + a free-tier-friendly default model). **Mistral** (`mistral-small-latest`) is configured but **not yet exercised**; OpenRouter / OpenAI are available the same way. Add a preset to support a new host; base URL is coded per provider (no `LLM_BASE_URL` override).
- **Gemini** (`GeminiProvider`, native Google AI Studio REST) is implemented but **parked** — its free tier returned 429 on even a single analysis. Kept as a future option (e.g. on a paid/higher-quota tier). `ClaudeProvider` is a stub.
- **Selection is runtime, not env-locked.** The active provider + model live in `app_config` (`llm_provider` / `llm_model`); `.env` (`LLM_PROVIDER`, optional `LLM_MODEL`) is the boot fallback. Switched on the fly via `GET`/`POST /api/config/llm` (`services/llmConfig.ts`) and the Settings "Analysis engine" picker — **no restart**. **API keys stay in `.env`** — never in `app_config`, which the FE can read; only the *choice* is in Supabase. The endpoint only accepts a provider that is implemented and has a key configured.
- **Failure handling** (`LlmError{ kind }`): non-2xx is classified — `429`→`rate_limited`, `401/403`→`config`, else `unavailable`; only a 2xx body that fails JSON/Zod parsing is `malformed`. The engine re-prompts once (stricter) **only** on `malformed`; a rate-limit / outage / bad-key fails soft to a `no_signal` row with an honest reason instead of a misleading "malformed". Malformed responses carry a raw-body snippet to the `#errors` Discord channel for debugging.

## Data Sources (per analysis)

- **IB price data** (`ib-gateway:5000`): real-time prices (subscribe-then-poll snapshot), OHLCV bars (any interval/timeframe), volume, historical data (20+ years), fundamentals (P/E, EPS, market cap, beta, 52-week range), position/account data, transactions, account summary (incl. MTD return).
- **Computed locally from IB data**: RSI, MACD, Bollinger Bands, SMA/EMA, Stochastic, support/resistance, volume profile, **VWAP** (IB's snapshot endpoint does NOT expose VWAP as a field; we compute it from intraday history bars in `server/src/services/technicals.ts`), VWAP divergence, `tradingDaysHeld` (intended source: IB's transactions endpoint — verify at Batch 13.5 implementation; fallback: track entry-date in Upside from when we first see a position).
- **From IB account summary**: month-to-date (MTD) return — intended source `/v1/api/portfolio/<acctId>/summary` (verify at Batch 13.5). Fallback: compute from a lightweight position-value-at-month-start snapshot kept in Redis.
- **Finnhub**: company news + sentiment scores, insider transactions, earnings calendar + estimates, basic financials (supplementary), intraday candles (fallback price source when IB is disconnected, and primary source for daily hindsight accuracy tracking). All calls route through the rate-limited request queue — see `schema.md`.
- **Sparklines**: fetched live from IB (7 daily bars per ticker), current day updates in real-time. No overnight batch needed.
