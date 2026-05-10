# Upside — Build Queue

Reference spec: UPSIDE_MVP_SPEC.md

## How this works
- Each batch is a self-contained unit of work for Claude Code
- Process in FIFO order unless noted otherwise
- A batch can be amended BEFORE the agent starts it (add items under the batch)
- Once a batch is IN PROGRESS, it's locked — further changes go into a new batch
- Mark batches as DONE when complete

---

## Batch 1: Portfolio home screen [READY]

**Status:** READY — agent can start this now

**Scope:** Build the complete Portfolio Home screen with mock data.

**Instructions for agent:**
Read `UPSIDE_MVP_SPEC.md`, specifically:
- "Screen 1: Portfolio Home" section (full spec)
- "Design System" section (colors, typography, spacing, dark mode)
- "Key Metrics & Calculations" section (tint opacity, P&L color, VWAP, weight bar)
- "Project Structure" section (file organization)

**Deliverables:**
1. Scaffold React + Vite + TypeScript project
2. Build all Portfolio Home components:
   - `PositionCard.tsx` — full card layout with ticker/company, combined P&L, sparkline, price, today's change, VWAP indicator, portfolio weight bar, background tint, conditional signal row
   - `SummaryStrip.tsx` — two metric cards (portfolio value + MTD return)
   - `SortBar.tsx` — three sort pill toggles (Signals, P&L, Custom)
   - `MarketPeriodBadge.tsx` — tappable badge with dropdown showing exchange hours
   - `Sparkline.tsx` — inline 7-day SVG sparkline component
   - `BottomNav.tsx` — four-tab navigation bar
3. Mock data file with 5-6 realistic positions (mix of gains, losses, near-zero)
4. Dark mode support via CSS variables
5. Mobile-first responsive layout (375-390px primary)
6. PWA manifest + service worker shell

**DO NOT build in this batch:**
- Backend / API connections
- Real IB data fetching
- Signal engine
- Any screen other than Portfolio Home

---

## Batch 2: Ticker detail screen [PENDING]

**Status:** PENDING — design in progress, do not start

**Scope:** TBD — being designed in planning conversation

---

## Batch 3: (unassigned) [PENDING]

---

## Completed
(none yet)
