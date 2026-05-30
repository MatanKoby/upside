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
