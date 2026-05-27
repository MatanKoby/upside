# Signal Model

How Upside reasons about positions and tickers via the LLM. What the analysis produces, how it's persisted, how it ages.

> **Redesign in progress (Batch 14g/14h, 2026-05-26).** The original MVP shipped a *unified* SELL+BUY analysis (Batch 14a). It produced low-quality, vague signals ("sell in your current zone"), so we're moving to a **single-direction playbook** model. This doc describes the target design; the original unified model is preserved in `archive.md`. Batch split: **14g** = the playbook engine (fresh Analyze only); **14h** = live per-leg tracking + the Refine follow-up mode.

## Single-direction playbook analysis

Each Analyze evaluates **one** direction, chosen by **holding status**:
- **Held position → a SELL playbook** (take profit / derisk this position).
- **Not held (watchlist candidate) → a BUY playbook** (is this a good entry?).

Asking for a single direction keeps the model focused — the earlier "speak to both directions at once" call diluted quality. MVP is held-only (watchlists are post-MVP Track 1), so **every Analyze today produces a SELL playbook**; the BUY path is built and dormant until watchlists land.

The output is a **playbook**: an ordered list of concrete **legs**, each an action at a price with its own one-line reasoning and its own confidence, under a single time **horizon** and an overall thesis. Leg 1 is the immediate move; later legs are the round-trip guidance (e.g. sell → rebuy → resell).

**Naming consistency:** the LLM's headline conviction is `signalQuality` (0-100), displayed as "Quality." Per-leg conviction is `confidence` (0-100). Avoid "confidence" for the headline to prevent ambiguity with the separate Price Proximity metric.

## The computed feature pack (LLM grounding) — the core quality lever

We do the quantitative work **ourselves, deterministically**, and hand the LLM precise, named values. The LLM's job is to **narrate, choose levels, and rate** — never to calculate or invent prices. (LLMs are bad at arithmetic and will hallucinate levels; grounding every leg in a real computed level is the single biggest quality win.)

