-- 031_news_sentiment.sql — Batch X7 (news-as-signal track).
--
-- Daily-grain news sentiment per (conid, asof_date) — the single source of
-- truth for the "news fact". Scored from Finnhub /company-news headlines with an
-- LM-inspired finance lexicon (Finnhub /news-sentiment is premium/403 on our
-- free key; LLM scoring deferred). One row per (conid, asof_date) when ≥1 article
-- was scored. Two consumers: the risk-flags engine reads `score` → the `bad_news`
-- WARNING flag, and useVirtualList joins it → news chip + good/bad rank nudge.
-- conid is universe.real_conid (joins risk_flags / curated_list / quotes).
-- See spec/signals/news-signal.md + spec/schema.md → news_sentiment.

create table if not exists public.news_sentiment (
  conid         bigint       not null,
  asof_date     date         not null,
  score         numeric      not null,           -- clamped mean per-article sentiment, ~[-1, +1]
  label         text         not null check (label in ('bullish', 'neutral', 'bearish')),
  article_count int          not null default 0,
  top_headline  text,                            -- highest-|contribution| article
  top_url       text,
  source        text         not null default 'lexicon',
  computed_at   timestamptz  not null default now(),

  primary key (conid, asof_date)
);

create index if not exists news_sentiment_asof_date_idx
  on public.news_sentiment(asof_date desc);

-- Realtime — the virtual-list news chip subscribes.
alter publication supabase_realtime add table public.news_sentiment;

-- Service-role writes (newsSentimentCron is the sole producer); authenticated
-- reads for the FE. Instrument-keyed (no user_id), same grant pattern as
-- risk_flags / band_state / trait_scores — no row-level policy.
grant select, insert, update, delete on public.news_sentiment to service_role;
grant select on public.news_sentiment to authenticated, anon;
