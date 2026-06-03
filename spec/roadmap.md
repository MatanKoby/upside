# Post-MVP Roadmap

Design intent for features built **after** MVP completion (Batch 16). MVP scope is sealed; items here cannot enter MVP unless they become hard dependencies of an MVP item. This file is the design-lock for these features so when their batches eventually get written, the agent doesn't have to re-litigate architecture.

Items in approximate build order, with Watchlist track first since it's the largest cohesive block and unlocks everything that follows it.

---

## Contextual Settings Pattern

A UX convention used throughout: **settings are contextual to the screen they affect, not centralized into one mega-settings-screen.**

- **App-level Settings** (Settings tab in bottom nav) — only truly app-wide concerns: IB Connection, signal generation threshold, profit-zone threshold, theme, LLM provider, sign out. See `screens/_design-system.md` → Screen 4.
- **Per-screen Settings** — accessed via a gear icon (ti-settings) in the top-right of the screen header. Tapping opens a sheet/modal scoped to that context, not a full screen takeover:
  - **Portfolio screen**: sort defaults, custom-sort drag order management.
  - **Watchlists tab** (the list-of-watchlists view): "Unhide watchlists," reorder visible watchlists.
  - **Single watchlist screen**: "Unhide tickers in this watchlist," watchlist-specific display preferences.
  - **TickerDetail screen**: already exists as the inline "Edit" link on MarketStats; stays.
  - **Alerts screen**: display-filter defaults, "Mark all seen" controls (if added).

The pattern keeps the app-level Settings screen clean. When adding a new screen in the future, check if any of its preferences are screen-scoped — if yes, they belong in that screen's gear icon, not in app-level Settings.

---

## Track 1: Watchlists + BUY Signals UI — MOVED INTO MVP (2026-05-28 pivot)

> **Track 1 was promoted into MVP** by the watchlist pivot. The watchlist surface plus its LLM-free signal primitives ship as Batches A1 (watchlists + quotes table), A2 (manual markers + dip-buy alerts), A+ (dynamic entry-zone engine), and B (intraday-stats engine). See `screens/watchlist.md`, `signals/markers.md`, `signals/entry-zones.md`. The original Track-1 BUY-signal UI (auto-populated "Active Watchlist" driven by the LLM playbook engine) remains here as forward-spec for when LLM-signal quality is sharpened post-pivot.

### Deferred behind the watchlist pivot

- **Structure-feature redesign** (tasks #11–15, #18 in the planning log): ADX gate + DI direction, anchor `structure` to the prior major low (not the immediately-prior swing only), widen the label space (`basing | consolidating | strong-up/down`), RSI divergence flag (filtered), optional consolidating composite score, market-relative RS (needs SPY series). The current `structure` label uses a too-blunt last-two-swings comparison and can mislabel a coiling base as a downtrend (BBAI case from 14g testing). Queue after the watchlist surface is live.
- **Refine mode + live per-leg tracking** (Batch 14h).
- **Accuracy cron** (Batch 14b).
- **`fresh-or-stop` engine guard** is *spec'd* but waits to be implemented (the watchlist work doesn't run the LLM engine).

---

### Original Track-1 design (forward-spec — kept for the LLM Active-Watchlist piece)

**Goal:** unlock buy-side intelligence. User can see all tickers they're tracking in IB, hide noise, get BUY signals on demand for any tracked ticker, and have an auto-populated "Active Watchlist" of tickers currently showing live BUY signals.

> BUY signals themselves ship in **MVP** (Batch 14a, unified analysis decision). What Track 1 adds is the **UI** to browse them as a list. Engine is unchanged.

### Architecture: three list-of-tickers surfaces

All flow into the same TickerDetail screen. Three contexts differ in **how the list is populated**:

1. **Portfolio** — system-written from IB positions. User has zero curation.
2. **Watchlists (regular)** — one-way mirror from IB watchlists. System-written from IB. Upside cannot create, rename, or edit membership. Watchlists in Upside follow IB's lead the same way Portfolio does.
3. **Active Watchlist** — system-written, derived from signal state. Contains every ticker (from any watchlist) that currently has a live, non-superseded, non-expired BUY signal.

User curation lives in a single Upside-side mechanism: **hide**. Watchlists can be hidden from the tab strip. Tickers within a watchlist can be hidden from the list. Hiding is reversible via per-screen Settings. Hiding ≠ deleting — the IB-mirrored data is untouched, only the visibility flag is Upside-side.

