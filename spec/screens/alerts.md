# Alerts Feed

Chronological list of signal events, zone-entries, marker hits, and entry-zone firings. Accessed via bell icon in header (not bottom nav).

## Top Controls
- **Display filter slider**: "Show signals above ___% Quality" (range: 0-100, default 50). **Display filter only — does NOT affect generation.** Settings has a separate "Signal generation threshold" (the BE-level minimum).
- Filter pills: All / Sell / Buy / Zone-Entry / Marker / Entry-Zone / no_signal.

## Aggregate Accuracy Display (top of feed)
Pulls from `GET /api/signals/accuracy` (Batch 14b, deferred). Format: "Recent SELL signals: X% hit-rate over 30d, median +Y% from optimal price." Per-direction stats. Placeholder copy if data is sparse.

## Feed Items
- Timestamp (relative: "2h ago", "Yesterday 3:42 PM").
- Ticker + event pill (signal / zone-entry / marker / entry-zone).
- Short description (the Discord message body).
- "I acted on this" button → POST sets `signals.acted_on_at` (or equivalent per event type). Feeds the post-mortem feature later.
- Tap to open the relevant section in TickerDetail.

Empty state: "No alerts yet. Tap Analyze on a position, add a marker to a watchlist, or wait for zone events."
