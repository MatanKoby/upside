// LM-inspired finance-news sentiment lexicon (Batch X7).
//
// NOT the full Loughran-McDonald CSV — a curated, maintainable, high-signal
// subset tuned for *headlines*. Each entry is a term (single word matched on
// token boundaries, or a multi-word phrase matched as a contiguous run) with a
// polarity sign; `severe` terms (fraud / bankruptcy / FDA approval …) weigh
// double. The scorer (scoreNews.ts) is the consumer. Honest about its ceiling:
// a lexicon catches clearly-good / clearly-bad vocabulary well (which is exactly
// the bad-news danger-flag direction); nuance is the deferred LLM upgrade.
// Spec: spec/signals/news-signal.md.

import { BASE_WEIGHT, SEVERE_WEIGHT } from '../../config/news.js';

export interface LexEntry {
  term: string; // lower-case; multi-word = phrase
  polarity: 1 | -1;
  severe?: boolean;
}

// Negative — list common tense/plural forms explicitly (no stemming).
const NEGATIVE: Array<[string, boolean?]> = [
  ['miss'], ['misses'], ['missed'], ['misses estimates', true],
  ['downgrade'], ['downgrades'], ['downgraded'],
  ['cuts guidance', true], ['guidance cut', true], ['lowers guidance'], ['lowered guidance'],
  ['profit warning', true], ['warns'], ['warning'],
  ['lawsuit'], ['sued'], ['sues'], ['class action'],
  ['investigation'], ['probe'], ['sec probe', true], ['subpoena', true], ['subpoenaed', true],
  ['fraud', true], ['fraudulent', true], ['accounting fraud', true],
  ['bankruptcy', true], ['bankrupt', true], ['chapter 11', true], ['insolvency', true],
  ['delisting', true], ['delisted', true], ['going concern', true], ['default', true], ['defaults', true],
  ['halt'], ['halts', true], ['halted', true], ['trading halt', true],
  ['recall', true], ['recalls', true], ['recalled'],
  ['plunge'], ['plunges'], ['plummet'], ['plummets'], ['tumble'], ['tumbles'],
  ['slump'], ['slumps'], ['sinks'], ['crash'], ['crashes'], ['slashed'], ['slashes'],
  ['layoffs'], ['lay off'], ['laying off'], ['job cuts'], ['restructuring'],
  ['dilution'], ['dilutive'], ['secondary offering'], ['share offering'],
  ['short seller'], ['short-seller'], ['short report'],
  ['fda rejection', true], ['complete response letter', true], ['crl', true], ['trial failure', true], ['failed trial', true],
  ['resigns'], ['resignation'], ['steps down'], ['ousted'],
  ['scandal', true], ['data breach', true], ['breach'], ['hack'], ['hacked'],
  ['underperform'], ['sell rating'], ['weak'], ['weakness'], ['decline'], ['declines'],
  ['loss'], ['losses'], ['write-down'], ['writedown'], ['impairment'], ['suspends'], ['suspended'],
  ['disappointing'], ['disappoints'], ['shortfall'], ['guidance miss', true],
];

// Positive.
const POSITIVE: Array<[string, boolean?]> = [
  ['beat'], ['beats'], ['beat estimates', true], ['tops estimates', true], ['blowout', true],
  ['upgrade'], ['upgrades'], ['upgraded'],
  ['raises guidance', true], ['raised guidance', true], ['hikes guidance'], ['boosts guidance'],
  ['surge'], ['surges'], ['soar'], ['soars'], ['jumps'], ['rally'], ['rallies'], ['spikes'],
  ['record high', true], ['all-time high'], ['record revenue'], ['record profit'],
  ['fda approval', true], ['approved', true], ['approval'], ['clearance'],
  ['breakthrough', true], ['milestone'],
  ['partnership'], ['strategic partnership'], ['collaboration'],
  ['acquisition', true], ['buyout', true], ['acquires'], ['to acquire'], ['merger'],
  ['contract win'], ['wins contract'], ['awarded'], ['secures'],
  ['expansion'], ['expands'], ['launches'],
  ['outperform'], ['buy rating'], ['strong buy'], ['price target raised'],
  ['bullish'], ['strong'], ['strength'], ['growth'], ['profit'], ['profitable'],
  ['dividend hike'], ['dividend increase'], ['buyback'], ['repurchase'],
  ['beats and raises', true], ['better than expected'], ['exceeds'], ['exceeds estimates', true],
];

function build(): LexEntry[] {
  const out: LexEntry[] = [];
  for (const [term, severe] of NEGATIVE) out.push({ term, polarity: -1, severe });
  for (const [term, severe] of POSITIVE) out.push({ term, polarity: 1, severe });
  return out;
}

export const NEWS_LEXICON: LexEntry[] = build();

// Normalise to a space-padded, alnum-only stream so single words match on
// boundaries (` fraud `) and phrases match as contiguous runs (` sec probe `).
export function normalize(text: string): string {
  const core = text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return ` ${core} `;
}

function weightOf(e: LexEntry): number {
  return e.polarity * (e.severe ? SEVERE_WEIGHT : BASE_WEIGHT);
}

// Summed signed weight of every lexicon term present in the text (each distinct
// term counted once — repetition of the same word doesn't compound). Positive =
// net-bullish, negative = net-bearish.
export function lexiconScore(text: string, lexicon: LexEntry[] = NEWS_LEXICON): number {
  const norm = normalize(text);
  let sum = 0;
  for (const e of lexicon) {
    if (norm.includes(` ${e.term} `)) sum += weightOf(e);
  }
  return sum;
}