When the user truly wants a watchlist (or ticker on it) gone permanently, they delete it in IB. Upside's next sync removes it. **One source of truth for membership: IB.** Same trust pattern as Portfolio.

### Two-way creation: deferred

Letting Upside create or edit IB-side watchlists is **explicitly deferred to a later post-MVP track (Track 2)**. Until that lands, the one-way model is the design.

### Screens

Watchlists screen (the tab) and Single watchlist screen are spec'd at full screen-detail in `screens/_design-system.md` → Screens 5 + 6. Includes the Active Watchlist's two-collapsible-container pattern (Live + Watching).

### The Active Watchlist (computed, not stored)

Derived virtual list. No stored membership — computed from `signals`:

> Member = { any non-superseded, non-expired BUY signal row }

Rendered with two collapsible containers inside the Active tab:
- **Live** (expanded by default) — BUY signals where current price ∈ `[priceRangeLow, priceRangeHigh]`.
- **Watching** (collapsed by default) — BUY signals alive but current price not yet in range.

No proximity threshold. Binary membership based on signal lifecycle.

Recomputed on every signal change (Realtime) and every price write (Live/Watching partition shifts as price moves). Rendered with TickerCard `variant='watchlist'`. BUY signal pill always present (membership criterion).

The two-container pattern generalizes — future Tracks may add buckets like "Recently expired (last 7 days)" or "Approaching SELL range on held tickers" without changing the structural pattern.

### Data model

```sql
-- One row per IB watchlist mirrored into Upside.
-- Membership and metadata are IB-authoritative. Upside writes only on sync.
create table watchlists (
  id text primary key,                  -- IB watchlist ID
  user_id uuid not null references auth.users(id),
  name text not null,                   -- IB-supplied name
  position int not null default 0,      -- IB-supplied display order
  last_synced_at timestamptz not null default now(),
  hidden_at timestamptz null,           -- Upside-side flag, user-set
  unique (user_id, id)
);

-- One row per (watchlist, ticker) pair.
-- Membership IB-authoritative; Upside writes only on sync.
-- hidden_at is Upside-side, user-set.
create table watchlist_tickers (
  watchlist_id text not null references watchlists(id) on delete cascade,
  conid bigint not null,
  symbol text not null,
  position int not null default 0,      -- IB-supplied display order within watchlist
  added_at timestamptz not null default now(),  -- when first synced
  hidden_at timestamptz null,
  primary key (watchlist_id, conid)
);
```

Active Watchlist is a derived view:

```sql
create view active_watchlist as
select distinct on (s.symbol)
  s.symbol, s.conid, s.* as signal
from signals s
where s.signal_type = 'buy'
  and s.superseded_by_analysis_id is null
  and s.expires_at > now()
order by s.symbol, s.analyzed_at desc;
```

The Live / Watching partition is computed FE-side from this view, comparing each signal row's `priceRangeLow`/`priceRangeHigh` against the corresponding position's `current_price`. The view itself doesn't filter on price.

### Sync mechanism

Watchlist sync runs **on IB connection** — every time IBeam transitions from `connecting` to `connected`, the BE fires one watchlist sync. Same status-transition hook that starts `ibPricePoller`. Pulls IB watchlists via `/v1/api/iserver/watchlists` and per-watchlist `/v1/api/iserver/watchlist?id=<id>`. Upserts into `watchlists` and `watchlist_tickers`. Deletes (cascade) rows for watchlists no longer present in IB.

**No background cron.** When IB is `stopped` or `disconnected` we don't sync — there's no live session to query. The on-connect trigger covers the realistic use case.

**Pull-to-refresh** on the Watchlists screen handles the mid-session edge case: user adds a ticker in IBKR Mobile while Upside is open with IB connected. Pulling down re-fires the sync. Cheap, predictable, user-visible.

User-set `hidden_at` flags are preserved across syncs (the sync writes to `name`, `position`, membership rows — not to `hidden_at`).

**Capture the IB endpoints first.** Use the generic IB passthrough endpoint (Batch 13.2) to fetch real watchlist data from your live IB account and inspect response shapes before locking the schema and sync logic in.

### Track 1 UI specifics

