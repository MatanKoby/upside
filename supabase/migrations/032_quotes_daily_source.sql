-- 032: allow a 'daily' canonical_source on quotes (Batch X9).
--
-- Curated/universe names had no `quotes` row (only held + watchlist were ever
-- quoted), so the virtual lists + the dip-bounce scorer dropped them on the join.
-- X9 seeds a daily-close quote for the curated set from universe.last_price +
-- daily_bars; those rows are marked canonical_source='daily' with an honest
-- (stale) timestamp. Seeded/stale prices render in the lists but never fire a
-- signal (the fresh-price firing gate skips them). Live pollers overwrite the
-- row with ib/finnhub during the session.

alter table quotes drop constraint if exists quotes_canonical_source_check;
alter table quotes add constraint quotes_canonical_source_check
  check (canonical_source = any (array['ib'::text, 'finnhub'::text, 'daily'::text]));
