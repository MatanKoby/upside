# PriceFlicker — integration sketch

Component lives in `client/src/components/common/PriceFlicker.tsx` — used
across **every** ticker price surface: Watchlist rows, Portfolio PositionCards,
and the TickerDetail header. Same wrapper, same props, no per-surface logic.

## 1. Watchlist row — `client/src/pages/Watchlist.tsx` around line 402

```diff
-      <div className="watchlist-item-right">
-        <span className="watchlist-item-price">
-          {price != null ? formatCurrency(price) : '—'}
-        </span>
+      <div className="watchlist-item-right">
+        <PriceFlicker
+          price={price}
+          todayChangePct={todayChangePct}
+          format={formatCurrency}
+          className="watchlist-item-price"
+        />
```

Import:
```ts
import { PriceFlicker } from '../components/common/PriceFlicker';
```

## 2. PositionCard — `client/src/components/PortfolioHome/PositionCard.tsx` around line 82

```diff
-            <div className="price">{formatCurrency(position.currentPrice)}</div>
+            <PriceFlicker
+              price={position.currentPrice}
+              todayChangePct={position.todayChangePercent}
+              format={formatCurrency}
+              className="price"
+            />
```

Import:
```ts
import { PriceFlicker } from '../common/PriceFlicker';
```

## 3. TickerDetail header — `client/src/components/TickerDetail/TickerDetail.tsx` around line 63

```diff
-          <strong>{formatCurrency(detail.price)}</strong>
+          <PriceFlicker
+            price={detail.price}
+            todayChangePct={detail.todayChangePercent}
+            format={formatCurrency}
+          />
```

(No `className` here — the surrounding `<strong>` already has the styling.
If TickerDetail's price was bold via the parent element, wrap PriceFlicker in
`<strong>` instead, or pass `className="price-strong"` and add a small CSS
rule to bold the inner text.)

Import:
```ts
import { PriceFlicker } from '../common/PriceFlicker';
```

## 4. Future surfaces — Screener tab, MarkerSheet preview, anything else

Same pattern. The component is layout-agnostic; it wraps any price span,
inherits parent typography, and shifts nothing when the arrow appears.

## 5. CSS — append to `client/src/styles/components.css`

```css
/* Price-change animation (PriceFlicker) — single flash on any change,
   double on bigger moves (scaled to today's realized volatility).
   Never hides the number — the arrow is absolutely positioned. */

.price-flicker {
  position: relative;
  display: inline-block;
}

.price-flicker-text {
  display: inline-block;
  transition: color 200ms ease-out;
}

.price-flicker-up   { animation: priceFlashUp   200ms ease-out 1; }
.price-flicker-down { animation: priceFlashDown 200ms ease-out 1; }

.price-flicker-up.price-flicker-big   { animation: priceFlashUp   500ms ease-out 2; }
.price-flicker-down.price-flicker-big { animation: priceFlashDown 500ms ease-out 2; }

@keyframes priceFlashUp {
  0%   { color: var(--color-positive, #10b981); }
  100% { color: inherit; }
}
@keyframes priceFlashDown {
  0%   { color: var(--color-negative, #ef4444); }
  100% { color: inherit; }
}

.price-flicker-arrow {
  position: absolute;
  left: 100%;
  top: 50%;
  transform: translate(4px, -50%);
  font-size: 0.7em;
  line-height: 1;
  pointer-events: none;
  animation: priceArrowFade 300ms ease-out forwards;
}

.price-flicker-arrow-up   { color: var(--color-positive, #10b981); }
.price-flicker-arrow-down { color: var(--color-negative, #ef4444); }
.price-flicker-arrow-big  { animation-duration: 500ms; font-size: 0.85em; }

@keyframes priceArrowFade {
  0%   { opacity: 0; transform: translate(4px, -50%) scale(0.7); }
  20%  { opacity: 1; transform: translate(4px, -50%) scale(1); }
  100% { opacity: 0; transform: translate(8px, -50%) scale(1); }
}
```

CSS vars `--color-positive` / `--color-negative` likely already exist in the
theme; confirm via `grep --color-positive client/src/styles/`. The component
uses safe fallback hex values either way.

## 6. Verification (when ready to ship)

After wiring all three surfaces:

- Open Watchlist on a high-vol ticker during market hours — should flash on
  every Realtime quote update. Sub-second visual.
- Open Portfolio with a held position — same flash behavior on the
  PositionCard's price line. Today's P&L line stays unaffected (separate text).
- Open TickerDetail for any ticker — price in the header flashes; chart and
  market-stats panels render normally beneath.
- Calm ticker → only single flash ever (the 0.5% absolute floor prevents
  micro-wiggle double-flashes).
- Big mover (REPL, MNTS post-news) → double flash on real moves; single flash
  on intra-leg wiggles.
- Layout stays anchored across all three surfaces: arrow appears/disappears
  to the right, price text never shifts horizontally.