- Same Analyze button on TickerDetail regardless of variant. For non-held tickers, Analyze is the only action — no PositionStats section.
- BUY signal pill colors: green (`bg #EAF3DE / text #173404` in dark mode). Pill format: `[Buy · 71% · pullback · $135-138]`.
- `DISCORD_WEBHOOK_SIGNALS_BUY` channel — already added in MVP Batch 14d.

### Build order within this track

1. **IB watchlist import (one-way mirror)** — schema, sync hook, FE plumbing to read `watchlists` and `watchlist_tickers`. No screen yet. Internal foundation.
2. **Watchlists screen + tab strip + Active Watchlist + TickerCard `variant='watchlist'`** — one cohesive batch. Most code already exists from MVP (signal engine, TickerDetail, signal pills, Discord notifier); the surface area is the UI.

Two batches total. Both depend on Batch 16 (MVP complete) at minimum and Batch 13.2 (passthrough endpoint, used for capturing IB watchlist shapes ahead of design).

---

## Track 2: Two-Way Watchlist Editing

Upside can create / rename / edit-membership of IB watchlists. Requires figuring out whether IB Client Portal exposes write endpoints for watchlists (TBD via passthrough capture) and the conflict-resolution model when both Upside and IB-native UI modify the same watchlist. Likely last-write-wins with a "modified in Upside" indicator.

Deferred until Track 1 has been in use long enough to know whether two-way is actually wanted (vs. accepted that IB is the editing surface).

---

## Track 3: Smarter Analyze Workflows

The user goes ticker by ticker and clicks Analyze on what they care about. Every LLM call is a deliberate user action — that's the cost control. These workflows scale user attention without abandoning that control.

1. **Multi-select Analyze** — checkbox on cards, "Analyze selected" button, sequential execution, cost-capped. Still user-gated.
2. **Analyze all visible** — single button on a watchlist or portfolio screen, runs the full visible list through the engine. Single user action.
3. **LLM-recommended triage** — two-round-trip flow:
   1. User taps "Recommend tickers to analyze" on a watchlist screen.
   2. BE collects light snapshots (price, today change, VWAP, latest news headlines, basic technicals) of all visible watchlist tickers — one batched LLM call: *"Given these snapshots, which 3-5 tickers look most worth a deep analysis right now, and why? Prefer undervalued + good news + good fundamentals + hasn't broken out yet."*
   3. LLM returns ranked short list with one-line reason each.
   4. FE renders the recommendations; user reviews and approves which ones to deep-analyze.
   5. Approved tickers go through normal Analyze flow one by one.
   6. Two LLM round-trips per ticker that gets analyzed. Zero LLM cost on rejected recommendations. 100% user-gated.

This is "LLM as triage assistant," not "LLM as autonomous scanner."

Each is a small additive feature on top of the existing engine. No new schema; just routing.

---

## Track 4: Signal Quality Feedback Loop

1. **Signal post-mortem with thumbs-up/down feedback** — auto-generates one-line outcome per expired/hit signal ("Sell signal on NVDA at $193-198 expired after 7 days, price peaked at $196.40 — didn't reach optimal"). User thumbs-up/down. Aggregates over time into "your accuracy on this LLM provider, this signal type, this market regime."
2. **"What changed" digest** — morning summary delivered via Discord and PWA push: overnight moves, upcoming earnings (next 7 days), new insider activity, zone-state changes since yesterday's close. High signal-density per screen.
3. **Position thesis** — user-editable text per position included in LLM analysis context. Forces articulation of why you hold what you hold; makes the LLM's reasoning specifically address your thesis ("you bought NVDA on AI capex tailwind; that thesis is intact but valuation has stretched...").
4. **Additional `contextualTriggers`** — imminent earnings (<24h), recent insider transactions, unusual volume, news-event proximity. Wires into the same `contextualTriggers` field reserved in MVP Batch 14a (see `signals/playbook.md`).
5. **Partial re-analysis (directed analyze)** — when chat lands, allow "just analyze SELL for NVDA" or "just analyze BUY" without re-running the full unified analysis. New analysis would supersede only the relevant direction's signal row, leaving the other direction's signal alive. Currently disallowed in MVP because it creates mismatched-age signals; revisit when chat surface makes the user intent explicit. Requires:
   - Direction parameter on the analyze route.
   - Per-direction supersede semantics (instead of analysis-id-level).
   - UI affordance to surface "this signal is fresh, that one is from 3 days ago" so the age mismatch is legible, not hidden.