`server/src/services/technicals.ts` produces a feature pack per analysis:
- **Levels (the playbook's raw material):** classic pivots (P / R1–R2 / S1–S2 from prior session H/L/C), recent **swing highs/lows** (actual pivot prices), N-day and 52-week highs/lows, round-number magnets.
- **Volatility → move sizing:** **ATR(14)** (absolute + % of price). Sizes realistic pullbacks/targets (≈ N×ATR) instead of guessed numbers.
- **Trend:** SMA/EMA 20/50/200, price-vs-MA, slope / higher-highs-vs-lower-lows structure. MAs double as dynamic support/resistance.
- **Momentum & vol state:** RSI(14) + overbought/oversold flag, MACD (line/signal/hist + cross), Bollinger upper/mid/lower + %B + bandwidth (bands are reversion/target levels), relative volume (today vs 10/30-day avg), VWAP + distance.
- **Position-relative:** % from avg cost, % from 52-week high/low, distance to each key level.

**Prompt rule:** *anchor each leg to one of the provided levels and justify it with the indicators — do not invent prices.* This grounds the playbook in real data, cuts hallucinated numbers, and shifts the LLM from "calculate" to "synthesize" (also trims reasoning tokens). News is passed as headlines + sentiment only.

## Two Analyze modes

- **Fresh Analyze (14g):** cold analysis from the current feature pack. Supersedes any prior signal for the `(user, symbol)`. The only mode when no active signal exists.
- **Refine (14h):** a manually-triggered follow-up on an *active* signal. Sends the **fresh feature pack** (always the backbone — never reasons on stale data) **plus** the prior playbook and the **realized leg outcomes** from live tracking, asking the model to *revise* — with an explicit anti-anchoring instruction: *"the realized path outranks your prior view — revise, don't defend."* Supersedes the prior signal and records `refined_from_analysis_id` so history shows the chain ("refined 2× from the original").

Both modes share: the two-step friction, the 5-min soft-block, the daily cost ceiling, and the concurrency lock (below). The "Refine" button only appears when an active (non-expired) signal exists; otherwise it's a single "Analyze."

> **Why split 14g/14h:** the core unknown is *"does the playbook + feature-pack approach produce good signals?"* We validate that with Fresh Analyze on real tickers in 14g **before** layering live tracking + the Refine loop (14h) on top. If the base playbook is weak we fix the base, not build refinement on sand.

## Trigger

Manual only. Two-step intentional friction:
1. User taps "Analyze" (or "Refine") on ticker detail.
2. Button greys out for 1 second.
3. Button shows "Confirm" — user taps again to confirm.
4. Analysis runs (~5-15 seconds).

**Re-analyze soft-block:** re-triggering on the same symbol within 5 minutes of the last completed analysis returns HTTP 429 with `{ lastAnalyzedAt }`. The FE renders "Last analyzed 3 min ago — re-analyze anyway?"; confirm re-POSTs with `force: true`. Avoids accidental token spend without blocking testing.

## Concurrency lock (Supabase + Realtime)

- `analysis_locks` table with a row per active analysis: `{ symbol, user_id, started_at, status }`. See `schema.md`.
- Supabase Realtime broadcasts the lock → Analyze/Refine buttons disabled everywhere.
- On completion (success or error), the lock row is deleted → buttons re-enable, the new signal appears via Realtime.
- Stale locks (>5 min) auto-cleaned by cron (`lockCleanup`).

## Pre-LLM filters (skip analysis entirely)

- Skip held positions with market value < $1,000 (configurable: `user_preferences.signal_min_market_value`). Watchlist (non-held) tickers have no market-value filter.
- Skip symbols in `user_preferences.suppressed_symbols`.

## Cost ceiling

Env `MAX_LLM_CALLS_PER_DAY` (default 50). Per-day counter in Redis (`llm_calls:YYYY-MM-DD`), resets midnight UTC. When exceeded, `/api/signals/analyze` returns 429 `{ reason: 'daily_limit_reached' }`. **Each analyze counts as one call** — Fresh and Refine alike, regardless of how many legs the playbook has.

## LLM response validation

Every response is parsed against a Zod schema (direction-specific motivation enum). Malformed → one retry with a stricter "respond only in this JSON shape" prompt. Second failure persists a `no_signal` record with reason "LLM response malformed" and releases the lock — analysis fails soft, never crashes the api. A rate-limit / outage / bad-key fails soft immediately with an honest reason (not mislabeled "malformed").

## LLM output schema (Zod-enforced)

```ts
type AnalysisOutput = {
  // Shared context (produced once)
  indicatorAnalysis: Record<string, string>;  // per-indicator one-line readings
  reasoning: string;                           // overall thesis / synthesis

  // The single-direction playbook, or null = no actionable case (no_signal)
  signal: {
    direction: 'sell' | 'buy';                 // = holding-derived; the tracked signal_type
    signalQuality: number;                     // 0-100 headline conviction
    motivation:                                // direction-appropriate enum
      | 'take_profit' | 'derisk' | 'avoid_downside'        // sell
      | 'pullback_entry' | 'breakout_continuation' | 'value'; // buy
    horizon: 'intraday' | 'multiday';
    horizonWindow: string | null;              // multiday e.g. "1-2 weeks"; null for intraday
    legs: Array<{                              // ordered, >= 1; leg[0] = the immediate move
      action: 'sell' | 'buy';                  // sell / rebuy / resell …
      price: number;                           // anchored to a feature-pack level
      condition: 'at_or_above' | 'at_or_below' | 'about';  // geometric vs. current price (see note)
      confidence: number;                      // 0-100 per leg (decays down the chain)
      reasoning: string;                       // the per-leg "why", citing an indicator/level
    }>;
  } | null;
};
```

Notes:
- **`condition` is geometric, not directional.** It's set by where the leg's level sits relative to the current price, not by the leg's action: level **above** price → `at_or_above` (waiting for a rise), **below** → `at_or_below` (waiting for a fall), `about` at price. So a SELL into resistance above price is `at_or_above`; a protective exit below price is `at_or_below`; a pullback BUY at support below price is `at_or_below`, while a breakout-continuation BUY above price is `at_or_above`. This avoids the trap of a target level being tagged with the wrong side and collapsing leg 1 into "act now" (the prompt states the rule explicitly). Leg 1 is usually a **resting order** at a level price is expected to reach — not necessarily an action at the current price.
- **Horizon, not per-leg timing.** The playbook declares one horizon (intraday → plays out within the session; multiday → over `horizonWindow`). Leg timing is implied by order, not predicted per leg. Horizon drives expiry.
- **Per-leg confidence** is honest about compounding uncertainty — leg 3 ("resell *after* a hypothetical rebuy") is necessarily less knowable than leg 1. It also nudges the model to evaluate each step. Absolute calibration is poor (that's what 14b measures); the *relative* decay is the useful part.

## Persistence (one analyses row + ONE signals row per analyze)

- **`analyses` row:** shared context — `indicator_snapshot` (raw feature-pack values + the LLM's readings), `reasoning`, `analyzed_at`, `expires_at`, and `refined_from_analysis_id` (nullable; set by a Refine).
- **`signals` row (exactly one):** `signal_type` = the playbook direction (or `no_signal`), `signal_quality` = headline, `motivation`, and **leg[0] mapped to the existing `price_range_low`/`price_range_high`/`optimal_price` columns** (keeps accuracy tracking + the deferred range-notifications working against the immediate action). The full ordered legs + horizon live in a new **`playbook jsonb`** column.
- Migration `010_playbook.sql`: `signals.playbook jsonb`, `analyses.refined_from_analysis_id uuid null`. (`signal_type` already allows `sell | buy | no_signal` — no enum change.)

One signal per analysis (down from 1–2) makes supersede trivially clean.

## Atomic snapshot — re-analysis fully supersedes prior

Every analyze (Fresh or Refine) produces a complete snapshot at moment T and **fully supersedes** any prior analysis for the same `(user, symbol)`: prior non-superseded `signals` rows get `superseded_by_analysis_id` set to the new analysis_id. Latest = the current truth; a Refine additionally links back via `refined_from_analysis_id`. Old signals stay in history forever. TickerDetail shows the latest by default with "Last analyzed 3h ago · N previous"; a history section lists the chain.

## Live per-leg tracking (Batch 14h)

The price pollers (`ibPricePoller` / `finnhubPricePoller`), on each `positions` write, evaluate the active signal's playbook legs against live price — **no LLM, no cron** (piggybacks the existing cadence, like zone detection):
- Mark each leg `pending | hit | missed`, recording the actual extreme reached ("called 4.10, bottomed at 4.04 → missed low by 6¢").
- Persist runtime status onto the `playbook jsonb` legs.
- Derive a mechanical **on-track / diverged** state and nudge displayed conviction as legs confirm — *without* an LLM call. (You only spend a call to *change* the plan via Refine, not to say "still on track.")

This is also the realized data a Refine feeds back, and the live foundation that makes Batch 14b (hindsight accuracy) worth un-deferring.

## Signal pill rendering

One pill per signal now (single direction): `type · quality · motivation · leg[0] price`.
- Example: `[Sell · 78% · profit · $4.28]`

The pill shows the immediate action; the **full playbook** (ordered legs with per-leg confidence, reasoning, and live status) renders in TickerDetail's Signal section. Pill-row policy on cards: never truncate a signal pill; info badges truncate to a "+N" first.

## Mutability rules for `signals` rows

- **Immutable** (set on insert): `signal_type`, `signal_quality`, `motivation`, `price_range_low/high`, `optimal_price`, the authored `playbook` legs (price/action/condition/confidence/reasoning), `reasoning`, `indicator_snapshot`, `analyzed_at`, `expires_at`, `analysis_id`, `refined_from_analysis_id`.
- **Mutating** (background jobs): per-leg runtime `status`/`actual` (14h live tracking), `actual_max_since_analysis`, `actual_min_since_analysis`, `entered_range_at`, `exited_range_at`, `acted_on_at`, `superseded_by_analysis_id`.

The LLM's call doesn't change after the fact; only realized-outcome data accumulates.

## Signal expiry

Horizon-driven: **intraday** → expires at end of today's regular session (ET); **multiday** → `analyzed_at + horizonWindow` (parsed to days, default 7). On expiry the signal drops out of active UI but stays in history; accuracy fields keep updating ~30 days post-expiry (a target hit just after the window is still useful learning data — see `roadmap.md` → Track 4).

## No-signal as valid output

When `signal` is null (with `reasoning` explaining why), one row is written with `signal_type: 'no_signal'`. Visible in history, not actionable on cards.

## Held + watchlisted ticker behavior

Under single-direction-by-holding, a held ticker analyzes to a SELL playbook; a watchlist candidate to a BUY playbook. A ticker that is **both** held and watchlisted is a post-MVP (Track 1) concern: when watchlists ship, direction selection will key off the surface the Analyze was triggered from (portfolio → SELL; watchlist → BUY), producing two independent signals/analyses for the same symbol. No merge logic — both surfaces query the same `signals` table. (The original unified model produced both at once; we traded that for focus — see `archive.md`.)

## Accuracy tracking

- **Live, per-leg (14h):** the pollers mark each leg hit/missed against real price as it happens (above). This is the primary, IB-independent-ish signal of "is the playbook playing out."
- **Hindsight (Batch 14b, deferred):** a daily cron formalizes longer-horizon accuracy from Finnhub candles — `actual_max/min_since_analysis`, `entered_range_at`, `exited_range_at` — over a 30-day window, IB-independent. Deferred until base playbook quality is confirmed; the playbook makes it *more* valuable (each leg is a measurable checkpoint), so 14g/14h pull it back toward "soon."

## Info badges (non-signal context, shown on cards)

Earnings-date proximity, upcoming dividends, insider transactions, unusual volume, material news (sentiment-flagged), analyst rating changes, extreme social sentiment. Shown horizontally with a "+N" overflow pill. Signal pills render first and are never truncated; info badges truncate first.

## Profit-Taking Zone Detection (continuous)

A position enters "profit-taking zone" when its unrealized P&L percent crosses a user-configurable threshold (default +2.0%, `user_preferences.profit_zone_threshold_pct`). Any cause that pushes P&L across the threshold triggers the same flow; dedicated pre-market gap detection is **dropped** in favor of this unified model (gap entries get a visual marker, no separate notification).

**State (fields on `positions`):** `zone_entered_at`, `zone_exited_at`, `last_zone_notification_at`, `entered_zone_via_gap`. Recomputed on every `positions` write by both pollers; `inZone` when `pnl_percent >= profit_zone_threshold_pct`. (Shipped in Batch 14c.)

**Notifications:** on entry (`!inZone → inZone`), one Discord ping to `#upside-zone-profit` (`DISCORD_WEBHOOK_ZONE_PROFIT`; one channel per alert type). 4-hour re-entry cooldown anchored on `last_zone_notification_at`. Zone-exit doesn't notify in MVP.

**UI (TickerCard held variant):** a zone icon + (for `entered_zone_via_gap`) a "GAP" badge before the P&L, each with a tooltip; the gap badge clears at session end (`zoneGapCleanup`).

**LLM context — `contextualTriggers`:** `signalEngine` passes a `contextualTriggers` field on every analysis:
```ts
{ inProfitTakingZone: { thresholdPct, currentPnlPct, viaGap } | null,
  // post-MVP: imminentEarnings, recentInsiderTransaction, unusualVolume, … }
```
When non-null, the prompt surfaces it as **neutral context, not a directive**: it states the fact ("P&L has crossed +2%, entered via an overnight gap") and explicitly tells the model not to sell at the current price merely because of it — holding, waiting for a better level, or returning no signal are all valid. (An earlier "take profit here, or hold?" framing biased the model toward an immediate sell; corrected after the first live BBAI test.) **Wired into the prompt in Batch 14g** (the 14c-era deferral resolves here, since 14g rewrites the prompt anyway). Forward-compatible: new trigger types add prompt language without re-engineering.

## Realtime Update Architecture

- Clients subscribe to Supabase Realtime on `positions`, `signals`, `analysis_locks`.
- Backend writes → Realtime pushes change → clients pull from Supabase (source of truth).
- Push notifications re-added in Batch 16 as PWA push (web-push + VAPID); Discord stays the dev/admin channel. Both fire on the same triggers (zone-entry, signal-range-entry).
- Offline users catch up on next open.

## LLM Provider Abstraction

- Provider-agnostic interface: `analyze(context, { direction }) → single-direction playbook`, in `server/src/services/llm.ts`.
- **Current: Groq `llama-3.3-70b-versatile`** — free tier, proven. Served by `OpenAiCompatibleProvider` (one provider for every OpenAI chat-completions host; presets = base URL + default model). **Mistral** configured, not yet exercised; OpenRouter / OpenAI available the same way. **Gemini** (native REST) implemented but parked (free tier 429'd). `ClaudeProvider` is a stub.
- **Model strength matters for tactical reads.** Playbook quality (predicting levels/paths) depends heavily on the model — a free Llama will be weaker than a stronger model. Revisiting the provider is a follow-up once the playbook format is proven, **not** part of 14g.
- **Selection is runtime** via `app_config` (`llm_provider`/`llm_model`), switched through `GET`/`POST /api/config/llm` + the Settings picker — no restart. **API keys stay in `.env`**, never in `app_config`; only the *choice* is in Supabase.
- **Failure handling** (`LlmError{ kind }`): non-2xx classified (`429`→`rate_limited`, `401/403`→`config`, else `unavailable`); only a 2xx body failing JSON/Zod is `malformed`. Re-prompt once (stricter) only on `malformed`; everything else fails soft to a `no_signal` row with an honest reason. Malformed bodies carry a snippet to `#errors`.

## Data Sources (per analysis)

- **IB price data** (`ib-gateway:5000`): real-time snapshot (subscribe-then-poll), OHLCV bars (any interval/timeframe), volume, history, fundamentals, position/account data.
- **Computed locally from IB bars → the feature pack** (`technicals.ts`): the levels/volatility/trend/momentum/volume features above (pivots, swing highs/lows, ATR, SMA/EMA, RSI, MACD, Bollinger, VWAP + distance, relative volume, support/resistance). This is the LLM's grounding input — precise values, not raw bars.
- **Finnhub**: company news + sentiment, insider transactions, earnings calendar, basic financials; intraday candles (price fallback when IB is down, and the source for 14b hindsight accuracy). All via the rate-limited queue.
- **Sparklines**: 7 daily bars per ticker from IB, current day live.
