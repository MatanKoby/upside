# Data Sources

What the engines read from. Organized by current use (MVP + watchlist pivot)
and planned use (post-MVP screener track).

## Currently used

- **IB Client Portal Gateway** (`ib-gateway:5000`): real-time snapshot
  (subscribe-then-poll), OHLCV bars (any interval/timeframe), volume,
  history, fundamentals, position/account data, watchlists (read), trades,
  transactions. The primary live data source when IB is connected. Driven
  through `ibGateway.ts`; rate-limited per `schema.md` → IB API Rate Limits.
- **Finnhub** (rate-limited queue, `schema.md` → Finnhub Rate-Limited Queue):
  - `/quote` — price fallback when IB is off.
  - `/stock/profile2` — fundamentals (marketCap, name, etc.).
  - `/stock/metric` — extended fundamentals (52w hi/lo, PE, EPS, beta).
  - `/calendar/earnings` — forward + recent earnings calendar.
  - `/news-sentiment` — pre-aggregated company news sentiment score.
  - `/company-news` — per-ticker headlines + URLs.
  - `/stock/symbol?exchange=US` — universe pull (screener Ring 0).
  - Free tier 60 calls/min; **`/stock/candle` is paid-tier only** as of
    2026-05 (free tier returns 403). Bars come from IB; if IB is down, no
    candles. See `roadmap.md` → Track 9 (Chart Data Resilience).