6. **Multi-signal aggregation per direction with different motivations** — currently we persist one SELL and one BUY per analysis. The LLM might legitimately have multiple competing SELL motivations ("partial sell now to derisk, full sell at $X to take profit"), or a SELL plus a stop-out ("sell at $X profit target OR $Y stop-loss, whichever hits first"). Aggregation model TBD — either: (a) allow multiple SELL rows per analysis with different motivations, distinguished by `motivation` enum on the row, or (b) expand the per-direction schema to carry a list of `{ rangeLow, rangeHigh, optimalPrice, motivation, rationale }` instead of a single block. (b) is closer to how a real trader thinks ("I have three exit scenarios"). Wait until we've seen a few months of real signals before deciding — the data shape should follow how the LLM actually reasons.

---

## Track 5: New Surfaces

1. **AI chat — multi-feature LLM surface** (likely 4th bottom-nav tab or top-right header affordance). Encompasses:
   - Per-ticker analysis: "should I sell NVDA?" / "what about BBAI?" — routes to directed analysis (see Track 4 item 5 for the partial-supersede design that makes this feasible).
   - Recommendations: "what looks interesting in healthcare right now?" / "any undervalued names with upcoming catalysts?" — routes through the LLM-triage two-round-trip flow (Track 3).
   - Filter / screen: "show me my positions with imminent earnings" / "list watchlist tickers near 52w low" — natural-language replacement for traditional screener UI.
   - Cross-position questions: "why is my portfolio red today?" — sourced answer pulling from positions + signals + news.
   
   Expensive (every message = at least one LLM call) — gate behind a daily message ceiling separate from the analyze ceiling. Chat replies embed TickerCard primitives inline so ticker context is rich (see `screens/_design-system.md` → Primitives catalog).

2. **Natural language ticker screener** — "show me tickers with RSI > 70 and earnings in the next 5 days." Standalone surface or chat capability — likely chat once chat lands.
3. **"Why didn't this fire?" inverse query** — cheap LLM call explaining why a position has no current signal. Different from full Analyze: cheaper, faster, no commitment. Builds trust in the no-signal state.
4. **Trade journal** — per-trade notes, %/day metric, post-trade reflection. Hooks into IB transactions endpoint for the entry/exit data, user adds reasoning.

---

## Track 6: Time Travel

1. **Replay mode** — view historical app state ("what would the app have shown 5 days ago?"). Killer feature for evaluating whether the system would have caught a move retrospectively. Requires keeping enough historical position + signal data to reconstruct; signals are already kept forever, position snapshots would need to start being persisted.

---

## Track 7: New Modalities

1. **Voice quick-analyze** — "Hey Upside, what about NVDA?" via Web Speech API. Free; matches the phone-first product shape.

---

## Track 8: New Asset Classes

1. **Options / shorts / trade execution** — separate concern, separate scope. Likely never enters this app's domain (Upside is intelligence, not execution); execution stays in IBKR Mobile / TWS. Listed for completeness.

---

## Track 9: Chart Data Resilience (research)

**Current limitation.** The TickerDetail price chart (`PriceChart.tsx`, fed by `GET /api/marketdata/history/:symbol`) draws candles from **IB history only** — there is no fallback source and the history endpoint does not cache to Redis. So when the IB session is disconnected the chart has nothing to plot and renders an explicit empty state ("Chart data unavailable — Live charts need an Interactive Brokers connection"). This is the honest state after the mock-data fallback was removed; previously it silently showed synthetic candles. Finnhub does **not** fill this gap: its free tier dropped `/stock/candle`, so `finnhub.ts` has no candle fetch — we use Finnhub only for `/quote` (price fallback) and `/stock/metric` (fundamentals).

> Note: `architecture.md` / `signals/playbook.md` / `flows.md` reference "Finnhub intraday candles" for the daily-hindsight accuracy cron. Verify whether that path is actually wired before relying on it as a chart source — it may share the same gap.

**Research task.** Investigate free-tier market-data providers that could supply intraday + historical OHLCV bars so charts survive IB outages (and ideally so a Redis-cached last-good window can render instantly). Candidates to evaluate on free-tier rate limits, history depth, intraday granularity, and ToS for redistribution/caching:

- **Alpaca Market Data** (free IEX feed — bars + historical).
- **Polygon.io** (free tier: limited calls/min, delayed data).
- **Twelve Data**, **Tiingo**, **Alpha Vantage** (free but very low daily ceilings — Alpha Vantage was already rejected for live polling at 25/day, see `archive.md`).
- **yfinance / Yahoo** (unofficial, no key, ToS-gray).

