# Dip-Bounce Scorer

Two pure-function scorers (intraday + swing) that rank tickers by likelihood
of bouncing from a current dip — run on `curated ∪ active-watchlist ∪ held`
(`curated-list.md` → Consumers), so every ticker on a visible imported list is
covered, not just curated names. Each fires Discord pings on
threshold cross and forward-tracks outcomes for rolling hit-rate
measurement. The character-signal counterpart to the manual `markers.md`
+ continuous `entry-zones.md` engines — composes their outputs into a
single ranked alert.

Sibling files:
- `curated-list.md` — the pool both scorers fire on.
- `stats.md` / `entry-zones.md` / `band-engine.md` — the signal inputs the
  scorers compose. None re-implemented here; the scorer is pure
  composition.
- `markers.md` — the manual cousin (user-authored levels); fully
  orthogonal, the two surfaces coexist on Discord and the FE.

## Two scorers, two channels

| scorer | channel | cooldown | hit-rate definition |
| --- | --- | --- | --- |
| `intraday_dip_bounce` | `#upside-intraday-suggestions` (env `DISCORD_WEBHOOK_SUGGESTIONS_INTRADAY`) | 4h per `conid` | `return_pct ≥ +1%` within 2h of fire |
| `swing_dip_bounce`    | `#upside-swing-suggestions` (env `DISCORD_WEBHOOK_SUGGESTIONS_SWING`)     | 24h per `conid` | `return_pct ≥ +5%` within 3 trading days of fire |

The two scorers are deliberately separate: their attention models differ
(intraday ping → react in seconds; swing ping → think over hours), and
their outcomes are measured at different horizons. A ticker can fire both
on the same day — independent events, independent cooldown clocks.

## Feeding the virtual lists

The two scorers rank the **`dip`** reason on the Intraday / Swing virtual lists
(`../screens/watchlist.md`). Those lists also include event names the scorers
don't score — `catalyst_reversal` and `post_earnings_drift` (via
`universe.auto_promoted`) — so the **list rank is a composite**: the dip-bounce
score for character names plus the trait's own score for event names. Horizon
mapping:

- `intraday_range_trader` (`dip`) → **Intraday**
- `catalyst_reversal` → **BOTH** (intraday volume-spike volatility *and*
  multi-day reversal)
- `post_earnings_drift` → **Swing**

Each row shows a `why` chip per qualifying reason (`dip` / `catalyst` /
`post-earnings`). The composite weights are calibration — set the same
throwaway way as the scorer weights below; don't hard-code them in the rank
function.

## Intraday scorer

Pure function `computeIntradayDipBounceScore(conid, asof_ts) →
{ score, components, fired }`. Reads `quotes`, `intraday_stats`,
`band_state`, `entry_zones` — no recompute, just composition.

```
INTRADAY_SCORE =
    IN_TYPICAL_BAND       * 30     // current drop from open in [p50, p75); see stats.md
  + MEAN_REVERSION_REGIME * 25     // band_state.session_regime ∈ {mean_reversion, mixed}
  + NOT_VOL_REGIME_SHIFT  * 15     // band_state.vol_regime_shift = false
  + ENTRY_ZONE_CONFLUENCE * 20     // entry_zones row for intraday horizon has confluence flag
  + ENTRY_ZONE_TREND_OK   * 10     // entry_zones.intraday.trend_regime ∈ {up, mixed}
```

Each input is 0 or 1. Score range 0–100.

**Critical guard:** `IN_TYPICAL_BAND = 0` if today's drop is past p75
(`deep` state from `stats.md`). Deep is *worse* than typical for
bounce — it's the outlier-day signal where the 60d prior misfires. Best
fires are inside `[p50, p75)`.

**Fires** when `score ≥ 70` AND last fire for this conid was > 4h ago.

## Swing scorer

Pure function `computeSwingDipBounceScore(conid, asof_ts) →
{ score, components, fired }`. Reads daily indicators from the existing
feature pack (`server/src/services/technicals.ts`) + the same tables as
the intraday scorer.

```
SWING_SCORE =
    DAILY_TREND_OK         * 30    // daily trend regime ∈ {up, mixed}
  + NEAR_ENTRY_ZONE_SWING  * 30    // within 1·ATR(daily) of overnight OR multiday entry-zone, AND that zone has confluence
  + NOT_BEARISH_TODAY      * 15    // today's session_regime ≠ bearish_trend (single-day veto)
  + RSI_PULLBACK           * 15    // daily RSI(14) ≤ 40 (showing pullback, not overbought)
  + NOT_VOL_REGIME_SHIFT   * 10    // band_state.vol_regime_shift = false
```

