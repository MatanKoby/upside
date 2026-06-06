# News-as-Signal (deferred — Batch X7)

**Status: design captured, not built.** Decision 2026-06-06.

## Idea

News should move a stock's **potential** the same way an earnings report does:
good news lifts it (like a beat), bad news drags it (like a miss). Today
`post_earnings_drift` captures the earnings version of this; news is the
always-on, between-reports version.

## Data source

Finnhub (already wired in `finnhub.ts`, see `../data/sources.md` → Finnhub):

- **`/news-sentiment`** (`newsSentiment`) — pre-aggregated company sentiment
  score. **Currently defined but called by nothing** (dead code). This batch is
  where it gets wired in — or it should be deleted.
- **`/company-news`** (`companyNews`) — per-ticker headlines (already used by
  `signalEngine` for LLM context); a candidate raw input if we score sentiment
  ourselves rather than trusting Finnhub's aggregate.

No new external provider needed for v1.

## Where it plugs in (to decide at build time)

Two candidate shapes — pick when the batch is claimed:

1. **A trait** (`news_sentiment`) alongside the S2 traits, feeding curated-list
   rank / the dip-bounce composite — symmetric with `post_earnings_drift`.
2. **A `risk-flags` modifier** — bad news as a danger flag (enter-risk), good
   news as a potential boost. Reuses the daily-grain risk-flags mechanism
   (`risk-flags.md`).

Likely both: bad news → a risk flag; good/bad magnitude → a ranking modifier.

## Open questions for build time

- Sentiment from Finnhub's aggregate vs. our own scoring of headlines (quality
  vs. simplicity).
- Decay: how fast does a news bump fade (hours? a day? like the drift window).
- Dedup against `catalyst_reversal` (which already keys off today's news) so we
  don't double-count.

## Cross-references

- Data: `../data/sources.md` → Finnhub (`newsSentiment` / `companyNews`)
- Siblings: `screener-universe.md` (traits), `risk-flags.md` (danger flags),
  `curated-list.md` (ranking), `dip-bounce-scorer.md` (composite)
