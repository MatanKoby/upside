// newsSentimentCron — Batch X7 (news-as-signal track).
//
// Scores recent news per ticker over the working set (held ∪ active-watchlist ∪
// today's curated_list) and writes one news_sentiment row per (conid, today).
// The SOLE producer of news_sentiment. Two consumers read it: the risk-flags
// engine (→ bad_news flag) and useVirtualList (chip + rank nudge).
//
// Deliberately NOT IB-gated — news is Finnhub-only, so this must keep working
// when IB is down (weekends included). companyNews is already rate-limited by
// finnhubQueue, so the per-ticker loop self-paces. Spec: spec/signals/news-signal.md.

import { companyNews } from '../services/finnhub.js';
import { activeWatchlistOnlyConids } from '../services/quotes.js';
import { notifyError } from '../services/notify.js';
import { scoreNews, type NewsArticle } from '../services/news/scoreNews.js';
import { newsSentimentTableModule } from '../db/newsSentimentTableModule.js';
import { curatedListTableModule } from '../db/curatedListTableModule.js';
import { quotesTableModule } from '../db/quotesTableModule.js';
import { positionsTableModule } from '../db/positionsTableModule.js';
import { NEWS_LOOKBACK_HOURS } from '../config/news.js';

const CADENCE_MS = 12 * 60 * 60_000; // twice a day — the 48h window changes slowly
const RETENTION_DAYS = 7;

function utcDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

interface Target {
  conid: number;
  symbol: string;
}

async function workingSet(): Promise<Target[]> {
  const byConid = new Map<number, Target>();

  // Held positions.
  for (const p of await positionsTableModule.getAllHeldConidSymbols().catch(() => [])) {
    byConid.set(p.conid, { conid: p.conid, symbol: p.symbol });
  }

  // Active-watchlist conids (excluding the held ones).
  const wl = await activeWatchlistOnlyConids(new Set(byConid.keys()));
  for (const { conid, symbol } of wl) {
    if (!byConid.has(conid)) byConid.set(conid, { conid, symbol });
  }

  // Today's curated_list — symbols come from quotes (curated_list carries only
  // conid; universe is not granted to this read path consistently, quotes is).
  const asof = utcDate();
  const curated = await curatedListTableModule.getConidsByDate(asof);
  const missing = curated.filter((c) => !byConid.has(c));
  if (missing.length > 0) {
    for (const r of await quotesTableModule.getSymbols(missing)) {
      if (!byConid.has(r.conid)) byConid.set(r.conid, { conid: r.conid, symbol: r.symbol });
    }
  }

  return [...byConid.values()];
}

async function tick(): Promise<void> {
  const targets = await workingSet();
  if (targets.length === 0) return;

  const asof = utcDate();
  const from = utcDate(new Date(Date.now() - NEWS_LOOKBACK_HOURS * 3_600_000));

  for (const { conid, symbol } of targets) {
    try {
      const articles = await companyNews(symbol, from, asof);
      const s = scoreNews(articles as NewsArticle[]);
      if (s.articleCount === 0) continue; // no recent news → no row (absence = clean)
      await newsSentimentTableModule.save({
        conid,
        asofDate: asof,
        score: s.score,
        label: s.label,
        articleCount: s.articleCount,
        topHeadline: s.topHeadline,
        topUrl: s.topUrl,
      });
    } catch (e) {
      void notifyError(`newsSentimentCron.${symbol}`, (e as Error).message, e);
    }
  }

  // Retention — drop rows older than the window we ever read.
  const cutoff = utcDate(new Date(Date.now() - RETENTION_DAYS * 86_400_000));
  await newsSentimentTableModule.purgeOlderThan(cutoff);
}

export function startNewsSentimentCron(): void {
  console.log('[newsSentimentCron] starting, 12h cadence (lexicon over companyNews)');
  const loop = async (): Promise<void> => {
    try {
      await tick();
    } catch (e) {
      void notifyError('newsSentimentCron.tick', (e as Error).message, e);
    }
    setTimeout(loop, CADENCE_MS).unref();
  };
  setTimeout(loop, 60_000).unref();
}
