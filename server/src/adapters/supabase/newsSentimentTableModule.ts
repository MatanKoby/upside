// TableModule for `news_sentiment` — the SOLE server-side gatekeeper for that
// table. Writer: newsSentimentCron. Reader: riskFlagsCron. (The client reads
// news_sentiment directly via Supabase; this module governs server-side I/O.)
//
// Batch ARCH-1 reference TableModule — the template every other table follows.
// See docs/arch/target-architecture.md → Phase 1.

import { TableModule } from './TableModule.js';

/** Domain shape (camelCase). The DB row is snake_case — see fromRow. */
export interface NewsSentiment {
  conid: number;
  asofDate: string; // 'YYYY-MM-DD'
  score: number;
  label: string;
  articleCount: number;
  topHeadline: string | null;
  topUrl: string | null;
}

interface NewsSentimentRow {
  conid: number | string;
  asof_date: string;
  score: number | string;
  label: string;
  article_count: number | string;
  top_headline: string | null;
  top_url: string | null;
}

function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

function fromRow(r: NewsSentimentRow): NewsSentiment {
  return {
    conid: toNum(r.conid),
    asofDate: String(r.asof_date),
    score: toNum(r.score),
    label: String(r.label),
    articleCount: toNum(r.article_count),
    topHeadline: r.top_headline ?? null,
    topUrl: r.top_url ?? null,
  };
}

class NewsSentimentTableModule extends TableModule {
  constructor() {
    super('news_sentiment');
  }

  /** Upsert one (conid, asof_date) sentiment row. Sole writer. */
  async save(s: NewsSentiment): Promise<void> {
    await this.run(
      'save',
      this.from().upsert(
        {
          conid: s.conid,
          asof_date: s.asofDate,
          score: s.score,
          label: s.label,
          article_count: s.articleCount,
          top_headline: s.topHeadline,
          top_url: s.topUrl,
          source: 'lexicon',
          computed_at: new Date().toISOString(),
        },
        { onConflict: 'conid,asof_date' },
      ),
    );
  }

  /** Sentiment rows for a set of conids on a given date (risk-flags reader). */
  async getByConids(conids: number[], asofDate: string): Promise<NewsSentiment[]> {
    if (conids.length === 0) return [];
    const rows = await this.run<NewsSentimentRow[]>(
      'getByConids',
      this.from()
        .select('conid, asof_date, score, label, article_count, top_headline, top_url')
        .eq('asof_date', asofDate)
        .in('conid', conids),
    );
    return (rows ?? []).map(fromRow);
  }

  /** Retention — drop rows older than `cutoff` (news_sentiment is keyed by asof_date). */
  async purgeOlderThan(cutoff: string): Promise<void> {
    await this.deleteOlderThan('asof_date', cutoff);
  }
}

export const newsSentimentTableModule = new NewsSentimentTableModule();
