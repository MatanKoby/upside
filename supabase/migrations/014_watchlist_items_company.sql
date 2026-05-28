-- 014_watchlist_items_company.sql — polish slice after Batch A+.
--
-- Stores company_name on watchlist_items so the FE row can render
-- "SYMBOL · Company Name" without a contracts-table lookup. The name comes
-- straight out of the IB watchlist payload (`instrument.name`), so this is
-- a free win — no extra IB calls needed at sync time.

alter table public.watchlist_items
  add column if not exists company_name text;