- **Computed locally from IB bars → the feature pack** (`technicals.ts`):
  pivots, swing highs/lows, ATR, SMA/EMA, RSI, MACD, Bollinger, VWAP,
  relative volume, position-relative distances. The LLM's grounding input
  (it anchors legs to these levels, doesn't invent prices).
- **Sparklines**: 7 daily bars per ticker from IB, current day live.
- **Canonical current price**: `quotes.canonical_price` for watchlisted
  conids (Track 1), `positions.current_price` for held positions (MVP). NOT
  a fresh IB snapshot inside `signalEngine` — see `playbook.md` →
  Freshness guard.

## Planned (post-MVP — screener track)

These sources are listed here so the screener track has a known data plan
before its batches start. None of them are required for MVP; they unlock
the post-Batch-B work.

- **SEC EDGAR full-feed RSS** (`https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=&output=atom`): real-time SEC filings firehose — 8-Ks (material events: earnings, M&A, drug approvals, executive changes), 10-Qs, 10-Ks, Form 4s (insider trades). Free, no key, 10 req/sec polite-bot rate. The primary catalyst-news source when the RSS firehose ships. See `roadmap.md` → Track 10 → RSS firehose.
- **FDA Drug Approvals RSS** (`https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/drugs/rss.xml` + sibling feeds for devices + biologics): direct catalyst signal for biotech tickers (the REPL-on-FDA-day pattern). Free, no key, official source — high precision, low noise.
- **PR Newswire / BusinessWire / GlobeNewswire RSS**: company press releases (most US-listed companies route here for material announcements). Free. Ticker extraction by regex + universe-table lookup.
- **Nasdaq Trader RSS** (`https://www.nasdaqtrader.com/rss.aspx`): corporate actions + **trading halts** (halts are pre-news price signals — knowing a ticker just halted/resumed is itself actionable).
- **SEC EDGAR API** (`https://data.sec.gov/`): no rate limit, official, gives company facts (fundamentals, insider holdings, ownership) better than Finnhub's free tier in many cases. Planned as a Finnhub-fundamentals supplement.
- **yfinance / Yahoo pattern** (unofficial, no key, ToS-gray): potential redundancy + fallback layer. Listed for completeness — not yet committed to.
- **Alpha Vantage / Twelve Data / Polygon free tiers**: backup quote/candle providers if Finnhub becomes a bottleneck. Each has a different free-tier shape; none has been adopted yet. See `roadmap.md` → Track 9 for the chart-resilience research.

## Universe coverage — primary + fallback (S0.5 decision, 2026-06-02)

The screener needs **price + volume** on the ~3,000-ticker universe, not
just the ~25 held + watchlist conids. Finnhub free `/quote` has price but
**no volume field**. IB snapshot has both but is rate-limited + requires
real conids + on-demand session. S0.5 evaluated four free-tier candidates;
final pick recorded here so downstream batches and the queue can implement
against it.

### Decision matrix

| Source | Has volume | Batch | Free-tier rate | Auth | Notes |
| --- | --- | --- | --- | --- | --- |
| **Polygon** `/v2/aggs/grouped/locale/us/market/stocks/{date}` | ✓ | **✓ ALL US stocks in 1 call** | 5/min | free key (signup) | **PRIMARY**. One call/day → whole universe's daily OHLCV. Fits perfectly under the 5-cpm free limit. |
| **Yahoo** `query1.finance.yahoo.com/v8/finance/chart/{sym}` | ✓ | per-symbol | undocumented (~few hundred/hr safe from single IP) | **none** | **FALLBACK**. Used for tickers Polygon's grouped-bars doesn't return (IPOs, halted/delisted-since-snapshot, special situations). ToS-gray but at our cadence (1 call/missed-ticker/day, ~tens/day) the exposure is minimal. |
| Yahoo v8/spark batch | close only | ✓ | undocumented | none | Rejected — no volume field. |
| Yahoo v7/quote batch | ✓ | ✓ | requires crumb-cookie auth as of 2023 | brittle | Rejected — auth hack we'd have to maintain. |
| Alpaca Market Data (free IEX feed) | ✓ | ✓ | unlimited | brokerage account | Powerful but more onboarding friction than Polygon; revisit if Polygon hits limits. |
| Twelve Data free | ✓ | partial | 800/day, 8/min | key | Rejected — daily cap can't cover ~3,000-ticker sweep. |

### Cadence per the caching plan

| Field | Source | Cadence | Daily call cost |
| --- | --- | --- | --- |
| `universe.last_price` | Polygon grouped-daily | nightly | **1 call** |
| `universe.last_avg_volume` (30d median) | Polygon grouped-daily, aggregated client-side from 30 days of grouped responses (one call per missing day) | weekly Sunday | **~30 calls** initial bootstrap, then **~7 calls** rolling weekly |
| Per-ticker gap-fills (Polygon missing) | Yahoo v8/chart | nightly, only on gaps | **~tens** |

Total daily Polygon: well under the 5/min free cap. Total daily Yahoo:
small, fits comfortably under the unofficial-rate-limit headroom.

### What this DOES NOT cover

- **Intraday volume during pre-market** for `catalyst_reversal` Stage-1 — that needs IB snapshot (with `real_conid`). Polygon grouped-bars is daily-grain; Polygon's intraday endpoints require paid plans. See `signals/screener-universe.md` → `catalyst_reversal` for the Stage-1 IB-snapshot path.
- **Real-time price during regular session** — the existing `quotes` pollers (IB + Finnhub) own that for held + watchlist tickers. Universe tickers don't get realtime updates; they get the once-daily refresh from Polygon. The Screener tab (S4) renders the last cached price; tap-through to TickerDetail still pulls live (via the existing marketdata snapshot route).

### Implementation interface

`server/src/services/universeQuote.ts` exposes a source-agnostic API:

```typescript
// Returns the daily OHLCV map for all US stocks for the given date.
// First tries Polygon grouped-bars; on failure / partial response, the
// caller (the producer) iterates missing-ticker fallback via yahoo().
export interface DailyOhlcv {
  open: number; high: number; low: number; close: number; volume: number;
}

export async function polygonGroupedDaily(date: string): Promise<Record<string, DailyOhlcv>>;
export async function yahooChart(symbol: string): Promise<DailyOhlcv | null>;
```

The producer (`universeQuoteProducer` cron) calls `polygonGroupedDaily(yesterday)`, walks the universe rows it expects, and enqueues per-ticker `fallback_yahoo_quote` jobs (worker pool: `finnhub` — reusing the rate-limited HTTP infrastructure, even though Yahoo is keyless) only for gaps. The single Polygon call is a producer-side action, not a queued job, because it's one-shot per day and inexpensive.