Deliverable of the research: pick one, define the timeframe→provider-param mapping (mirroring `TIMEFRAME_MAP` in `marketdata.ts`), and decide the caching/persistence model (per-symbol Redis window vs. DB-backed history) so charts no longer go blank when IB drops.

---

## Track 10: Screener — deferred items

Forward-spec for the intraday-scalping screener (`signals/screener-universe.md` + `signals/band-engine.md` + `screens/screener.md`). Items here are deliberately NOT in slice 1; each carries an **empirical trigger condition** for revisit so we don't add them prematurely.

### RSS catalyst-news firehose

SEC EDGAR 8-K stream + FDA Drug Approvals RSS + PR Newswire / BusinessWire / GlobeNewswire + Nasdaq Trader corporate actions. Ticker extraction by regex + universe-table lookup. Polarity scoring by keyword (approval / beats / raises = +1; downgrade / investigation / halt = −1). **No LLM in the pipeline** — keyword scoring is enough for "should I bother looking?"

Writes to a new `news_events` table: `(conid, source, headline, url, polarity, captured_at)`. Tagged conids surface in the Screener tab with a "news_event" annotation; the dynamic universe inclusion (Pre-Market Refresh Flow in `flows.md`) consumes the tag to auto-promote tickers earlier than volume-gap detection alone catches them.

**Revisit when** (both must hold):
1. The `catalyst_reversal` volume-gap trait has shipped and produced 1–2 weeks of live output.
2. We can point to ≥1 instance where the engine missed a tradeable move *and* RSS would have surfaced the catalyst first.

If volume-gap-only catches everything we care about, RSS is dead weight. The trigger is empirical, not calendar-based.

### Mid-day broad-pool discovery sweep

Currently dynamic universe inclusion runs only at 15:30 IDT (pre-market). A mid-day broad-pool sweep would scan the ~10k Ring-0 pool every 30 min during regular session for tickers reacting to mid-day news / surprise halts / lifted halts.

Cost: heavy — ~10k × every 30 min × 2 Finnhub calls = ~40k calls/day, blows the free-tier budget. Either gate behind a paid Finnhub tier or restrict to a Ring-0.5 narrower pool (~3k names with some loose pre-filter).

**Revisit when** we observe ≥3 mid-day moves the engine missed because the ticker wasn't in the curated list at the time. Until then nightly + pre-market sweep + dynamic inclusion is enough.

### Sell-side mirror engine (`typical_intraday_high`)

The `intraday_stats` engine currently produces `intraday_low_pct` (buy side). The mirror trait — typical intraday HIGH (open → session high) — completes the sell side for held positions. Small extension to `computeIntradayStats` (mirror tail, same fixtures, no new schema).

Once the trait exists, the Layer-3 walking band-state machine's `p50_high_fade_pct` term has a real value (currently it would have to estimate from the `open_fade_pct` field).

**Revisit when** the band engine ships and the buy-side bands prove out. Sell-side bands are mostly useful for held-position exit timing; buy-side first makes sense because "buying the lowest low" is the user-stated higher-conviction half ("safer, more margin of error").

### AH-calibrated bands (pre-market + after-hours separate engine)

The band engine today applies regular-session-calibrated bands to AH price action with a `ah_low_confidence` flag — informational only. A separate engine using AH-only bar history would calibrate bands for AH/PM behavior natively.

Trade-off: AH data is much sparser (1 hour AH × 60 sessions ≪ 6.5 hours regular × 60), so the bands would have lower statistical power.

