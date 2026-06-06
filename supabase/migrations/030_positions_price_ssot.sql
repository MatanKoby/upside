-- 030_positions_price_ssot.sql — Batch X5 (price SSOT).
--
-- `quotes` is now the ONE home for price. `positions` holds holding facts only
-- (conid / shares / avg_cost / realized_pnl / vwap / zone-state / entry
-- provenance) and joins `quotes` by conid for the live price; the FE recomputes
-- market value + unrealized P&L from `quotes.canonical_price` × shares. This
-- drops the price/P&L-derived columns that duplicated the quote. See
-- architecture.md → Single source of truth for current price + schema.md.
--
-- ⚠️ APPLY LAST — after `./bin/upside rebuild api` + the Vercel FE deploy. The
-- new code stops reading/writing these columns; applying this before the deploy
-- would break the still-running old code that selects them.
--
-- Kept on positions: shares, avg_cost, realized_pnl (broker facts), vwap_value,
-- trading_days_held, first_seen_*, price_source, last_price_update_at, zone_*.

alter table public.positions
  drop column if exists current_price,
  drop column if exists market_value,
  drop column if exists unrealized_pnl,
  drop column if exists unrealized_pnl_pct,
  drop column if exists today_change,
  drop column if exists today_change_pct,
  drop column if exists daily_return,
  drop column if exists portfolio_weight,
  drop column if exists portfolio_contribution;
