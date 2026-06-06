# Risk Flags

Daily-grain danger flags that mark a ticker as risky to **enter** (or hold into). Pump / momentum detection is the flagship; broader liquidity + event risks share the same mechanism. A flag answers "is there an obvious reason to be careful here?" — surfaced four ways: a badge on the card, a section in TickerDetail, a hard gate before LLM analysis, and explicit context (plus a confidence cap) inside the LLM prompt.

Sibling files: `playbook.md` (consumes flags as context + confidence cap), `../data/sources.md` (where each input comes from), `entry-zones.md` (shares the overbought primitive). Schema: `../schema.md` → `risk_flags`.

## Why daily-grain (not per-poll, not analysis-time-only)

Every input is daily-bar-derived — trailing N-day surge, RSI-14, distance-from-52w-high, market cap, average volume. A flag therefore only meaningfully changes day to day; per-poll recompute buys nothing. So:

- A **nightly cron** recomputes every flag for the working set and persists one `risk_flags` row per flagged `(conid, asof_date)`.
- The badge + section read the persisted row → always visible at a glance, **zero per-poll cost**.
- An **on-demand top-up** recomputes at Analyze time (we already build the feature pack then) so a freshly-opened ticker isn't waiting for the next nightly pass.

**A flag is not on a timer.** It stays raised for as many days as its condition holds and clears only when the condition stops being true — MNTS pumped into the $16–18 zone stays flagged every day it's still ~30% above where it was a week ago, and clears when the surge ages out of the window or price mean-reverts. The `since` date (first day the condition went true) is carried in the payload so the UI can say "flagged since Jun 2"; it's inherited from the prior day's row when the flag was already up, and reset on a fresh episode.

## Working set

The conids the nightly pass scores: **held positions + active-watchlist conids** (v1). Extend to `curated_list` membership once the dip-bounce track (Batch X1) ships — the curated pool is exactly the "things we might alert on" set. **Not** the whole universe: a flag is a per-ticker enter-risk read, only meaningful for tickers you'd actually look at.

## v1 flag catalog (zero / low new infra)

Each flag = `{ key, severity, since, payload }`. Every input is already pulled today (feature pack / Finnhub metrics / earnings calendar). Thresholds are **tunable** (Settings → Risk flags, see `../screens/settings.md`); the defaults below are seeds, set once by the calibration pass.

| key | condition | default seed | data source | tier |
|---|---|---|---|---|
| `price_surge` | price up ≥ **X%** over trailing **N** sessions | X = 25%, N = 5 | daily bars (already pulled) | WARNING |
| `volume_spike` | recent volume ≥ **Y×** 30-day avg | Y = 3× | `relativeVolume30d` (feature pack) + Finnhub avg vol | WARNING |
| `rsi_overbought` | RSI-14 > **Z** | Z = 78 | `momentum.rsi14` (feature pack) | WARNING |
| `near_52w_high_surge` | within **W%** of 52-week high **AND** `price_surge` active | W = 5% | `pctFrom52wHigh` (feature pack) | WARNING |
| `micro_cap` | market cap < **$C** | C = $500M | Finnhub `marketCapitalization` | WARNING |
| `earnings_imminent` | next earnings < **D** days away | D = 5 | Finnhub `/calendar/earnings` (already wired) | WARNING |

Notes:
- **`price_surge` is the spine** — the explicit "this rose on momentum, with no fundamental anchor" signal the feature pack doesn't carry today (it has `pctFrom52wHigh` and `priceVsSma*` but no trailing-N-session return). One small computed addition over bars we already fetch.
- **`near_52w_high_surge` is deliberately compound** (near-high ∧ surged-to-get-there) — the "bought at the peak" risk. A stock sitting quietly near its 52w high *without* a surge is not flagged.
- **`micro_cap`** — `universeFilter` already drops sub-$150M names from the screener universe, but held/watchlist names in the $150M–$500M band are still thin enough to flag.

## Severity tiers

- **WARNING** — a single isolated flag. Renders the danger badge + a row in the Risk-flags section. Does **not** gate analysis.
- **CRITICAL** — a confirmed pump: `price_surge` active **AND** ≥1 of {`volume_spike`, `rsi_overbought`, `near_52w_high_surge`}. Micro-cap escalates: `micro_cap` + any one corroborating flag also reaches CRITICAL (thin float amplifies a pump). CRITICAL renders the **pre-analysis gate** and triggers the **hard confidence clamp**.

The row's top-level `severity` is the max over its active flags' effective tier. The combination rule lives as one named constant block — not magic numbers inside the function.

## How flags feed the rest of the app

1. **Danger badge** — a distinct red (CRITICAL) / amber (WARNING) badge on the TickerCard, **separate from the signal pill**, on Portfolio + Watchlist. Visible at a glance without opening detail. See `../screens/portfolio.md` → Danger badge.
2. **Risk-flags section** — a collapsible section in TickerDetail listing each active flag with a one-line plain-language explanation + its `since` date. See `../screens/ticker-detail.md` → Risk flags.
3. **Pre-analysis gate (CRITICAL only)** — before LLM analysis can fire on a CRITICAL ticker, a DANGER modal: *"⚠ {SYMBOL} is up {X}% in {N} days with {flags}. Momentum plays have high reversal risk. Proceed?"* with an explicit confirm. Friction, not a silent override — the user can't accidentally analyze-into a pump. See `../screens/ticker-detail.md` → Pre-analysis gate.
4. **LLM prompt context + confidence clamp** — active flags pass to the prompt; the engine clamps the result. See `playbook.md` → Risk-flag context + confidence cap.

## LLM integration (mechanism in playbook.md)

Active flags flow into `contextualTriggers.riskFlags`. The prompt gains an explicit RISK-FLAGS block + instruction: if pump / surge flags are present, the rationale MUST address them and the signal MUST downgrade. Because a model can ignore an instruction, the engine **also** clamps deterministically: **CRITICAL → `signalQuality` hard-capped at ≤ 35** (the "low" band) after schema validation, regardless of the model's number. WARNING → no clamp, but the prompt still requires the rationale to address the flag. This makes "a pump can't emit a high-confidence BUY" a structural guarantee, not a prompt we hope holds.

## Calibration (throwaway — sets the v1 defaults)

The "+40%/5d vs +40%/20d" question — what surge window + threshold separates a momentum pump from a legitimate breakout — is answered empirically, not in the armchair. A throwaway script runs the proposed thresholds against the **SPCE / RGTI / MNTS dangerous-peak cases** (retro-validation) plus a sample of clean breakouts, picks defaults that flag the former without drowning in the latter, then is discarded. Same pattern as the dip-bounce backtest (`dip-bounce-scorer.md` → Throwaway calibration).

Going forward, "is a flag actually useful?" rides on the forward-tracking backbone: record flag-raises into `signal_fires` (kinds `risk_flag_*`) so `signal_outcomes` can answer *"of the tickers I flagged, how many actually reversed?"* — see `dip-bounce-scorer.md`. (Porting flag-raises onto `signal_fires` is a follow-up, not v1.)

## Deferred — new-data flags (v2)

Each needs a **new data source**, so each is its own data-plumbing slice — deferred to the roadmap, not dropped. See `../roadmap.md` → Risk flags v2: short-interest / % of float (squeeze risk), spread / liquidity (slippage), binary-catalyst calendar (FDA PDUFA / trial readout), news-narrative spike (headline-only move). Build each when a v1 flag in actual use proves it wants the extra signal.
