# User-Defined Price Markers

Manual, LLM-free alert primitive for the watchlist pivot (Batch A2). User picks a price + condition per ticker; pollers fire a Discord alert when current price crosses that level. Sibling files: `entry-zones.md` (automated companion that computes dynamic levels), `zone.md` (P&L-threshold alerts on held positions).

## Concept

A **marker** is a user-authored price target attached to a `watchlist_items` row. Multiple markers per ticker. Each is a tuple:

```
{ id, item_id (FK), label, price, condition, enabled, cooldown_hours, last_fired_at }
```

- `condition`: one of `at_or_above` | `at_or_below` | `about` — **same vocabulary as playbook legs** (see `playbook.md` → schema note: condition is geometric).
- `cooldown_hours`: default `24`. Once a marker fires, it goes silent for this many hours before it can fire again (rearm-after-cooldown, anchored on `last_fired_at`). Same pattern as `zone.md`.
- `enabled`: lets the user pause a marker without deleting it.
- `label`: optional free text ("dip-buy", "earnings entry", etc.) — surfaced in the Discord alert.

## Trigger

The price pollers (`ibPricePoller` / `finnhubPricePoller`) check every active marker for the conid on each price write:

- `at_or_above`: fires when `currentPrice >= price` AND the prior write's price was `< price` (transition into the condition).
- `at_or_below`: fires when `currentPrice <= price` AND the prior write's price was `> price`.
- `about`: fires on entering a ±0.5 ATR band around `price` (same transition rule).

Cooldown gate: if `now() − last_fired_at < cooldown_hours`, skip silently. Else fire and set `last_fired_at = now()`.

## First cut — dip-buys only

Batch A2 wires only `at_or_below` markers (the dip-buy use case driving the pivot). Schema accepts all three conditions; the alert path for `at_or_above` (targets/take-profit) and `about` is queued for a follow-up batch with its own channel(s).

## Discord channel

`#upside-dip-buys` (env `DISCORD_WEBHOOK_DIP_BUYS`). Message format:

```
🟢 SYMBOL hit dip-buy at $4.12 (label: "earnings entry")
    Current: $4.10 · Crossed: at_or_below $4.12
    [link to TickerDetail]
```

One channel per alert type — same pattern as `zone.md`'s `#upside-zone-profit`. Future: `#upside-targets` for `at_or_above`, etc.

## Per-marker overrides (future)

The 24h cooldown is a global default. Per-marker `cooldown_hours` override is supported in the schema from day one; a per-marker UI control comes in a follow-up after we've felt out which patterns need different cadence.

## FE entry points

- Watchlist row → **long-press** (mobile) / **right-click** (desktop) → opens add-marker sheet. See `../screens/watchlist.md`.
- Existing markers render inline on the watchlist row + on TickerDetail (a "Markers" mini-section).
- Edit/delete on existing markers: tap the marker chip → edit sheet.

## Persistence

`watchlist_markers` table — see `../schema.md`. Owned by the user (FK chain via `watchlist_items` → `watchlist_lists` → `user_id`).