Each input 0 or 1. Score range 0–100.

**Fires** when `score ≥ 70` AND last fire for this conid was > 24h ago.

## Why these weights

The biggest weight goes to the *character* checks (typical-band membership
for intraday, daily trend for swing) because they're the strongest single
predictors of "will the dip bounce" by construction. Confluence follows —
multiple support methods clustering is the strongest level-quality signal
in `entry-zones.md`. The smaller-weight checks are vetoes against known
failure modes (bearish trend day, vol-regime-shifted name, overbought
swing entry).

All weights live in `server/src/config/dipBounceScorer.ts` as named
constants. The throwaway calibration script at ship sets v1 values to
produce roughly 1–3 fires/day per channel; subsequent tuning happens from
real forward-tracked outcome data after a month of fires.

## Cadence

Both scorers run on the same poll cycle that updates `quotes.canonical_price`
for tickers in `curated ∪ active-watchlist ∪ held` (~10s during IB-on regular
session, ~5min Finnhub fallback). The scoring step is cheap — pure table reads, no IB / Finnhub
calls.

## Forward-tracking (durable hit-rate infrastructure)

The single most important property of this batch is the forward-tracking
layer. It's generic across signal kinds — `band-engine.md`'s band-touch
events plug into the same tables once ported, as do `markers.md` fires.
**Measuring, tuning, and explaining these fires (expectancy, lift,
component attribution, per-regime split, the knob editor, per-ticker
suppress, live + historical explainability) lives in `signal-lab.md`
(Batch X8) — this section is just the capture layer it reads.**

- Every fire writes a `signal_fires` row capturing: `conid`, `signal_kind`,
  `score`, the `components` jsonb, `market_regime` (the proxy state at fire
  time — see `signal-lab.md`), `price_at_fire`, `fire_ts`. The `components`
  jsonb is the **explainable** breakdown `{ fired, weight, added, why }` per
  rule — `why` snapshots the raw engine values behind each rule so a fire is
  legible after the fact (see `signal-lab.md` → Explainability).
- `signalOutcomesCron` snapshots `quotes.canonical_price` for each fire at
  +30m / +2h / +1d / +3d and writes a `signal_outcomes` row per offset.
  `return_pct = (snapshot_price − price_at_fire) / price_at_fire × 100`.
- A SQL view `signal_hit_rate_30d` aggregates per `signal_kind`:
  `intraday_dip_bounce` reads `+2h` outcomes against the +1% threshold;
  `swing_dip_bounce` reads `+3d` outcomes against the +5% threshold.
- Schema: `../schema.md` → `signal_fires`, `signal_outcomes`.

The FE surface for hit-rate is a rolling-30d column on each virtual-list row
in the Watchlist screen (`../screens/watchlist.md`, Batch X2). Until X2 lands
the data is queryable via `bin/upside-psql` for calibration.

## Throwaway calibration (one-off, not maintained)

Before shipping, a one-off script `scripts/dip-bounce-backtest.mjs` runs
the proposed scorers against the last 60 sessions of bar data on the
curated list, eyeballs the fire rate (target: 1–3 fires/day combined
across both channels), and lets the implementer adjust the weights /
threshold constants before going live. The script is throwaway — not
maintained, not in the cron set. Forward-tracking is the durable layer;
the backtest just sets v1 calibration.

## Discord message format

Intraday:
```
🟢 SYMBOL — intraday dip-bounce (score 78)
    Current $4.18 · drop from open: 2.4% (typical band $4.20–$4.10)
    Session: mean_reversion · Entry-zone: $4.16 (confluence)
    [link to TickerDetail]
```

Swing:
```
🟢 SYMBOL — swing dip-bounce (score 74)
    Current $14.20 · daily trend: up · RSI(14): 38
    Overnight entry: $13.95 · Multiday: $13.20 (confluence)
    [link to TickerDetail]
```

Embed accent color matches the existing dip-buy channel's green.

## Cross-references

- Schema: `../schema.md` → `signal_fires`, `signal_outcomes`
- Inputs: `stats.md` (band position), `band-engine.md`
  (session_regime + vol_regime_shift), `entry-zones.md`
  (confluence + trend regime)
- Pool: `curated-list.md`
- FE surface (rolling hit-rate column, two ranked lists):
  `../screens/watchlist.md` → Upside-curated virtual lists (Batch X2 reshape)
