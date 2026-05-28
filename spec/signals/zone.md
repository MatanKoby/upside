# Profit-Taking Zone Detection

Continuous, automated. Independent of the LLM playbook engine (`playbook.md`).

A position enters "profit-taking zone" when its unrealized P&L percent crosses a user-configurable threshold (default +2.0%, `user_preferences.profit_zone_threshold_pct`). Any cause that pushes P&L across the threshold triggers the same flow; dedicated pre-market gap detection is **dropped** in favor of this unified model (gap entries get a visual marker, no separate notification).

**State (fields on `positions`):** `zone_entered_at`, `zone_exited_at`, `last_zone_notification_at`, `entered_zone_via_gap`. Recomputed on every `positions` write by both pollers; `inZone` when `pnl_percent >= profit_zone_threshold_pct`. (Shipped in Batch 14c.)

**Notifications:** on entry (`!inZone → inZone`), one Discord ping to `#upside-zone-profit` (`DISCORD_WEBHOOK_ZONE_PROFIT`; one channel per alert type). 4-hour re-entry cooldown anchored on `last_zone_notification_at`. Zone-exit doesn't notify in MVP.

**UI (TickerCard held variant):** a zone icon + (for `entered_zone_via_gap`) a "GAP" badge before the P&L, each with a tooltip; the gap badge clears at session end (`zoneGapCleanup`).

**LLM context:** when a position is `inZone` and Analyze fires, `signalEngine` passes `contextualTriggers.inProfitTakingZone` to the LLM (see `playbook.md` → Contextual triggers).
