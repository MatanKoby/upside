-- 019_universe.sql — Batch S1 (post-MVP screener track).
--
-- Stock-universe cache. One row per Ring-1-applicable conid — the nightly
-- universeCron writes this. Rows here exist only for symbols that passed
-- the in-process type+MIC filter (Common Stock / ADR on XNAS / XNYS / XASE);
-- failures at the per-symbol price+cap gate are recorded with a
-- `filter_result` enum so we can diagnose "why isn't TSLA in the screener?"
-- without re-running the sweep.
--
-- See spec/signals/screener-universe.md for the Ring 0/1 definitions and
-- spec/schema.md → universe for the column-level spec.

create table if not exists public.universe (
  conid                 bigint       primary key,
  symbol                text         not null,
  type                  text,
  mic                   text,
  last_filter_pass      timestamptz  not null default now(),
  filter_result         text         not null check (filter_result in (
                          'in',          -- passed all Ring 1 gates
                          'out_price',   -- price outside [$1, $100]
                          'out_cap',     -- marketCap < $150M
                          'out_volume',  -- avg vol < 1M shares (gate deferred; not yet enforced)
                          'no_data'      -- /quote or /profile2 returned nothing usable
                        )),
  last_price            numeric,
  last_market_cap_m     numeric,     -- Finnhub native unit: millions of USD
  last_avg_volume       bigint,      -- shares; null until S2's daily-bar pipeline lands
  computed_at           timestamptz  not null default now()
);

-- The Screener cron filters on (filter_result='in'); the trait-scoring pass
-- (S2) iterates only those. Index supports the cheap "give me the curated set"
-- query patterns.
create index if not exists universe_filter_result_idx on public.universe(filter_result);
create index if not exists universe_symbol_idx        on public.universe(symbol);

-- No Realtime publication: whole table is effectively rewritten nightly, and
-- no FE consumer subscribes directly — the Screener tab reads `trait_scores`
-- (S2) which is the user-facing surface. Keeps Realtime traffic clean.

-- Service-role-only writes; backend is the sole producer. Read grants follow
-- the same pattern as Batch B's intraday_stats — we'll add user-facing read
-- if a future surface needs it.
grant select, insert, update, delete on public.universe to service_role;
