# Upside — Target Architecture (Arch batch)

Status: **planning → executing.** This is an *engineering refactor plan*, not product spec.
Companion to the live-system map in [`server-architecture.html`](server-architecture.html)
and `spec/data/consumers.md`.

## Goal

Make every module do **one job**: high-quality, design-pattern-idiomatic, scalable, fast.
Refactor **incrementally — one slice at a time, no big-bang.** This is a live trading
system; every step must be safe and reversible.

## Four pillars

| Pillar | One line |
| --- | --- |
| **Ports & adapters** | Integrations (IB, Finnhub, Discord…) sit behind an interface; callers depend on the interface, not the vendor. |
| **Pure core** | The math (scorers, band engine, risk/sentiment compute) as pure functions — **no DB, no network, no clock**. |
| **TableModule** | One gatekeeper module per Supabase table; the **only** place that table is read or written. |
| **Scheduler** | One `schedule({ every, run })` primitive; crons stop hand-rolling `setTimeout`. |

## Target layout (the destination)

```
server/src/
  kernel/     scheduler · queue · pipeline · strategy · alerts · notify · config · clock
  adapters/   ib/ finnhub/ polygon/ yahoo/ llm/ discord/ supabase(TableModules)/ redis/
  domain/     pricing/ bands/ signals/ traits/ dip-bounce/ risk/ news/      (PURE, no I/O)
  app/        use-cases / orchestration (poll engine, producers, alert dispatch)
  http/       routes/ middleware/ server.ts
  triggers/   cron declarations (one line each)
```

A cron then = four small things in four homes: **when** (`triggers/`) → **what** (`app/`) →
**math** (`domain/`) → **persistence** (`adapters/supabase` TableModules).

## Refactor order (each is its own Arch sub-batch)

1. **TableModules** ← *start here.* Mechanical, safe, no behavior change.
2. **Ports & adapters** — wrap each vendor behind a port.
3. **`schedule()` primitive** — collapse the ~20 `setTimeout` loops.
4. **Relocate pure core** into `domain/`.
5. *(optional)* **Explicit pipeline** for the screener chain (`universe → stats → traits → curated → fires → outcomes`).

Why this order: TableModules touch **only persistence call-sites**, change **no behavior**,
and are independently verifiable by grep — lowest risk, and they build the muscle for the rest.

---

## Phase 1 — TableModules (current work)

**Rule.** Every `supabase().from('<table>')` read/write moves behind `<table>TableModule`.
**One writer-owner per table.** Same SQL, same row shape — just relocated and named. No behavior change.

**Home.** `server/src/db/` for now (moves under `adapters/supabase/` in the final layout — a trivial later move).

**Naming.** `newsSentimentTableModule`; methods are **intention-revealing** (`.save()`, `.getByConids()`,
`.purgeOlderThan()`) — never raw `.select()/.upsert()`. Row types live with the module.

**Reference (do first): `news_sentiment`** — 1 writer (`newsSentimentCron`) + 1 reader (`riskFlagsCron`).
Smallest surface, hard to fail. Shape:

```ts
// server/src/db/newsSentimentTableModule.ts
import { supabase } from '../services/supabase.js';

export interface NewsSentiment {
  conid: number;
  asofDate: string;        // 'YYYY-MM-DD'
  score: number;
  label: string;
  articleCount: number;
  topHeadline: string | null;
  topUrl: string | null;
}

export const newsSentimentTableModule = {
  /** Upsert one (conid, asof_date) row. SOLE writer of news_sentiment. */
  async save(s: NewsSentiment): Promise<void> {
    const { error } = await supabase().from('news_sentiment').upsert(
      {
        conid: s.conid, asof_date: s.asofDate, score: s.score, label: s.label,
        article_count: s.articleCount, top_headline: s.topHeadline, top_url: s.topUrl,
        source: 'lexicon', computed_at: new Date().toISOString(),
      },
      { onConflict: 'conid,asof_date' },
    );
    if (error) throw new Error(`newsSentiment.save: ${error.message}`);
  },

  /** Sentiment rows for a set of conids on a date — the risk-flags reader. */
  async getByConids(conids: number[], asofDate: string): Promise<NewsSentiment[]> {
    const { data, error } = await supabase()
      .from('news_sentiment')
      .select('conid, asof_date, score, label, article_count, top_headline, top_url')
      .in('conid', conids)
      .eq('asof_date', asofDate);
    if (error) throw new Error(`newsSentiment.getByConids: ${error.message}`);
    return (data ?? []).map((r) => ({
      conid: Number(r.conid), asofDate: String(r.asof_date), score: Number(r.score),
      label: String(r.label), articleCount: Number(r.article_count),
      topHeadline: r.top_headline ?? null, topUrl: r.top_url ?? null,
    }));
  },

  /** Retention — drop rows older than the cutoff date. */
  async purgeOlderThan(cutoffDate: string): Promise<void> {
    const { error } = await supabase().from('news_sentiment').delete().lt('asof_date', cutoffDate);
    if (error) throw new Error(`newsSentiment.purgeOlderThan: ${error.message}`);
  },
};
```

**Showcase (do second): `trait_scores`** — 3 writers (`catalystReversalProducer`,
`postEarningsDriftProducer`, `intradayRangeTraderProducer`) + retention, 1 reader (`curatedListCron`).
This is where the one-writer-owner rule earns its keep.

**Rollout order** (low coupling → high):
`news_sentiment → trait_scores → curated_list → entry_zones → band_state → intraday_stats →
daily_bars → universe → quotes → positions → signal_fires/outcomes → risk_flags →
watchlist_* → analyses/analysis_locks`.
(`screener_jobs` is already encapsulated in `services/jobs/queue.ts` — it's the prototype TableModule.)

**Progress (ARCH-3 = the remaining-tables rollout, one commit per table):**
✅ `news_sentiment` (ARCH-1) · ✅ `trait_scores` (ARCH-2) · ✅ `curated_list` · ✅ `entry_zones` ·
✅ `band_state` · ✅ `intraday_stats` · ✅ `daily_bars` — **single-writer half done.**
✅ `universe` — first of the multi-writer half: 6 writers / 16 call-sites / 10 files (nightly bulk
sweep + stale retention + real_conid stamp + weekly cap refresh + daily price/volume + auto-promote +
the `refresh_universe_avg_volume` RPC), all behind named methods; readers take a uniform `UniverseRow`.
**Next: `quotes`** — then the rest of the **multi-writer half** (`positions`,
`signal_fires/outcomes`, `risk_flags`, `watchlist_*`, `analyses/analysis_locks`). Each has several
writers, so the **one-writer-owner** call is the real work: the module becomes the sole writer and the
producers/pollers call its named methods (e.g. `quotesTableModule.upsertQuote(...)` for the 5 quote
writers). ~15–16 call-sites across ~10 files apiece.

**Definition of done, per table:**
- No `from('<table>')` anywhere outside its TableModule (grep-enforced).
- All call-sites use the named methods.
- Row type lives with the module.
- No behavior change — verified by the existing crons still producing the same rows.

## Strategy

Walking skeleton: build the **reference** (`news_sentiment`), review it together, then roll out
table-by-table. Each table is small and independently shippable as its own commit.
