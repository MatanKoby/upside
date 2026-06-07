# News-as-Signal (Batch X7)

**Status: design settled 2026-06-07, building.** News sentiment as a
risk-flags-style modifier — bad news raises a danger flag, good/bad magnitude
nudges virtual-list rank. Supersedes the deferred "news-sentiment sweep" noted
in `catalystReversalProducer` and the "news-narrative spike" v2 flag in
`risk-flags.md`.

## Idea

News moves a stock's **potential** the way an earnings report does: good news
lifts it (like a beat), bad news drags it (like a miss). `post_earnings_drift`
captures the earnings version; this is the always-on, between-reports version.

## Why it's a modifier, not a universe trait

Decided on **API economics**, not aesthetics. `post_earnings_drift` /
`catalyst_reversal` run universe-wide cheaply because earnings come from **one
bulk calendar call** (the X6 shared pull). **News has no bulk endpoint** —
`companyNews` is strictly per-ticker, so covering the ~5k universe is thousands
of calls/day, infeasible on free Finnhub. It therefore runs only over the small
set we actually care about: **held ∪ active-watchlist ∪ today's curated_list**
(dozens, not thousands) — the same "things we'd actually look at" set that
`risk-flags.md` → Working set already defines.

## Scoring: LM-inspired finance lexicon over `companyNews`

The clean source we wanted — Finnhub `/news-sentiment` (pre-aggregated bullish-%
+ buzz) — **returns 403 "no access" on our free key** (probed 2026-06-07; it's
premium). EDGAR carries no sentiment (raw filings only); Alpha Vantage's free
`NEWS_SENTIMENT` is rate-capped (~25/day) too tight to cover the set. LLM
scoring is **deferred** (it's the later upgrade on the same plumbing). So v1
scores headlines ourselves with a **curated, Loughran-McDonald-inspired finance
lexicon** — not the full LM CSV, a maintainable high-signal subset:

- Two weighted term sets (negative / positive), with a **severe tier** weighted
  ×2 (`fraud`, `bankruptcy`, `halts`, `sec probe`, `delisting`, `going concern`,
  `profit warning` … / `fda approval`, `beats`, `raises guidance`, `upgrade` …).
  Multi-word phrases matched as substrings; single words on token boundaries.
- Per-article score = Σ weighted matches over `headline + summary`, **recency-
  weighted** within the 48h window (last 24h ×1.0, 24–48h ×0.5).
- Aggregate score = clamped mean per-article sentiment → roughly `[-1, +1]`.
- `label` = `bearish` (≤ `bearishScore`) / `bullish` (≥ `bullishScore`) /
  `neutral`. `top_headline` = the article with the largest `|contribution|`
  (danger-first on ties).

The lexicon is the quality lever, so the scorer is a **pure, well-tested**
module (`server/src/services/news/` — `lexicon.ts` + `scoreNews.ts`).

A lexicon is an honest fit here: bad-news detection (the high-confidence path)
has high-signal negative vocabulary, which is exactly the danger-flag direction.
The good-news nudge is softer but useful. LLM scoring upgrades quality later
without changing the table or consumers.

## SSOT: the `news_sentiment` table

One fact, two consumers — so it gets its own table rather than living inside the
risk-flags payload (which is numbers-only and danger-only). See `../schema.md`
→ `news_sentiment`. One row per `(conid, asof_date)` when ≥1 article was scored;
holds `score`, `label`, `article_count`, `top_headline`, `top_url`, `source`
(`lexicon`). Realtime-published (the FE chip subscribes), instrument-keyed
grants (service_role write / authenticated read), same pattern as `risk_flags`.

**Producer:** `newsSentimentCron` — **not IB-gated** (news is Finnhub-only, so
it must keep working when IB is down, weekends included). Loads held ∪ watchlist
∪ curated, pulls `companyNews(48h)` per name (rate-paced for free Finnhub),
scores, upserts the row. Daily cadence.

## Consumer 1 — the `bad_news` risk flag

A new key in the `risk-flags.md` catalog (see that file → v1 flag catalog):

| key | condition | default seed | data source | tier |
|---|---|---|---|---|
| `bad_news` | news sentiment ≤ `newsBearishScore` over trailing 48h | −0.35 | `news_sentiment.score` (lexicon) | WARNING |

- **WARNING, never CRITICAL** — bad news is not a pump; it is *not* in the
  `CORROBORATING` set and does not escalate. It renders the danger badge + a
  Risk-flags section row + flows into the LLM prompt context (the existing
  `contextualTriggers.riskFlags` path), but does **not** trigger the
  pre-analysis gate or the confidence clamp (those stay CRITICAL-only).
- **Threshold is tunable** (`newsBearishScore` on `RiskFlagConfig`, Settings →
  Risk flags), same as every other flag.
- **Wiring:** `RiskFlagInputs` gains an optional `newsScore` (default null →
  no flag, so the existing `signalEngine` call keeps working unchanged).
  `riskFlagsCron` reads `news_sentiment.score` per target and passes it;
  `signalEngine`'s on-demand top-up scores its *already-pulled* `companyNews`
  payload (freshest, zero extra call) and passes it. The flag payload carries
  `{ news_score, articles }` (numbers); the **headline** lives in
  `news_sentiment` for the FE to join (the flag payload can't hold strings).

## Consumer 2 — virtual-list rank nudge + news chip

`useVirtualList` joins `news_sentiment` by conid (today, UTC) and:

- adds a **news rank term** to the composite (`weights.news × score`, positive
  lifts / negative sinks) — the "ranking modifier" half. News does **not** add
  list members (it's a modifier, not a membership reason), so it is not a
  `ReasonChip`; it's a separate `news` field on `VirtualRow`.
- renders a **📰 news chip** (bullish/bearish colour, `top_headline` in the
  title) on the row.
- subscribes to `news_sentiment` Realtime alongside the existing tables.

## Decay

Short — the **48h** scoring window *is* the decay: an article ages out of the
window in two days and stops counting. No separate decay curve in v1; align with
the catalyst/drift horizons. Revisit if 48h proves too sticky or too jumpy.

## Dedup — a non-issue

The original spec worried about double-counting `catalyst_reversal`. It doesn't:
`catalystReversalProducer` Stage 0 keys off the **earnings calendar** (reporter
set), **not news** (its header literally defers the news sweep). So news-as-
signal is genuinely additive — X7 *is* that deferred sweep, now built.

## Cleanup

Delete the unreachable `newsSentiment()` in `finnhub.ts` (premium / 403, called
by nothing) and its `sources.md` entry.

## Deferred follow-ups

- **LLM scoring** of headlines (quality upgrade on the same table/consumers).
- **Headline into the Risk-flags section + the LLM prompt** (today the section
  shows the score; the chip carries the headline).
- **Un-gate `riskFlagsCron` from IB** by repointing it to X4's `daily_bars` —
  then the `bad_news` flag refreshes off-hours too (the table already does, via
  the non-IB-gated `newsSentimentCron`).
- **Forward-tracking:** record `bad_news` raises into `signal_fires`
  (`risk_flag_bad_news`) once the risk-flag→`signal_fires` port lands
  (`risk-flags.md` → Calibration).

## Cross-references

- Schema: `../schema.md` → `news_sentiment`
- Data: `../data/sources.md` → Finnhub (`companyNews`), `../data/consumers.md`
  → `newsSentimentCron`
- Siblings: `risk-flags.md` (the flag mechanism + working set), `curated-list.md`
  (ranking), `dip-bounce-scorer.md` (the virtual-list composite)
