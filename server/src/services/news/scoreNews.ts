// Pure news-sentiment scorer (Batch X7). Turns a list of Finnhub /company-news
// articles into one aggregate sentiment for a ticker. No DB / no env / no
// network — tested in isolation (scoreNews.test.ts). The cron + signalEngine
// feed it the raw articles. Spec: spec/signals/news-signal.md.

import {
  NEWS_LOOKBACK_HOURS,
  NEWS_RECENT_HOURS,
  NEWS_RECENT_WEIGHT,
  NEWS_OLDER_WEIGHT,
  ARTICLE_CLAMP,
  NEWS_BULLISH_SCORE,
  NEWS_BEARISH_SCORE,
} from '../../config/news.js';
import { lexiconScore } from './lexicon.js';

// Finnhub /company-news element (the fields we use; everything else ignored).
export interface NewsArticle {
  headline?: unknown;
  summary?: unknown;
  url?: unknown;
  datetime?: unknown; // unix SECONDS (Finnhub convention)
}

export type NewsLabel = 'bullish' | 'neutral' | 'bearish';

export interface NewsScore {
  score: number; // weighted mean per-article sentiment, ∈ ~[-1, +1]
  label: NewsLabel;
  articleCount: number; // articles inside the window
  topHeadline: string | null; // highest-|contribution| article
  topUrl: string | null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function labelFor(score: number): NewsLabel {
  if (score <= NEWS_BEARISH_SCORE) return 'bearish';
  if (score >= NEWS_BULLISH_SCORE) return 'bullish';
  return 'neutral';
}

const EMPTY: NewsScore = {
  score: 0,
  label: 'neutral',
  articleCount: 0,
  topHeadline: null,
  topUrl: null,
};

// asofMs lets tests pin "now"; defaults to the real clock.
export function scoreNews(articles: NewsArticle[], asofMs: number = Date.now()): NewsScore {
  if (!Array.isArray(articles) || articles.length === 0) return EMPTY;

  const windowMs = NEWS_LOOKBACK_HOURS * 3_600_000;
  const recentMs = NEWS_RECENT_HOURS * 3_600_000;

  let weightedSum = 0; // Σ (perArticle ∈ [-1,1]) × recencyWeight
  let weightTotal = 0; // Σ recencyWeight
  let count = 0;
  let topAbs = -1;
  let topContribution = 0; // signed, for danger-first tie-break
  let topHeadline: string | null = null;
  let topUrl: string | null = null;

  for (const a of articles) {
    const headline = str(a.headline);
    const summary = str(a.summary);
    if (!headline && !summary) continue;

    // Window filter. Undated articles are kept (assumed in-window) at the older
    // weight — conservative rather than dropping them.
    const tsSec = typeof a.datetime === 'number' && Number.isFinite(a.datetime) ? a.datetime : null;
    let recencyWeight = NEWS_OLDER_WEIGHT;
    if (tsSec != null) {
      const ageMs = asofMs - tsSec * 1000;
      if (ageMs > windowMs || ageMs < -recentMs) continue; // outside window (allow slight clock skew into the future)
      recencyWeight = ageMs <= recentMs ? NEWS_RECENT_WEIGHT : NEWS_OLDER_WEIGHT;
    }

    const raw = lexiconScore(`${headline} ${summary}`);
    const perArticle = Math.max(-1, Math.min(1, raw / ARTICLE_CLAMP)); // saturate one article to ±1
    const contribution = perArticle * recencyWeight;

    weightedSum += contribution;
    weightTotal += recencyWeight;
    count += 1;

    // Most-impactful article drives top_headline; ties → more-negative wins.
    const abs = Math.abs(contribution);
    if (abs > topAbs || (abs === topAbs && contribution < topContribution)) {
      topAbs = abs;
      topContribution = contribution;
      topHeadline = headline || summary;
      topUrl = str(a.url) || null;
    }
  }

  if (count === 0 || weightTotal === 0) return EMPTY;

  const score = Math.round((weightedSum / weightTotal) * 1000) / 1000;
  return {
    score,
    label: labelFor(score),
    articleCount: count,
    topHeadline,
    topUrl,
  };
}
