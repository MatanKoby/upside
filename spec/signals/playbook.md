# LLM Playbook Engine

How Upside reasons about positions and tickers via the LLM. What the analysis produces, how it's persisted, how it ages. Sibling files: `zone.md` (profit-taking zone detection), `markers.md` (user-defined price markers), `entry-zones.md` (dynamic entry-zone engine), `llm-provider.md` (provider abstraction), `data-sources.md`.

> **Status (2026-05-28):** the playbook engine (Batch 14g) is validated — well-formed, level-anchored, structurally correct. Signal *quality* still depends on model strength and the structure-feature work (deferred). Active product focus has pivoted to watchlists + LLM-free signals (`markers.md`, `entry-zones.md`); LLM-engine refinements are deferred behind that.

## Single-direction playbook analysis

Each Analyze evaluates **one** direction, chosen by **holding status**:
- **Held position → a SELL playbook** (take profit / derisk this position).
- **Not held (watchlist candidate) → a BUY playbook** (is this a good entry?).

Asking for a single direction keeps the model focused — the earlier "speak to both directions at once" call diluted quality. With the watchlist pivot, BUY playbooks become reachable for non-held tickers; the engine code is direction-agnostic.

The output is a **playbook**: an ordered list of concrete **legs**, each an action at a price with its own one-line reasoning and its own confidence, under a single time **horizon** and an overall thesis. Leg 1 is the immediate move; later legs are the round-trip guidance (e.g. sell → rebuy → resell).

**Naming consistency:** the LLM's headline conviction is `signalQuality` (0-100), displayed as "Quality." Per-leg conviction is `confidence` (0-100). Avoid "confidence" for the headline to prevent ambiguity with the separate Price Proximity metric.

## The computed feature pack (LLM grounding) — the core quality lever

We do the quantitative work **ourselves, deterministically**, and hand the LLM precise, named values. The LLM's job is to **narrate, choose levels, and rate** — never to calculate or invent prices. (LLMs are bad at arithmetic and will hallucinate levels; grounding every leg in a real computed level is the single biggest quality win.)

