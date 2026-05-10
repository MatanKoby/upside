# Upside — Build Queue

Reference spec: UPSIDE_MVP_SPEC.md
Collaboration protocol (claim, hand-off, commit conventions): AGENTS.md

## How this works
- Each batch is a self-contained unit of work for an agent (Claude Code or Cursor)
- Process in FIFO order unless noted otherwise
- A batch can be amended BEFORE the agent starts it (add items under the batch)
- Once a batch is IN PROGRESS, it's locked — further scope changes go into a new batch
- Each batch carries four state fields: `Status`, `Owner`, `Started`, `Finished`
- Claim a batch by following the claim protocol in AGENTS.md (pull → flip Status/Owner/Started → commit). Finish by moving it under `## Completed` with `Status: DONE`.

---

## Batch 1: Portfolio home screen [READY]

**Status:** READY
**Owner:** none
**Started:** —
**Finished:** —

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

**Status:** PENDING
**Owner:** none
**Started:** —
**Finished:** —

**Scope:** TBD — being designed in planning conversation. Do not start.

---

## Batch 3: (unassigned) [PENDING]

**Status:** PENDING
**Owner:** none
**Started:** —
**Finished:** —

---

## Completed
(none yet)
