-- 015_quotes_change_and_sparkline.sql — watchlist row polish.
--
-- Adds today's change percent and a 7-day sparkline closes array to `quotes`.
-- Both nullable. The pollers populate `today_change_pct` on each price write
-- (from IB snapshot field 82 or Finnhub /quote `dp`). `sparkline_closes` is
-- populated by `entryZonesCron` since it already pulls daily history per
-- active-list conid; piggybacking avoids an extra IB call per ticker.

alter table public.quotes
  add column if not exists today_change_pct numeric,
  add column if not exists sparkline_closes numeric[];