`server/src/services/technicals.ts` produces a feature pack per analysis:
- **Levels (the playbook's raw material):** classic pivots (P / R1–R2 / S1–S2 from prior session H/L/C), recent **swing highs/lows** (actual pivot prices), N-day and 52-week highs/lows, round-number magnets.
- **Volatility → move sizing:** **ATR(14)** (absolute + % of price). Sizes realistic pullbacks/targets (≈ N×ATR) instead of guessed numbers.
- **Trend:** SMA/EMA 20/50/200, price-vs-MA, slope / higher-highs-vs-lower-lows structure. MAs double as dynamic support/resistance.
- **Momentum & vol state:** RSI(14) + overbought/oversold flag, MACD (line/signal/hist + cross), Bollinger upper/mid/lower + %B + bandwidth, relative volume, VWAP + distance.
- **Position-relative:** % from avg cost, % from 52-week high/low, distance to each key level.

**Prompt rule:** *anchor each leg to one of the provided levels and justify it with the indicators — do not invent prices.* News is passed as headlines + sentiment only.

> **Structure feature is still blunt** (lower-lows label is the last-two-swings comparison only, can't tell coiling-near-lows from a downtrend, doesn't anchor to the prior major low). Decisions on ADX gate + major-low anchoring + RSI divergence + `consolidating` label are parked behind the watchlist pivot. See `roadmap.md` → "Structure-feature redesign (deferred)."

## Two Analyze modes

- **Fresh Analyze (14g):** cold analysis from the current feature pack. Supersedes any prior signal for the `(user, symbol)`. The only mode when no active signal exists.
- **Refine (14h):** a manually-triggered follow-up on an *active* signal. Sends the **fresh feature pack** (always the backbone — never reasons on stale data) **plus** the prior playbook and the **realized leg outcomes** from live tracking, with an explicit anti-anchoring instruction: *"the realized path outranks your prior view — revise, don't defend."* Supersedes the prior signal and records `refined_from_analysis_id`.

Both modes share: the two-step friction, the 5-min soft-block, the daily cost ceiling, and the concurrency lock (below).

## Trigger

Manual only. Two-step intentional friction:
1. User taps "Analyze" (or "Refine") on ticker detail.
2. Button greys out for 1 second.
3. Button shows "Confirm" — user taps again to confirm.
4. Analysis runs (~5-15 seconds).

**Re-analyze soft-block:** re-triggering on the same symbol within 5 minutes returns HTTP 429 with `{ lastAnalyzedAt }`. The FE renders "Last analyzed 3 min ago — re-analyze anyway?"; confirm re-POSTs with `force: true`.

## Concurrency lock (Supabase + Realtime)

- `analysis_locks` table with a row per active analysis. See `../schema.md`.
- Supabase Realtime broadcasts the lock → Analyze/Refine buttons disabled everywhere.
- On completion (success or error), the lock row is deleted → buttons re-enable, the new signal appears via Realtime.
- Stale locks (>5 min) auto-cleaned by cron (`lockCleanup`).

## Pre-LLM filters (skip analysis entirely)

- Skip held positions with market value < $1,000 (configurable: `user_preferences.signal_min_market_value`). Watchlist (non-held) tickers have no market-value filter.
- Skip symbols in `user_preferences.suppressed_symbols`.

## Freshness guard (fresh-or-stop)

Analysis MUST run only on fresh data. Before any LLM call the engine verifies both:

1. **Canonical price is fresh.** Reads the canonical quote (today: `positions.current_price` + `last_price_update_at`; Track 1: `quotes.canonical_price` + `canonical_updated_at` — see `../architecture.md` → Single source of truth for current price) and requires the timestamp within ~2 min during active markets (looser when closed). **No independent IB snapshot inside `signalEngine`** — a cold snapshot returns the prior close right after Connect; that's the failure mode this rule closes.
2. **Live IB feature pack is available.** Requires a successful IB history fetch (non-empty bars) for both intraday and daily series. **Analysis is IB-gated** — feature pack is built from IB candles; a free candle fallback isn't available yet (Track 9, post-MVP); Batch 13.3 (always-on secondary IB user) is the upstream unblock.

If either check fails, the engine **stops gracefully** — no LLM call, the lock is released, and a `signals` row with `signal_type: 'no_signal'` is persisted carrying the honest reason (`"live price stale"` / `"IB connection required for analysis"`). **Never silently fall back to stale data.**

**Frontend feedback (user-confirmed workflow):** the user expects an explicit "you forgot to connect IB" cue, not a silent stale result. So:
1. `/api/signals/analyze` **pre-checks IB connectivity** and returns `429 { reason: 'ib_required' }` *before* incurring an LLM-counter slot or lock. FE renders inline "Connect IB to analyze."
2. The Analyze button reflects live IB status; tooltip when disconnected.

*(Origin: BBAI live test on 2026-05-27 — three analyses captured ~$4.17 over 10h while live was $4.37 because the engine trusted a cold IB snapshot over the poller's fresh value.)*

## Cost ceiling

Env `MAX_LLM_CALLS_PER_DAY` (default 50). Per-day counter in Redis (`llm_calls:YYYY-MM-DD`), resets midnight UTC. Exceeded → 429 `{ reason: 'daily_limit_reached' }`. Each analyze counts as one call regardless of legs.

## LLM response validation

Every response is parsed against a Zod schema (direction-specific motivation enum). Malformed → one retry with a stricter prompt. Second failure persists `no_signal` with reason "LLM response malformed" and releases the lock — never crashes the api. Rate-limit / outage / bad-key fails soft immediately with an honest reason.

## LLM output schema (Zod-enforced)

```ts
type AnalysisOutput = {
  indicatorAnalysis: Record<string, string>;
  reasoning: string;
  signal: {
    direction: 'sell' | 'buy';
    signalQuality: number;
    motivation:
      | 'take_profit' | 'derisk' | 'avoid_downside'
      | 'pullback_entry' | 'breakout_continuation' | 'value';
    horizon: 'intraday' | 'multiday';
    horizonWindow: string | null;
    legs: Array<{
      action: 'sell' | 'buy';
      price: number;
      condition: 'at_or_above' | 'at_or_below' | 'about';
      confidence: number;
      reasoning: string;
    }>;
  } | null;
};
```

Notes:
- **`condition` is geometric, not directional.** Set by where the level sits vs. current price: above → `at_or_above`; below → `at_or_below`; at → `about`. A SELL into resistance above price is `at_or_above`; a pullback BUY at support below price is `at_or_below`. Leg 1 is usually a **resting order**, not necessarily an action at the current price.
- **Horizon, not per-leg timing.** Horizon drives expiry. Leg timing is implied by order.
- **Per-leg confidence** decays down the chain; absolute calibration is poor (14b measures), relative decay is the useful part.

## Persistence (one analyses row + ONE signals row per analyze)

- **`analyses` row:** `indicator_snapshot` (raw feature-pack values + LLM readings), `reasoning`, `analyzed_at`, `expires_at`, `refined_from_analysis_id` (nullable, set by Refine).
- **`signals` row (exactly one):** `signal_type`, `signal_quality`, `motivation`, leg[0] mapped to `price_range_low/high/optimal_price` (legacy columns, kept for accuracy + deferred range-notifications), full ordered legs + horizon on `playbook jsonb`.
- Migration `010_playbook.sql` already landed these columns.

## Atomic snapshot — re-analysis fully supersedes prior

Every analyze produces a complete snapshot at moment T and fully supersedes any prior for `(user, symbol)`: prior non-superseded `signals` get `superseded_by_analysis_id` set to the new analysis_id. Refine additionally links via `refined_from_analysis_id`. Old signals stay in history.

## Live per-leg tracking (Batch 14h)

The price pollers, on each `positions` write, evaluate active signal's legs against live price — **no LLM, no cron**:
- Mark each leg `pending | hit | missed`, recording actual extreme.
- Persist runtime status onto `playbook jsonb`.
- Derive mechanical **on-track / diverged** state.

## Signal pill rendering

One pill: `[type · quality · motivation · leg[0] price]` — e.g. `[Sell · 78% · profit · $4.28]`. Pill row policy: never truncate a signal pill; info badges truncate to a "+N" first.

## Mutability rules for `signals` rows

- **Immutable** (set on insert): `signal_type`, `signal_quality`, `motivation`, `price_range_low/high`, `optimal_price`, `playbook` legs, `reasoning`, `indicator_snapshot`, `analyzed_at`, `expires_at`, `analysis_id`, `refined_from_analysis_id`.
- **Mutating** (background jobs): per-leg runtime `status`/`actual`, `actual_max_since_analysis`, `actual_min_since_analysis`, `entered_range_at`, `exited_range_at`, `acted_on_at`, `superseded_by_analysis_id`.

## Signal expiry

**Intraday** → expires at end of today's regular session (ET). **Multiday** → `analyzed_at + horizonWindow` (parsed to days, default 7). Accuracy fields keep updating ~30 days post-expiry.

## No-signal as valid output

When `signal` is null (with `reasoning`), a row is written with `signal_type: 'no_signal'`. Visible in history, not actionable on cards.

## Held + watchlisted ticker behavior

A ticker that is both held and watchlisted: when Analyze fires, direction keys off the surface (portfolio → SELL; watchlist → BUY), producing independent signals. Both surfaces query the same `signals` table.

## Accuracy tracking

- **Live, per-leg (14h):** pollers mark hit/missed in real time.
- **Hindsight (Batch 14b, deferred):** daily cron computes `actual_max/min_since_analysis`, `entered_range_at`, `exited_range_at` over 30-day window from Finnhub candles. Deferred until base playbook quality is confirmed.

## Info badges (non-signal context, shown on cards)

Earnings-date proximity, dividends, insider transactions, unusual volume, material news, analyst rating changes, social sentiment. Horizontal row with "+N" overflow. Signal pills render first and never truncate; info badges truncate first.

## Realtime Update Architecture

- Clients subscribe to Supabase Realtime on `positions`, `signals`, `analysis_locks` (+ `quotes`, `watchlist_*` post-watchlist).
- Backend writes → Realtime pushes change → clients pull from Supabase.
- Push notifications re-added in Batch 16 as PWA push; Discord stays the dev/admin channel.

## Contextual triggers (zone, future events)

`signalEngine` passes `contextualTriggers` on every analysis:
```ts
{ inProfitTakingZone: { thresholdPct, currentPnlPct, viaGap } | null,
  riskFlags: { severity: 'warning' | 'critical', flags: Array<{ key, since, payload }> } | null,
  // post-MVP: imminentEarnings, recentInsiderTransaction, unusualVolume, … }
```

The zone trigger is surfaced to the LLM as **neutral context, not a directive**: states the fact ("P&L crossed +2%"), explicitly tells the model holding / waiting / no_signal are all valid. (An earlier leading framing biased the model toward an immediate sell.) See `zone.md` for the detection mechanism.

## Risk-flag context + confidence cap

When `contextualTriggers.riskFlags` is non-null, the engine injects a **RISK FLAGS** block into the prompt (one line per active flag, plain language) with an explicit instruction: *if pump / surge flags are present, the rationale MUST address them and the signal MUST downgrade — do not rationalise a momentum pump as a breakout.* This is the counter-weight to the prompt's existing "favour patience over selling into a base" / "weigh trend structure before mean-reversion" framing, which on a real pump would otherwise lean the model toward a BUY.

Because a model can ignore an instruction, the engine **also clamps deterministically** after schema validation:
- **CRITICAL** → `signalQuality` hard-capped at **≤ 35** (the "low" band), regardless of the model's number. Leg confidences are not rewritten, but a capped headline is recorded.
- **WARNING** → no clamp; the prompt requirement (rationale must address the flag) stands on its own.

The clamp makes "a pump cannot emit a high-confidence BUY" a structural guarantee rather than a prompt we hope holds. The **pre-analysis gate** that fronts a CRITICAL ticker is FE-side friction (see `../screens/ticker-detail.md` → Pre-analysis gate); this clamp is the BE-side backstop for when analysis does proceed. Flag definitions, tiers, and the working set live in `risk-flags.md`.
