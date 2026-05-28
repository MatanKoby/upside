# Data Sources (per analysis)

- **IB price data** (`ib-gateway:5000`): real-time snapshot (subscribe-then-poll), OHLCV bars (any interval/timeframe), volume, history, fundamentals, position/account data.
- **Computed locally from IB bars → the feature pack** (`technicals.ts`): the levels/volatility/trend/momentum/volume features (see `playbook.md` → feature pack). This is the LLM's grounding input — precise values, not raw bars.
- **Finnhub**: company news + sentiment, insider transactions, earnings calendar, basic financials; intraday candles (currently price-fallback only; Track 9 researches free candle availability for analysis/chart). All via the rate-limited queue.
- **Sparklines**: 7 daily bars per ticker from IB, current day live.
- **Canonical current price**: from `positions.current_price` today (MVP) → `quotes.canonical_price` at Track 1. NOT a fresh IB snapshot inside `signalEngine` (see `playbook.md` → Freshness guard).
