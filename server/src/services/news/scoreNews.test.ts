import { describe, it, expect } from 'vitest';
import { scoreNews, type NewsArticle } from './scoreNews.js';
import { lexiconScore, normalize } from './lexicon.js';

const ASOF = Date.UTC(2026, 5, 7, 12, 0, 0); // pinned "now"
const hoursAgo = (h: number): number => Math.floor((ASOF - h * 3_600_000) / 1000); // unix seconds

function art(headline: string, h: number, summary = ''): NewsArticle {
  return { headline, summary, url: `https://x/${h}`, datetime: hoursAgo(h) };
}

describe('lexiconScore / normalize', () => {
  it('matches single words on token boundaries, not substrings', () => {
    expect(lexiconScore('Quarterly loss widens')).toBeLessThan(0);
    // "lossless" must NOT trip "loss"
    expect(lexiconScore('New lossless codec shipped')).toBe(0);
  });

  it('matches multi-word phrases as contiguous runs', () => {
    expect(lexiconScore('Firm under SEC probe')).toBeLessThan(0);
    expect(lexiconScore('Drug wins FDA approval')).toBeGreaterThan(0);
  });

  it('weighs severe terms double', () => {
    // "fraud" (severe, -2) vs "weak" (base, -1)
    expect(lexiconScore('fraud alleged')).toBe(-2);
    expect(lexiconScore('weak demand')).toBe(-1);
  });

  it('normalize space-pads and strips punctuation', () => {
    expect(normalize('Beats! Estimates.')).toBe(' beats estimates ');
  });
});

describe('scoreNews', () => {
  it('returns neutral EMPTY on no articles', () => {
    expect(scoreNews([], ASOF)).toEqual({
      score: 0,
      label: 'neutral',
      articleCount: 0,
      topHeadline: null,
      topUrl: null,
    });
  });

  it('scores a clearly-bearish article bearish with the headline captured', () => {
    const r = scoreNews([art('Company faces SEC probe over accounting fraud', 2)], ASOF);
    expect(r.label).toBe('bearish');
    expect(r.score).toBeLessThan(0);
    expect(r.articleCount).toBe(1);
    expect(r.topHeadline).toContain('SEC probe');
    expect(r.topUrl).toBe('https://x/2');
  });

  it('scores a clearly-bullish article bullish', () => {
    const r = scoreNews([art('Q3 beats estimates and raises guidance', 2)], ASOF);
    expect(r.label).toBe('bullish');
    expect(r.score).toBeGreaterThan(0);
  });

  it('scores headlines with no lexicon hits as neutral ~0', () => {
    const r = scoreNews([art('Company announces conference call schedule', 2)], ASOF);
    expect(r.label).toBe('neutral');
    expect(r.score).toBe(0);
    expect(r.articleCount).toBe(1);
  });

  it('weights recent news above day-old news (sign follows the fresher article)', () => {
    const bearish = 'Stock plunges on fraud probe';
    const bullish = 'Stock soars on FDA approval';
    // recent bearish (1h) + old bullish (36h) → net negative
    const a = scoreNews([art(bearish, 1), art(bullish, 36)], ASOF);
    // swap recency → net positive, same two articles
    const b = scoreNews([art(bullish, 1), art(bearish, 36)], ASOF);
    expect(a.score).toBeLessThan(0);
    expect(b.score).toBeGreaterThan(0);
    expect(a.articleCount).toBe(2);
  });

  it('excludes articles older than the 48h window', () => {
    const r = scoreNews([art('Stock plunges on fraud probe', 60)], ASOF);
    expect(r.articleCount).toBe(0);
    expect(r.label).toBe('neutral');
  });

  it('picks the most-impactful headline; ties go to the more-negative', () => {
    // both recent, equal |contribution| (raw saturates to ±1)
    const r = scoreNews(
      [art('Massive fraud bankruptcy delisting', 1), art('Record high buyout breakthrough', 1)],
      ASOF,
    );
    expect(r.topHeadline).toContain('fraud');
  });

  it('keeps undated articles at the older weight rather than dropping them', () => {
    const r = scoreNews([{ headline: 'Company under SEC probe', summary: '', url: 'u' }], ASOF);
    expect(r.articleCount).toBe(1);
    expect(r.label).toBe('bearish');
  });

  it('saturates one hyperbolic article so it cannot dominate', () => {
    // 5 severe-negative terms → raw ≪ -3, but a single article saturates to -1
    const r = scoreNews([art('fraud bankruptcy delisting subpoena scandal', 1)], ASOF);
    expect(r.score).toBe(-1);
  });
});
