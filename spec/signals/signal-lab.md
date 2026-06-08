# Signal Lab — effectiveness measurement, tuning & explainability

The un-deferral of **Batch 14b** (hindsight accuracy) applied to the **LLM-free
engine signals that actually ship** — not the LLM analysis track. The LLM-accuracy
work stays parked in `../roadmap.md` → Track 4; the live engines (intraday + swing
dip-bounce now; entry-zone, stats-band, marker, zone-entry once ported) get measured,
tuned, and explained here.

Built **on top of** the forward-tracking backbone in
[`dip-bounce-scorer.md`](dip-bounce-scorer.md) → Forward-tracking (`signal_fires` /
`signal_outcomes` / `signal_hit_rate_30d`). No parallel plumbing.

## Scope & non-goals

- **No LLM, no trained model.** The engines already *are* the per-ticker analyst —
  deterministic, free, per-ticker by construction (their inputs are per-ticker; only the
  weights are shared). A stock-analyst SLM is explicitly out of scope (cost).
- **No pruning.** All `signal_fires` / `signal_outcomes` are kept forever — they're cheap
  (sub-MB/year vs. the 92 MB `external_api_metrics` log) and replay needs them. "Closing a
  signal" means *writing findings*, not deleting evidence.
- **Read-first.** The lab measures and **recommends**; knob changes are
  recommend-then-approve, never auto-applied in v1.

## Three measurement layers

### 1. Does each signal type add edge? (go/no-go)
- **Expectancy** = mean `return_pct` at the kind's horizon. The number that matters — a
  high hit-rate with fat losers is still a losing edge.
- **Lift over base rate** = signal hit-rate − the *unconditional* rate of the same move
  over the same pool/horizon (random `conid`×timestamp sample from `quotes`). The "beats
  noise" test.
- **MFE / MAE** in-window (max favorable/adverse excursion), approximated from the four
  stored offsets — tells you whether the move was tradeable and where stops/targets sit.

### 2. Which knob to turn? (tuning)
- **Score-bucket calibration** — expectancy per score bin (70–80 / 80–90 / 90–100); a
  healthy scorer rises monotonically. If 90+ doesn't beat 70–80, the high end is noise.
- **Component attribution** — expectancy sliced by each `components` flag (fires where
  `ENTRY_ZONE_CONFLUENCE=1` vs `0`). The most actionable analytic, near-free given the
  enriched `components` jsonb. This is what drives the weights.

### 3. When does everything need adjustment? (regime)
- Stamp each fire with the **market regime at fire time** (`signal_fires.market_regime`).
- Expectancy **per regime** → "dip-bounce inverts in broad high-vol pullbacks" becomes
  measurable instead of anecdotal.
- **Rolling 7/14d expectancy** per kind = the automated "regime turned, recalibrate /
  suppress" trigger (and the lever that thins the alert firehose).

## Market-regime proxy

Four instruments, no per-name model needed (`regime_proxy`, see `../schema.md`):

| symbol | role | notes |
| --- | --- | --- |
| SPY | trend — large-cap | broad market |
| QQQ | trend — Nasdaq-100 | tech tilt |
| IWM | trend — Russell 2000 | **small-cap — closest to our universe** |
| VIX | vol — fear gauge | no constituents; regime input only |

Daily bars come from `daily_bars` (Polygon) like any other symbol; the regime label is
derived the same way `band-engine.md` derives per-ticker regime, but over the proxies.

### Umbrella membership — which proxy actually matters
`etf_constituents` (`../schema.md`) maps member ticker → ETF. `regime_proxy.recommended_count`
= our current rec set ∩ each ETF's constituents — if the universe is IWM-heavy we weight the
small-cap regime, not the S&P. A name in multiple ETFs (e.g. NVDA ∈ SPY ∧ QQQ) counts under
each. **Source = ETF issuer holdings files** (free, complete, authoritative — the JSON
holdings APIs paywall the actual list); see `../data/sources.md` → ETF constituents.

## Tuning: the knob editor (recommend-then-approve, with replay)

- Scorer weights/thresholds move from compile-time constants (`config/dipBounceScorer.ts`)
  to a runtime `signal_knobs` table (`../schema.md`), Realtime so the scorer picks up edits.
  Code constants remain the **fallback** when a row is absent.
- The lab **proposes** a change ("drop `ENTRY_ZONE_CONFLUENCE` weight — no edge over 200
  fires") and **replays** past fires to show what hit-rate/expectancy *would have been* —
  you never tune blind. Approve → write to `signal_knobs`. Auto-apply is out of scope (v1).

## Per-ticker: keep / suppress (not per-ticker tuning)

Knobs stay **global** — one recipe per kind; per-ticker weight-fitting overfits on the
handful of fires a ticker produces. The per-ticker lever is one bit: if a ticker's fires
show negative expectancy over enough samples, **suppress** that kind on that ticker. Stored
in `signal_suppressions` (`../schema.md`); the scorer cron skips a suppressed (conid, kind).

## Findings (the "close a signal" output — minus the pruning)

`signal_findings` (`../schema.md`) holds the lab's durable conclusions at two grains, for
two actions:

| grain | drives |
| --- | --- |
| per `signal_kind` (+ regime split) | the **global knobs** (reweight) |
| per (`signal_kind`, `conid`) | **keep / suppress** that name |

Raw fires/outcomes are retained (replay), so a finding is a snapshot you can always recompute.

## Explainability

Every score is a weighted composition of engine sub-signals — show the user *why* it's what
it is, and let them compare it to what they see on the chart.

- The `components` jsonb (`../schema.md` → `signal_fires`) is enriched from a flat 0/1 map to
  `{ fired, weight, added, why }` per component, where **`why` carries the raw engine values**
  behind the rule (e.g. `{ drop_from_open_pct, band_p50, band_p75 }`), **snapshotted at fire
  time**.
- **Historical Explain:** the lab drills into any past fire → its stored breakdown. Pairs
  with component attribution (attribution = quantitative across all fires; Explain = one
  fire's `why`).
- **Live Explain:** the pure scorer (`computeIntradayDipBounceScore`, already pure over its
  inputs) moves to a **shared module** importable client-side. `useVirtualList` adds
  `intraday_stats` + `entry_zones` to its Realtime subscription and runs the scorer per row —
  **one call yields both the score and the breakdown, recomputed every tick.** So the live
  score and its Explain are the *same computation*: never stale, no API round-trip, guaranteed
  consistent.
  - Whether to surface the score **number** on the row is **TBD** — decide once the virtual
    lists actually populate and a row is visible. The mechanism above holds regardless.
  - **Swing** reads a daily feature pack from `daily_bars` (not Realtime-published), so its
    daily inputs are fetched once per load while the quote-driven part stays live client-side.

## Cross-references

- Backbone + the two scorers: `dip-bounce-scorer.md`
- Regime/stats inputs: `band-engine.md` (session/vol regime), `stats.md` (typical band)
- Tables: `../schema.md` → `signal_fires` / `signal_outcomes`, `regime_proxy`,
  `etf_constituents`, `signal_findings`, `signal_suppressions`, `signal_knobs`
- Constituent + proxy data sources: `../data/sources.md` → ETF constituents
- LLM-track accuracy (parked): `../roadmap.md` → Track 4
