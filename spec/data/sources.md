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
| `GET /iserver/marketdata/history` | **OHLCV bars** (any interval) → ATR, ADV, feature pack, sparkline, intraday-stats | **ephemeral → computed** | `curatedListCron`, `dipBounce` swing pack, `bandEngine`, `intradayStatsCron`, `signalEngine` feature pack, `routes/marketdata` (history/sparkline) |
| `GET /iserver/contract/{conid}/info` | contract metadata | `contracts` | `ibPricePoller`, `signalEngine` |
| `GET /iserver/secdef/search` | symbol → `real_conid` | `universe.real_conid`, `contracts` | `conidResolutionProducer` |
| `GET /iserver/watchlists` + `/iserver/watchlist` | IB-side watchlists (import) | `watchlist_lists`, `watchlist_items` | `services/watchlists` (sync) |
| `ibRawGet` / `ibRawPost` (allowlisted) | debug passthrough | — | `routes/debug` |

**Reliability caveat:** `/iserver/marketdata/history` returns **HTTP 503 during
US off-hours / weekends** (the market-data farm isn't serving) — see the daily-bar
gap in *Observations*. This is the single biggest source-availability risk because
nothing else currently supplies bars.

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
| `GET /v2/aggs/grouped/locale/us/market/stocks/{date}` | every US stock's daily O/H/L/C/V for one date | `universe.last_price` (close), `universe.last_volume` (single-day) | `universeQuoteProducer` |

**Specced but not implemented:** the 30-day median ADV bootstrap
(`universe.last_avg_volume`, planned in the cadence table below) was never built —
the producer only writes `last_price` + single-day `last_volume`. This is the root
cause of the empty curated list (Batch X3 routed around it; Batch X4 is the proper
fix). The bigger opportunity: 30 trailing grouped-daily calls = full 30-day OHLCV
for the entire universe, enough to compute **both ATR% and ADV with no IB calls** —
the basis of the planned `daily_bars` layer (see *Reliability posture*).

---

## 4. Yahoo (unofficial)

`server/src/services/universeQuote.ts` → `https://query1.finance.yahoo.com`.
Keyless, ToS-gray, per-symbol. **Gap-fill only**, into the *same* `universe` rows
Polygon writes (so it stays a single source of truth, not a parallel pipeline).

| Request | What we use | Stored in | Consumers |
| --- | --- | --- | --- |
| `GET /v8/finance/chart/{symbol}` | O/H/L/C/V for tickers Polygon's grouped response misses (IPOs, halts) | `universe.last_price`, `universe.last_volume` | `universeQuoteProducer` (`fallback_yahoo_quote` job) |

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
| `universe.last_price` | Polygon grouped-daily | nightly | 1 call |
| `universe.last_volume` | Polygon grouped-daily | nightly | (same call) |
| `universe.last_avg_volume` (30d median) | Polygon grouped-daily ×30, aggregated client-side | weekly | ~30 bootstrap / ~7 rolling — **NOT YET IMPLEMENTED** |
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
| **Daily OHLCV bars → ATR / ADV / swing packs / bands** | **IB history** | **— none —** | ❌ **single point of failure** |

The **daily-bars gap** is the active work: the plan is a cached **`daily_bars`
layer** sourced from Polygon grouped-daily (primary) → Yahoo (gap-fill), refreshed
nightly + a 30-day bootstrap, that the curated-list probe / band engine / swing
packs read instead of IB history. That makes Polygon the SSOT for daily grain,
demotes IB to **live-only** (where it's genuinely best), and closes the weekend
outage. It subsumes Batch X4. Pre-market intraday snapshot volume for
`catalyst_reversal` Stage-1 stays IB (daily grain can't cover it).

## Observations (for the table/pipeline audit)

1. **Daily bars are the only un-fallback'd source** → the `daily_bars` layer above. Top priority.
2. **`universe.last_avg_volume` specced but never written** → X3 (worked around) / X4 (proper). `marketCapRefreshCron` once claimed to bootstrap it but never did.
3. **`newsSentiment` is defined in `finnhub.ts` but called by nothing** — dead code or an unfinished `catalyst_reversal` input. Decide: wire it or delete it.
4. **Current price has two homes** — `positions.current_price` (held, via `ibPricePoller`/`finnhubPricePoller`) and `quotes.canonical_price` (watchlist/curated, via `watchlistQuotePoller`→`services/quotes`). `architecture.md` claims one SSOT; verify a held-AND-watchlisted ticker isn't priced by two pollers into two columns.
5. **Three price pollers** (`ibPricePoller`, `finnhubPricePoller`, `watchlistQuotePoller`) — confirm the held-vs-watchlist division is clean and not double-fetching.
6. ~~**`earningsCalendarRange` pulled twice**~~ — **RESOLVED (Batch X6):** both producers now read one shared once-per-day pull via `services/earningsCalendar.ts` (`getEarningsWindow`), each filtering to its own lookback.