**Revisit when** the user reports actual AH/PM scalping activity. If pre-market is the planning window and regular session is the trading window (matches the user's current pattern), the informational-only treatment is enough indefinitely.

### IBKR-side push of curated lists (Slice 4)

Push the screener's virtual lists into IBKR's native watchlist surface so the user sees the curated picks in IB Mobile without switching apps. Requires Batch 13.3 (secondary IBKR username) to unblock first — current API surface is GET-only by deliberate security policy, and POST to `/iserver/watchlist` shares auth context with order operations.

**Revisit when**:
1. Batch 13.3 ships (IBKR confirms secondary-user market-data cost).
2. User has used the screener tab for ≥1 week and identified at least one curated list worth elevating to IB Mobile.

Default until then: keep all screener output Upside-side only. The user picks one list to push manually.

### Auto-marker creation from band engine

Currently, band-touches notify (Discord) but don't write `watchlist_markers` rows. An auto-marker path would let the engine *propose* markers at high-confidence bands, the user accepts / dismisses / edits via the same `MarkerSheet`. Manual markers become a subset of "user-confirmed levels" alongside engine-proposed ones.

**Revisit when** the band engine has 2+ weeks of live data AND the user reports wanting to "save" specific bands as durable levels. The current promote-to-marker affordance (long-press on screener row) is the manual workaround; auto-creation only makes sense if the workaround feels too clicky.

### Auto-truncating lookback under vol_regime_shift

`vol_regime_shift` currently sets a flag + annotation. v2: when the flag fires, dynamically truncate the lookback window to post-shift sessions only when computing `intraday_stats`. The trick is detecting the regime break point cleanly (5-session ATR jump is noisy; need better edge detection).

**Revisit when** we have ≥5 observed `vol_regime_shift` cases logged, so the truncation rule can be calibrated against real data rather than a synthetic estimate.

---

## Tech debt + low-priority cleanups

A holding pen for known inefficiencies, minor bugs, and small architectural cleanups that aren't worth their own batch right now. Items move out of here either when their cost grows enough to matter or when a related batch picks them up "while we're touching that file." Distinct from the deferred-feature tracks above (those are forward functionality; this is hygiene on what already ships).

Format per entry: **what's wrong** · **observed impact** · **proposed fix** · **trigger to claim**.

### Unresolvable-symbol retry loop in conidResolutionProducer

**What's wrong:** when a universe ticker has no IB STK match (share-class suffixes like `BF.A` / `BF.B`, foreign-only listings, delisted-since-Finnhub-pull), the worker fails the job after 2 attempts and the producer calls `finalizeFailure` → row deleted from `screener_jobs`. **But** the next 24h producer cycle re-scans `universe WHERE real_conid IS NULL`, sees the same symbol, re-enqueues. Endless 24h-scale loop for permanently-unresolvable tickers.

**Observed impact (2026-06-02):** 7 unresolvable symbols out of ~3,000-row backlog → ~14 wasted IB secdef calls per symbol per year ≈ ~100 calls/year total. Negligible at current scale; would matter if the pattern grows or if IB rate-limits become tight.

**Proposed fix** (~10 min):
1. Migration: add `last_resolution_attempt_at timestamptz` to `universe`.
2. Producer `loadPendingRows` query: `... AND (last_resolution_attempt_at IS NULL OR last_resolution_attempt_at < now() - interval '7 days')`.
3. On `finalizeFailure`, producer updates the universe row's `last_resolution_attempt_at = now()`.

Result: each unresolvable symbol re-attempted at most weekly (catches genuinely-new IB indexings) while costing ~2 calls/symbol/week instead of ~2 calls/symbol/day.

**Trigger to claim:** when this category grows past ~50 symbols OR IB rate-limit budget becomes tight OR when next touching `conidResolutionProducer.ts` for another reason.

---

## Meta — agent context efficiency

Agent (Claude Code / Cursor) sessions on this repo run at 150k+ tokens routinely because the coordinating files (`BUILD_QUEUE.md`, `CLAIMS.md`) and the larger spec files exceed Read-tool single-call caps and force re-reads + truncation. Anthropic's own Skills file convention sits at <250 tokens per skill — a deliberate "one fact per file" discipline. We're missing that discipline; the result is wasted tokens, slower turns, and stale-context risk near the cap.

The fix is **measure first, split second** for content files — don't guess which are hot — but **structural moves that don't fragment content** (skill extraction, hierarchical indexes, slim-down of always-loaded policy files) ship now without needing data, because they're reversible and tighten the read-on-orientation footprint at almost zero risk.

### Observability: per-file Read counter

PreToolUse hook on the `Read` tool appends one line per call to a gitignored stats file (`.claude-stats/file-reads.log`): UTC timestamp, file path, byte count, session id. A small helper (`bin/upside-readstats`) aggregates: reads per file (lifetime + last 7 days), avg bytes per read, sessions touched. Lets us answer "which files cost the most context per week?" without guessing.

The hook is non-blocking (`exit 0` always) and stateless beyond the append; failure modes don't break tool calls. Opt-out by deleting the hook entry from `.claude/settings.local.json`.

### Splitting discipline (content files)

After ~1 week of stats, top-N hot **content** files get sliced. Two known-hot candidates ship immediately without needing data:

- **`BUILD_QUEUE.md`** (~1100 lines, ~38k tokens) — split into `BUILD_QUEUE.md` (un-done batches only) + `BUILD_QUEUE_DONE.md` (completed batch one-liners). Halves a typical orientation read.
- **`CLAIMS.md`** (~460 lines, ~30k tokens) — same split: `CLAIMS.md` (in-progress + recent completed) + `CLAIMS_DONE.md` (archive of older completed batches).

Other spec files (`spec/signals/*.md`, `spec/schema.md`, `spec/roadmap.md`) get split based on measured numbers — guessing without data risks fragmenting coherent reads that work fine today. The Anthropic Skill <250-token discipline is the **ceiling** to aspire to for per-fact files, not a one-size-fits-all rule for narrative spec files.

### Procedure extraction: AGENTS.md → skills

`AGENTS.md` (~230 lines) re-reads every session for orientation. Most of its bulk is *procedure* (claim protocol, finish protocol, push-race recovery, handoff, reclaim, design-decision persistence) rather than *policy*. Procedure moves into `.claude/skills/` SKILL.md files — invoked deliberately at the moment they apply, terse and focused. Policy stays in `AGENTS.md` as 2–3 line statements that point at the skill for the how.

Skill files are plain markdown — Cursor reads them like any other repo file even though it can't invoke them as Claude-Code skills. So one skill body = both agents see the convention; no duplication.

Three skills land in M1:

- **`claim-batch`** — claim protocol, push-race recovery, mid-batch handoff, stale-claim recovery. All four flows live here because they're the same flow at different moments.
- **`finish-batch`** — finish protocol (final commit, SHA capture, CLAIMS move-to-completed, `meta: complete` commit, push, `/compact` reminder).
- **`spec-edit`** — encodes the "before editing spec" checklist: match concern to file (use the per-folder README index), watch file size, prefer cross-reference over restatement, archive when no longer live, propagate design decisions to `BUILD_QUEUE.md`. Also encodes the per-folder README pattern below.

Description-line phrasing for each skill is written to fire on the right moment (e.g. spec-edit: "before editing any file under `spec/**`, or when persisting a design decision the user has just made") so the always-loaded skills index doubles as the trigger reminder.

### Hierarchical spec index

`spec/README.md` today carries the full file map for all 21 spec files in one table. As `spec/signals/` and `spec/screens/` grow, that table grows. Restructure to a fractal hierarchy:

- `spec/README.md` — slim top-level index: root files (architecture, flows, schema, job-queue, roadmap, archive) + pointers to the two sub-folder READMEs.
- `spec/signals/README.md` (new) — per-folder index for the 9 signal files.
- `spec/screens/README.md` (new) — per-folder index for the 7 screen files.

Read a small index as you navigate down the tree, instead of one big map every session. Scales as folders grow (e.g. when a `spec/signals/playbook.md` eventually warrants its own sub-folder, the pattern extends without redesign). Encoded in the `spec-edit` skill: when adding a spec file, place it in the matching sub-folder; add a one-line entry to that folder's `README.md`; cross-reference by relative path.

Token math at current scale is roughly a wash — the structural win (clearer hierarchy, easier to extend, encodes the carving rule at the folder level) is the real reason to ship it now.

### AGENTS.md slim-down

After the spec-map relocation and procedure extraction, `AGENTS.md` drops from ~230 to ~120 lines:

- Spec-map table → pointer to `spec/README.md` (which itself now points to the sub-folder READMEs).
- Claim/finish/handoff/reclaim/push-race sections → 3-line policy statement each + pointer to the owning skill.
- Design-and-spec-decisions section → 2-line policy statement + pointer to `spec-edit` skill.
- Commit-message convention table, file ownership, ideation handoff, branch model → all stay (brief, both-agent policy).

Net: ~4k tokens saved on every session orientation, single source of truth per concern.

### Non-goals

- Don't split content files that are already small and coherent just to hit a token target — coherence beats fragmentation.
- Don't auto-summarize the archive files; agents that need the full history still get it via a deliberate read.
- Don't add the counter to non-Read tools — Write/Edit/Bash are fast enough that the noise outweighs the data.
- Don't duplicate procedure between `AGENTS.md` and skill files — single source of truth, skill body is canonical for the how.
