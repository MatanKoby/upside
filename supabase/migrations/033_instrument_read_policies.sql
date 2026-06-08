-- 033_instrument_read_policies.sql
--
-- Batch X9 follow-up — the actual reason the Intraday/Swing virtual lists never
-- rendered. The signal/instrument tables had RLS *enabled* (Supabase's default
-- when a table is created) but **no SELECT policy**, so the `authenticated` FE
-- role read 0 rows from every one of them — empty union → empty lists, with no
-- error to signal why. The SELECT grant to `authenticated` was already present
-- on each (ACL `authenticated=r…`); only the policy was missing.
--
-- These are market-wide instrument / signal tables (not user-scoped), so a
-- blanket authenticated read is correct — mirrors the working
-- `quotes: authenticated read` policy (`using (true)`). `quotes` already had
-- its policy, which is why prices rendered while the lists did not.
--
-- Idempotent (drop-if-exists then create). `alter … enable` is a no-op since
-- RLS is already on, kept for an explicit, self-contained statement of intent.

-- curated_list
alter table public.curated_list enable row level security;
drop policy if exists "curated_list: authenticated read" on public.curated_list;
create policy "curated_list: authenticated read" on public.curated_list
  for select to authenticated using (true);

-- trait_scores
alter table public.trait_scores enable row level security;
drop policy if exists "trait_scores: authenticated read" on public.trait_scores;
create policy "trait_scores: authenticated read" on public.trait_scores
  for select to authenticated using (true);

-- band_state
alter table public.band_state enable row level security;
drop policy if exists "band_state: authenticated read" on public.band_state;
create policy "band_state: authenticated read" on public.band_state
  for select to authenticated using (true);

-- signal_fires
alter table public.signal_fires enable row level security;
drop policy if exists "signal_fires: authenticated read" on public.signal_fires;
create policy "signal_fires: authenticated read" on public.signal_fires
  for select to authenticated using (true);

-- signal_outcomes
alter table public.signal_outcomes enable row level security;
drop policy if exists "signal_outcomes: authenticated read" on public.signal_outcomes;
create policy "signal_outcomes: authenticated read" on public.signal_outcomes
  for select to authenticated using (true);

-- news_sentiment
alter table public.news_sentiment enable row level security;
drop policy if exists "news_sentiment: authenticated read" on public.news_sentiment;
create policy "news_sentiment: authenticated read" on public.news_sentiment
  for select to authenticated using (true);
