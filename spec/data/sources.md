# Data Sources — the producer catalog

Every external data source Upside reads from: the requests we make, the fields
we use, and **where each lands** (table.column, or "ephemeral — computed, not
stored"). Paired with [`consumers.md`](consumers.md) (who reads the stored data)
and [`../schema.md`](../schema.md) (the table definitions). The goal of this
catalog is a **single source of truth per data type** — one writer-policy per
field, no redundant pipelines, and a clear fallback posture so the system stays
up when any one provider is down.

Maintenance rule: when you add/remove an external call or change where its
output is stored, update the relevant table here **and** the consumer entry in
`consumers.md`. If a field has two writers, that's a SSOT violation — flag it in
*Observations* below.

All IB + Finnhub calls are instrumented to `external_api_metrics`
(`provider`, `endpoint`, `duration_ms`, `status`, `succeeded`) and routed through
their rate-limit/availability gates (IB: on-demand IBeam + `ibStatus` gate;
Finnhub: `finnhubQueue`). Polygon/Yahoo are not yet instrumented.

---

## 1. IB Client Portal Gateway

`server/src/services/ibGateway.ts` → `http://ib-gateway:5000`. On-demand IBeam
(usually OFF; started from the Upside app, manual 24h re-auth). Rate-limited per
`../schema.md` → IB API Rate Limits. **The live-data source when connected** —
and the only source for **intraday-depth OHLCV bars** today.

| Request | What we use | Stored in | Primary consumers |
| --- | --- | --- | --- |
| `POST /tickle` | session keepalive | — | `keepalive` cron |
| `GET /iserver/auth/status` | `authenticated` / `connected` | — (in-memory) | every IB-gated cron via `ibStatus()` |
| `GET /portfolio/{acct}/positions/0` | holdings: conid, symbol, qty, avgCost, mktPrice, mktValue, unrealized | `positions` | `ibPricePoller` |
| `GET /pa/transactions` | cost-basis / entry reconstruction | `positions` (entry fields) | `ibPricePoller` (`entryFromTransactions`) |
| `GET /iserver/account/trades` | recent fills / entry | `positions` (entry) | `ibPricePoller` (`entryFromTrades`) |
| `GET /iserver/marketdata/snapshot` | live intraday quote (last, bid/ask, change) | `positions.current_price`, `quotes` | pollers, `routes/marketdata` |
| `GET /iserver/marketdata/history` | **OHLCV bars** (any interval) → intraday-stats, band engine, entry zones, feature pack, chart, sparkline-fallback | **ephemeral → computed** | `intradayStatsCron`, `bandEngine`, `entryZonesCron`, `signalEngine` feature pack, `routes/marketdata` (history; sparkline fallback only). **Daily-grain readers moved to `daily_bars` (Batch X4):** `curatedListCron` + `dipBounce` swing pack no longer call this. |
| `GET /iserver/contract/{conid}/info` | contract metadata | `contracts` | `ibPricePoller`, `signalEngine` |
| `GET /iserver/secdef/search` | symbol → `real_conid` | `universe.real_conid`, `contracts` | `conidResolutionProducer` |
| `GET /iserver/watchlists` + `/iserver/watchlist` | IB-side watchlists (import) | `watchlist_lists`, `watchlist_items` | `services/watchlists` (sync) |
| `ibRawGet` / `ibRawPost` (allowlisted) | debug passthrough | — | `routes/debug` |

**Reliability caveat:** `/iserver/marketdata/history` returns **HTTP 503 during
US off-hours / weekends** (the market-data farm isn't serving). Batch X4's
`daily_bars` layer closed the daily-grain exposure (Polygon-primary, weekend-safe);
the remaining IB-only readers are **intraday-grain** — band engine + entry-zone cron
(5-min bars) + the live snapshot path — which Polygon free can't supply.

---

## 2. Finnhub

`server/src/services/finnhub.ts` → `https://finnhub.io/api/v1`. Free tier
(60/min), routed through `finnhubQueue`. **IB-independent** — works whether or not
IB is connected, which is why it owns fundamentals + the price fallback.

| Request | fn | What we use | Stored in | Consumers |
| --- | --- | --- | --- | --- |
| `/stock/symbol?exchange=US` | `getSymbolList` | ~30k US symbols (Ring 0) | `universe` (rows) | `universeCron` |
| `/stock/profile2` | `getProfile2` | `marketCapitalization` (millions), name | `universe.last_market_cap_m` | `universeCron`, `marketCapRefreshCron` |
| `/stock/metric?metric=all` | `basicFinancials` | 52w hi/lo, PE, EPS, beta, etc. | **ephemeral** (risk-flag inputs, analyses) | `riskFlagsCron`, `signalEngine` |
| `/quote` | `getQuote` | last/high/low/open/prevClose/change (**no volume**) | `positions.current_price`, `quotes` (fallback) | `finnhubPricePoller`, `watchlistQuotePoller`, `universeCron` |
| `/calendar/earnings?from&to` | `earningsCalendarRange` | bulk earnings dates (epsActual/estimate, hour) | **ephemeral** → `trait_scores` | `catalystReversalProducer`, `postEarningsDriftProducer` |
| `/calendar/earnings?symbol` | `earningsCalendar` | per-symbol next/last earnings | **ephemeral** (earnings-imminent flag, analyses) | `riskFlagsCron`, `signalEngine` |
| `/company-news` | `companyNews` | headlines for the LLM | **ephemeral** (analyses) | `signalEngine` |
| `/stock/insider-transactions` | `insiderTransactions` | insider activity for the LLM | **ephemeral** (analyses) | `signalEngine` |
| `/news-sentiment` | `newsSentiment` | aggregated sentiment score | — | **none — defined but unused** (see *Observations*) |

**`/stock/candle` is paid-tier only** (403 on free as of 2026-05) — Finnhub is
**not** a bar source. Bars come from IB (and, per the plan, Polygon).

---

## 3. Polygon

`server/src/services/universeQuote.ts` → `https://api.polygon.io`. Free key,
5 calls/min. **Whole-universe daily OHLCV in one call** — and weekend-safe
(historical data serves any time).

| Request | What we use | Stored in | Consumers |
| --- | --- | --- | --- |
| `GET /v2/aggs/grouped/locale/us/market/stocks/{date}` | every US stock's daily O/H/L/C/V for one date | `daily_bars` (full OHLCV, Batch X4), `universe.last_price` (close), `universe.last_volume` (single-day) | `universeQuoteProducer` |

**`daily_bars` (Batch X4):** `universeQuoteProducer` now appends the most-recent
weekday's grouped-daily bar per universe row into `daily_bars` each run, with a
30-day bootstrap on gaps (30 trailing grouped-daily calls = full 30-day OHLCV for
the entire universe, rate-limited to the free 5/min). This is the **daily-grain
SSOT** — enough to compute **both ATR% and ADV with no IB calls**, weekend-safe.
`universe.last_avg_volume` (the 30d median ADV, never previously written — root
cause of the empty curated list, Batch X3 routed around it) is now derived from
`daily_bars` in one SQL statement (`refresh_universe_avg_volume`).

---

## 4. Yahoo (unofficial)

`server/src/services/universeQuote.ts` → `https://query1.finance.yahoo.com`.
Keyless, ToS-gray, per-symbol. **Gap-fill only**, into the *same* `universe` rows
Polygon writes (so it stays a single source of truth, not a parallel pipeline).

| Request | What we use | Stored in | Consumers |
| --- | --- | --- | --- |
| `GET /v8/finance/chart/{symbol}` | O/H/L/C/V for tickers Polygon's grouped response misses (IPOs, halts) | `universe.last_price`, `universe.last_volume`, `daily_bars` (`source='yahoo'`, when the row's `real_conid` is known) | `universeQuoteProducer` (`fallback_yahoo_quote` job) |

---

## 5. Planned (post-MVP — screener / catalyst track)

Listed so downstream batches have a known plan; none wired yet.

- **SEC EDGAR full-feed RSS** — real-time filings firehose (8-K/10-Q/10-K/Form 4). Free, 10 req/s. Primary catalyst-news source when it ships. `../roadmap.md` → Track 10.
- **FDA Drug Approvals RSS** — biotech catalyst signal. Free, high-precision.
- **PR Newswire / BusinessWire / GlobeNewswire RSS** — company press releases; ticker extraction by regex + `universe` lookup.
- **Nasdaq Trader RSS** — corporate actions + **trading halts** (pre-news price signal).
- **SEC EDGAR API** (`data.sec.gov`) — official fundamentals; planned Finnhub supplement.
- **Alpaca Market Data (IEX free)** — backup bar/quote provider if Polygon hits limits.

---

## S0.5 universe-coverage decision (2026-06-02)

The screener needs price + volume on the ~3,000-ticker universe. Finnhub `/quote`
has no volume; IB is rate-limited + on-demand. Evaluation:

| Source | Has volume | Coverage | Free-tier rate | Auth | Verdict |
| --- | --- | --- | --- | --- | --- |
| **Polygon** grouped-daily | ✓ | **all US stocks / 1 call** | 5/min | free key | **PRIMARY** |
| **Yahoo** v8/chart | ✓ | per-symbol | ~few hundred/hr | none | **FALLBACK** (gaps only) |
| Yahoo v8/spark | close only | batch | — | none | rejected — no volume |
| Yahoo v7/quote | ✓ | batch | crumb-cookie | brittle | rejected — auth hack |
| Alpaca (IEX free) | ✓ | ✓ | unlimited | brokerage acct | revisit if Polygon limits |
| Twelve Data free | ✓ | partial | 800/day | key | rejected — daily cap |

### Caching cadence

| Field | Source | Cadence | Daily call cost |
| --- | --- | --- | --- |
| `daily_bars` (full OHLCV) | Polygon grouped-daily | nightly append + 30d bootstrap on gaps | 1 call steady-state; ~30 on first run (rate-limited) |
| `universe.last_price` | Polygon grouped-daily | nightly | (same primary call) |
| `universe.last_volume` | Polygon grouped-daily | nightly | (same call) |
| `universe.last_avg_volume` (30d median) | `daily_bars` → `refresh_universe_avg_volume()` | nightly (after bars written) | 0 (one SQL statement) |
| per-ticker gap-fills | Yahoo v8/chart | nightly, gaps only | ~tens |

### Interface

```typescript
// server/src/services/universeQuote.ts
export interface DailyOhlcv { open; high; low; close; volume: number; }
export async function polygonGroupedDaily(date: string): Promise<Record<string, DailyOhlcv>>;
export async function yahooChart(symbol: string): Promise<DailyOhlcv | null>;
```

---

## Reliability posture — single source of truth per data type

| Data type | SSOT (primary) | Non-IB fallback | Status |
| --- | --- | --- | --- |
| Live intraday price | IB snapshot → `positions.current_price` / `quotes.canonical_price` | Finnhub `/quote` | ✅ wired |
| Fundamentals (cap, 52w, PE…) | Finnhub | SEC EDGAR API (planned) | ✅ wired |
| Earnings calendar | Finnhub | — | ✅ wired (single-source) |
| News / catalyst | Finnhub | SEC/PR/FDA RSS (planned) | ⚠️ thin |
| Universe daily price+volume | Polygon | Yahoo (gap-fill) | ✅ wired |
| Daily OHLCV bars → ATR / ADV / swing packs / sparkline | **Polygon → `daily_bars`** (Batch X4) | Yahoo (gap-fill) | ✅ wired |

The **daily-bars gap is closed (Batch X4):** the `daily_bars` table is sourced from
Polygon grouped-daily (primary) → Yahoo (gap-fill), appended nightly + a 30-day
bootstrap, and the curated-list probe / swing dip-bounce pack / sparkline route now
read it instead of IB history. Polygon is the SSOT for daily grain; IB is demoted
to **live-only** (snapshots + intraday 5-min bars, where it's genuinely best).
Two daily-grain consumers still call IB directly and are *not* repointed: the
**band engine** + **entry-zone cron** both need intraday 5-min bars (Polygon free
is daily-only) and so remain inherently IB-gated. Pre-market intraday snapshot
volume for `catalyst_reversal` Stage-1 stays IB for the same reason.

## Observations (for the table/pipeline audit)

1. ~~**Daily bars are the only un-fallback'd source**~~ — **RESOLVED (Batch X4):** the `daily_bars` table (Polygon-primary, Yahoo gap-fill) is the daily-grain SSOT; curated cron / swing pack / sparkline read it instead of IB history. Band engine + entry-zone cron stay IB (they need intraday 5-min bars).
2. ~~**`universe.last_avg_volume` specced but never written**~~ — **RESOLVED (Batch X4):** derived from `daily_bars` via `refresh_universe_avg_volume()` (30d median per conid). Column widened `integer → bigint`.
3. **`newsSentiment` is defined in `finnhub.ts` but called by nothing** — dead code or an unfinished `catalyst_reversal` input. Decide: wire it or delete it.
4. ~~**Current price has two homes**~~ — **RESOLVED (Batch X5):** `quotes` is the single price home. `migration 030` dropped `positions.current_price` + all price/P&L-derived columns; market value + unrealized P&L are recomputed from `quotes.canonical_price × shares` by every reader. The pollers still write the quote; they write only price-source metadata onto `positions`.
5. **Three price pollers** (`ibPricePoller`, `finnhubPricePoller`, `watchlistQuotePoller`) — confirm the held-vs-watchlist division is clean and not double-fetching.
6. ~~**`earningsCalendarRange` pulled twice**~~ — **RESOLVED (Batch X6):** both producers now read one shared once-per-day pull via `services/earningsCalendar.ts` (`getEarningsWindow`), each filtering to its own lookback.
