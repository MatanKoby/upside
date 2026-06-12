# Upside — Target Architecture (Arch batch)

Status: **planning → executing.** This is an *engineering refactor plan*, not product spec.
Companion to the live-system map in [`server-architecture.html`](server-architecture.html)
and `spec/data/consumers.md`.

## Goal

Make every module do **one job**: high-quality, design-pattern-idiomatic, scalable, fast.
Refactor **incrementally — one slice at a time, no big-bang.** This is a live trading
system; every step must be safe and reversible.

## Four pillars

| Pillar | One line |
| --- | --- |
| **Ports & adapters** | Integrations (IB, Finnhub, Discord…) sit behind an interface; callers depend on the interface, not the vendor. |
| **Pure core** | The math (scorers, band engine, risk/sentiment compute) as pure functions — **no DB, no network, no clock**. |
| **TableModule** | One gatekeeper module per Supabase table; the **only** place that table is read or written. |
| **Scheduler** | One `schedule({ every, run })` primitive; crons stop hand-rolling `setTimeout`. |

## Target layout (the destination)

```
server/src/
  kernel/     scheduler · queue · pipeline · strategy · alerts · notify · config · clock
  adapters/   ib/ finnhub/ polygon/ yahoo/ llm/ discord/ supabase(TableModules)/ redis/
  domain/     pricing/ bands/ signals/ traits/ dip-bounce/ risk/ news/      (PURE, no I/O)
  app/        use-cases / orchestration (poll engine, producers, alert dispatch)
  http/       routes/ middleware/ server.ts
  triggers/   cron declarations (one line each)
```

A cron then = four small things in four homes: **when** (`triggers/`) → **what** (`app/`) →
**math** (`domain/`) → **persistence** (`adapters/supabase` TableModules).

## Refactor order (each is its own Arch sub-batch)

1. ✅ **TableModules** — done (Phase 1). Mechanical, safe, no behavior change.
2. **Ports & adapters** ← *current.* Wrap each vendor behind a port.
3. **`schedule()` primitive** — collapse the ~20 `setTimeout` loops.
4. **Relocate pure core** into `domain/`.
5. *(optional)* **Explicit pipeline** for the screener chain (`universe → stats → traits → curated → fires → outcomes`).

Why this order: TableModules touch **only persistence call-sites**, change **no behavior**,
and are independently verifiable by grep — lowest risk, and they build the muscle for the rest.

---

## Phase 1 — TableModules (✅ complete)

**Rule.** Every `supabase().from('<table>')` read/write moves behind `<table>TableModule`.
**One writer-owner per table.** Same SQL, same row shape — just relocated and named. No behavior change.

**Home.** `server/src/db/` for now (moves under `adapters/supabase/` in the final layout — a trivial later move).

**Naming.** `newsSentimentTableModule`; methods are **intention-revealing** (`.save()`, `.getByConids()`,
`.purgeOlderThan()`) — never raw `.select()/.upsert()`. Row types live with the module.

**Reference (do first): `news_sentiment`** — 1 writer (`newsSentimentCron`) + 1 reader (`riskFlagsCron`).
Smallest surface, hard to fail. Shape:

```ts
// server/src/db/newsSentimentTableModule.ts
import { supabase } from '../services/supabase.js';

export interface NewsSentiment {
  conid: number;
  asofDate: string;        // 'YYYY-MM-DD'
  score: number;
  label: string;
  articleCount: number;
  topHeadline: string | null;
  topUrl: string | null;
}

export const newsSentimentTableModule = {
  /** Upsert one (conid, asof_date) row. SOLE writer of news_sentiment. */
  async save(s: NewsSentiment): Promise<void> {
    const { error } = await supabase().from('news_sentiment').upsert(
      {
        conid: s.conid, asof_date: s.asofDate, score: s.score, label: s.label,
        article_count: s.articleCount, top_headline: s.topHeadline, top_url: s.topUrl,
        source: 'lexicon', computed_at: new Date().toISOString(),
      },
      { onConflict: 'conid,asof_date' },
    );
    if (error) throw new Error(`newsSentiment.save: ${error.message}`);
  },

  /** Sentiment rows for a set of conids on a date — the risk-flags reader. */
  async getByConids(conids: number[], asofDate: string): Promise<NewsSentiment[]> {
    const { data, error } = await supabase()
      .from('news_sentiment')
      .select('conid, asof_date, score, label, article_count, top_headline, top_url')
      .in('conid', conids)
      .eq('asof_date', asofDate);
    if (error) throw new Error(`newsSentiment.getByConids: ${error.message}`);
    return (data ?? []).map((r) => ({
      conid: Number(r.conid), asofDate: String(r.asof_date), score: Number(r.score),
      label: String(r.label), articleCount: Number(r.article_count),
      topHeadline: r.top_headline ?? null, topUrl: r.top_url ?? null,
    }));
  },

  /** Retention — drop rows older than the cutoff date. */
  async purgeOlderThan(cutoffDate: string): Promise<void> {
    const { error } = await supabase().from('news_sentiment').delete().lt('asof_date', cutoffDate);
    if (error) throw new Error(`newsSentiment.purgeOlderThan: ${error.message}`);
  },
};
```

**Showcase (do second): `trait_scores`** — 3 writers (`catalystReversalProducer`,
`postEarningsDriftProducer`, `intradayRangeTraderProducer`) + retention, 1 reader (`curatedListCron`).
This is where the one-writer-owner rule earns its keep.

**Rollout order** (low coupling → high):
`news_sentiment → trait_scores → curated_list → entry_zones → band_state → intraday_stats →
daily_bars → universe → quotes → positions → signal_fires/outcomes → risk_flags →
watchlist_* → analyses/analysis_locks`.
(`screener_jobs` is already encapsulated in `services/jobs/queue.ts` — it's the prototype TableModule.)

**Progress (ARCH-3 = the remaining-tables rollout, one commit per table):**
✅ `news_sentiment` (ARCH-1) · ✅ `trait_scores` (ARCH-2) · ✅ `curated_list` · ✅ `entry_zones` ·
✅ `band_state` · ✅ `intraday_stats` · ✅ `daily_bars` — **single-writer half done.**
✅ `universe` — first of the multi-writer half: 6 writers / 16 call-sites / 10 files (nightly bulk
sweep + stale retention + real_conid stamp + weekly cap refresh + daily price/volume + auto-promote +
the `refresh_universe_avg_volume` RPC), all behind named methods; readers take a uniform `UniverseRow`.
✅ `quotes` — the price-SSOT hub: 3 write call-sites (the live canonical `upsertLiveQuote` that IB +
Finnhub + watchlist pollers funnel through, the daily-seed bulk upsert, the entry-zone sparkline) + 6
read shapes across 10 files. Column policy lives in the module; the *price policy* (which source is
canonical, the prev-canonical transition probe, freshness/ownership gates) stays in the services.
✅ `positions` — the holdings hub: 3 writers (the IB poller's full sync — `upsertHoldings` +
`deleteOrphans` + the no-positions `deleteAllForUser`; the Finnhub poller's `markFinnhubPriced`; the
`clearGapBadges` day-reset) + 8 read shapes across 11 files (portfolio routes, marketdata charting,
the analysis engine, the news/risk/dip-bounce working sets, the health probe). The module owns the
write-column projection (price/P&L moved to `quotes`, Batch X5); the *policy* (entry-date
reconciliation, change-detection, profit-zone transitions, the quotes mirror) stays in the pollers.
✅ `signal_fires` / `signal_outcomes` — the forward-tracking pair (two modules). dipBounceCron is the
sole `signal_fires` writer (`insertFire`) + a cooldown reader (`getRecentByKinds`); signalOutcomesCron
reads fires (`getRecentSince`) and owns `signal_outcomes` end-to-end (`getExistingOffsets` dedup +
`upsertOutcomes`). The dedup-to-newest map + the elapsed-offset/due math stay in the crons.
✅ `risk_flags` — already funnelled through one engine (`riskFlags/engine.ts` evaluateAndStore, driven
by both riskFlagsCron + signalEngine), so the module is a clean lift: 1 reader (`getPrevRow`
since-carry) + 2 writers (`deleteRow` clean-ticker clear, `upsertRow`). The since-carry policy + the
compute stay in the engine/domain; `flags` stays an opaque jsonb payload.
✅ `watchlist_*` — the trio, three modules. `watchlist_lists` (sync insert/meta-update + active toggle
+ the poller's active-id seed), `watchlist_items` (sync upsert + IB-orphan sweep + the active-set
read), `watchlist_markers` (the CRUD route's create/update/delete/ownership + markers.ts's
enabled-by-conid check + stampFired). The IB-reconciliation, transition/cooldown, and payload-
validation policy stay in the services/route; CRUD writes still return the raw snake_case row (the FE
wire contract).
✅ `analyses` / `analysis_locks` — the final pair, two modules. `analyses` (the /analyze re-analyze
soft-block read + signalEngine.persistAnalysis's sole insert returning analysis_id) and
`analysis_locks` (the route's running-lock check + insert, the engine's finally-release, the cleanup
cron's stale sweep). The expiry/supersede + lock-lifecycle policy stays in the route/engine/cron.

**Phase 1 (the 14-table rollout) is complete** — every table in the rollout order now reads/writes
only through its TableModule, grep-enforced, with the 204-test suite green at every slice. The
single-writer half (`news_sentiment` → `daily_bars`) plus the multi-writer half (`universe`,
`quotes`, `positions`, `signal_fires`/`signal_outcomes`, `risk_flags`, `watchlist_*`,
`analyses`/`analysis_locks`) are all behind named methods, one writer-owner each.

✅ **ARCH-4 — the remaining-tables sweep — is complete.** The stragglers never in the 14-table
rollout list are now gatekept too, so the "every table behind a module" rule holds with **zero**
`from(...)` outside a module (grep-enforced):
- `app_config` → `appConfigTableModule` (`tunnelWatcher` + the `appConfig.ts` kv service route through it).
- `access_attempts` → `accessAttemptsTableModule` (the Google-auth audit append).
- `external_api_metrics` → `externalApiMetricsTableModule` (the IB + Finnhub instrumentation writers + the retention sweep).
- `user_preferences` → `userPreferencesTableModule` (the prefs-route writer + the riskFlagsCron / profitZone / signalEngine readers; camelCase domain type).
- `contracts` → `contractsTableModule`, speaking the shared camelCase `Contract` (types/index.ts).
- `signals` → `signalsTableModule` (whole-analysis supersede + the two-shape insert).
- `screener_jobs` — the two maintenance crons (`jobsReaper` / `jobsRetention`) now call `reapExpiredClaims` / `purgeTerminalOlderThan` on the `queue.ts` prototype, so **all** `screener_jobs` access lives in one place.

Net: `signalEngine` and `ibPricePoller` no longer import `supabase` at all. **24 tables behind
TableModules (+ the base) + the `queue.ts` prototype = every Supabase table is gatekept.** Phase 1
is now fully done; the only remaining Phase-1 housekeeping is the mechanical `db/ → adapters/supabase/`
folder move (deferred — a trivial later relocation). Next: Phase 2 (ports & adapters).

**Definition of done, per table:**
- No `from('<table>')` anywhere outside its TableModule (grep-enforced).
- All call-sites use the named methods.
- Row type lives with the module.
- No behavior change — verified by the existing crons still producing the same rows.

## Phase 2 — Ports & adapters (current work)

**Rule.** Every external vendor sits behind **one adapter — the sole path of access to that vendor.**
Callers depend on a **Port** (a TS interface describing only the calls we actually make), never the
vendor SDK / HTTP client. Same three-part shape as TableModule, transposed from DB to HTTP:

| TableModule (Phase 1) | Port / Adapter (Phase 2) |
| --- | --- |
| `TableModule` base — `run(op, query)` error-wraps | **`HttpAdapter` base** — `get/post`: time → `externalApiMetrics.record` → classify status → `notifyApiFailure` → retry/timeout |
| subclass — snake↔camel + intention-revealing methods | **adapter** — wire→domain mapping + vendor quirks (rate-limit queue) |
| `export const xTableModule = new X()` | `export const polygon: PolygonPort = new PolygonAdapter()` |
| grep gate: no `from('<table>')` outside the module | grep gate: vendor base/key only under `adapters/<vendor>/` |

**Vendor-shaped, not capability-shaped.** One Port *per vendor*, shaped by what we actually call on
it — `PolygonPort`, `FinnhubPort`, `IbPort`, `Notifier`. **Not** a generic `PricesPort`: the
integrations don't offer the same surface (IB → positions/contracts/history; Finnhub →
news/fundamentals; Polygon → grouped daily; Discord → delivery), so a capability port would force
each vendor to fake methods it doesn't have. And prices — the one genuinely multi-vendor capability —
carry a deliberate **source-arbitration policy** (which source is canonical, freshness/ownership
gates, the prev-canonical probe; see `spec/architecture.md` + `spec/signals/playbook.md`) that lives
in `quotes.ts` / the pollers and **must not** dissolve into "any provider" — that's a behavior change
on a live trading system. Same call TableModule made: one gatekeeper per concrete thing, **policy
stays in callers.** A thin capability port can wrap the vendor ports *later* if we ever want runtime
price-provider swapping; we don't pay for it now.

**The base earns its keep.** `finnhub.ts` and `ibGateway.ts` are already de-facto adapters (one
private axios client, one `BASE`, the sole `notifyApiFailure`) — but each **hand-rolls the same
instrumentation** (time → record metric → classify status → notify → retry). `HttpAdapter` absorbs
that duplication, the way `TableModule.run()` absorbed error-wrapping. Phase 2 is relocation **+
de-dup**, not relocation alone.

**Home.** `adapters/<vendor>/` — `port.ts` (the interface) + `<vendor>Adapter.ts` (the impl). Slice 1
creates the `adapters/` root + the `HttpAdapter` base, and **folds in the deferred `db/ →
adapters/supabase/` move** (the TableModules relocate to their final home in the same structural
slice — a mechanical path change, no logic touched).

**Reference (do first): `polygon` + `yahoo`.** Polygon isn't a chokepoint today — it lives in
`services/universeQuote.ts` cohabiting with Yahoo (raw `axios.get`, both vendor bases side by side).
The reference slice is genuine consolidation: two tiny adapters, and `universeQuote.ts` empties to
(at most) pure mapping helpers. Both bases must leave that file for the gate to pass.

```ts
// adapters/polygon/port.ts — the contract callers depend on
export interface PolygonPort {
  /** Whole-market grouped daily bars for a date. null when the key is unset. */
  groupedDaily(date: string): Promise<DailyOhlcv[] | null>;
}

// adapters/polygon/polygonAdapter.ts — SOLE importer of the Polygon base + key
class PolygonAdapter extends HttpAdapter implements PolygonPort {
  constructor() { super('polygon', 'https://api.polygon.io'); }     // base = grep anchor
  async groupedDaily(date: string): Promise<DailyOhlcv[] | null> {
    if (!env.polygonApiKey) return null;
    const raw = await this.get(`/v2/aggs/grouped/locale/us/market/stocks/${date}`,
      { params: { adjusted: 'true', apiKey: env.polygonApiKey } }); // base owns metric+notify+retry
    return mapGrouped(raw);                                          // wire → DailyOhlcv[]
  }
}
export const polygon: PolygonPort = new PolygonAdapter();
```

Then `universeQuoteProducer` imports `{ polygon }` and calls `polygon.groupedDaily(date)`.

**Rollout order** (reference-first, low surface → high):
1. ✅ **`polygon` + `yahoo`** (ARCH-5) — the reference; built `HttpAdapter` + the `adapters/` root + the supabase folder move.
2. ✅ **`discord`** (ARCH-6) — `notify.ts` → `Notifier`; the adapter owns channel→webhook-URL resolution + delivery, `notify.ts` keeps cooldown + the 14 formatters.
3. ✅ **`finnhub`** (ARCH-7) — `FinnhubPort` + the `finnhub` singleton; the queue (`finnhubQueue.ts`) moved in as the adapter's rate-limit quirk, and the hand-rolled instrumentation landed on `HttpAdapter.instrumented()`.
4. ✅ **`ib`** (ARCH-8) — the gateway HTTP half: `IbGatewayPort` + `IbGatewayAdapter extends HttpAdapter` (sole `env.ibGatewayUrl` reader; owns the client, self-signed `httpsAgent`, 100ms rate limit, all ~18 calls + the snapshot retry + the debug passthrough); the pure `entryFrom*` helpers split to `adapters/ib/entryDeduction.ts`; 20 callers rewired, `services/ibGateway.ts` deleted. 8a grew `HttpAdapter.instrumented()` (retry counter, `detail`, `skipNotify`, `rawData`). `ibContainer`/`ibMappers`/`ibPassthroughAllowlist` stay put.
- **Deferred:** `llm` (Analyze-flow is roadmap Track 4 — `spec/roadmap.md`); `yahoo` rides slice 1 but stays minimal.

**Grep-gate anchors:** `api.polygon.io` / `env.polygonApiKey` · `query1.finance.yahoo.com` ·
`finnhub.io` / `env.finnhubApiKey` · `env.ibGatewayUrl` (the gateway client) · the
`env.discord*WebhookUrl` set — each appears only under its `adapters/<vendor>/`.

**Definition of done, per vendor:**
- A `Port` interface callers depend on; the adapter is the sole vendor-SDK/base importer (grep-enforced).
- Cross-cutting (timing, metric, notify, retry) in `HttpAdapter`; business policy (price arbitration, cooldowns) stays in callers.
- No behavior change — same endpoints, params, mapping; 204/204 vitest green.
- One commit per vendor; wire/domain types live with the adapter.
- Test seam: prod singleton; the adapter takes its http client via constructor so a test can inject a fake — added only where a test needs it.

**Progress (ARCH-5 — reference slice shipped 2026-06-11):** `HttpAdapter` base + the
`adapters/` root stood up; Polygon + Yahoo extracted out of `services/universeQuote.ts`
into `adapters/polygon/` + `adapters/yahoo/` (vendor-shaped Ports + `polygon`/`yahoo`
singletons), the shared `DailyOhlcv` moved to `types/`, `universeQuote.ts` deleted (its 9
parser tests split into co-located `polygonAdapter.test.ts` + `yahooAdapter.test.ts`, which
mock `axios.create` to inject a fake client — the test seam). The deferred **`db/ →
adapters/supabase/` move is done** — all 25 TableModules now live under `adapters/`, closing
the last Phase-1 housekeeping item. The base shipped **minimal** (one client + base URL +
permissive `validateStatus`); it absorbs the metric/notify/retry that `finnhub.ts` +
`ibGateway.ts` hand-roll **when those vendors migrate** (the next slices), the way
`TableModule` grew `runCount` only when a slice needed it. No behavior change; grep gate
clean (vendor base/key only under `adapters/`); 204/204.

**Progress (ARCH-6 — discord shipped 2026-06-11):** `notify.ts` inverted onto a new
`adapters/discord/` — `port.ts` (`Notifier`: `post(channel, payload)` + `has(channel)` over
logical `DiscordChannel` names) + `discordAdapter.ts` (SOLE importer of the 9
`env.discord*WebhookUrl` fields; owns channel→URL resolution incl. the critical→routine
fallback, the 5s-timeout `axios.post`, never-throw swallow, no-op-when-unconfigured).
Discord is a multi-full-URL delivery sink, not a single-base REST API, so the adapter does
**not** extend `HttpAdapter` (the "implement their own version" case) — its delivery is an
injectable constructor seam instead. `notify.ts` keeps all policy: the cooldown state,
severity→color, and the 14 alert formatters; `has()` preserves the exact
early-bail-before-cooldown semantics of the old `webhookFor()`/`!url` guard. No behavior
change; grep gate clean (`env.discord*` only under `adapters/discord/`); 208/208 (+4 adapter
tests). 

**Progress (ARCH-7 — finnhub shipped 2026-06-11):** `services/finnhub.ts` inverted into
`adapters/finnhub/` — `port.ts` (`FinnhubPort` + the five vendor-shaped types) +
`finnhubAdapter.ts` (SOLE importer of `env.finnhubApiKey`, sole path to `finnhub.io`), with
`finnhubQueue.ts` moved in as the adapter's own quirk (the per-call rate-limit + min-interval
ceiling polygon/yahoo lack; the token rides as a `?token=` query param). **The base earned its
keep:** the timing → `external_api_metrics` → `notifyApiFailure` wrapper `finnhub.ts` hand-rolled
now lives in `HttpAdapter.instrumented()`, with provider/endpoint/notify-key derived from the
`vendor` field (`<vendor>` / `<vendor>:<category>` / `<vendor>_api.<category>`) — shared, not
finnhub-specific. polygon/yahoo keep calling raw `get()` (their callers own their notify policy)
and never touch `instrumented()`. All 9 callers rewired from free functions to the `finnhub`
singleton; the two externally-used vendor types (`FinnhubMetrics`, `FinnhubEarningsRow`) moved to
the port. No behavior change; grep gate clean (`finnhub.io` / `env.finnhubApiKey` / `finnhubQueue`
only under `adapters/finnhub/`); 215/215 (+7 adapter tests). `llm` deferred (roadmap Track 4).**

**Progress (ARCH-8 — ib shipped 2026-06-12, the last Phase-2 slice):** `services/ibGateway.ts`
inverted into `adapters/ib/` in two commits. **8a** grew `HttpAdapter.instrumented()` for the
things finnhub didn't exercise, each opt-in so the finnhub path stays byte-identical: a
caller-bumpable retry counter (`request` receives a `retry()` for ibSnapshot's subscribe-then-poll
loop), `detail: "after N retries"`, `skipNotify` (the debug passthrough records a metric but never
pings Discord), and `rawData` (return the body even on a non-2xx so the passthrough relays IB's
actual error) — +6 base tests. **8b** stood up `IbGatewayPort` (16 vendor-shaped methods + the
`RawIbTransaction`/`RawIbTrade`/`IbRawResponse` wire types) + `IbGatewayAdapter` (SOLE
`env.ibGatewayUrl` reader; owns the client + self-signed `httpsAgent` via a new `HttpAdapter`
`clientConfig` ctor arg + the 100ms rate limit + all ~18 calls + the snapshot retry + the raw
passthrough); auth/session calls stay un-instrumented as before. The pure `entryFrom*` deduction
moved to `adapters/ib/entryDeduction.ts`. **20** callers rewired to the `ibGateway` singleton (the
brief's "15" undercounted — `services/*` import via `./ibGateway.js`), incl. `owner.ts`'s inline
`/iserver/accounts` call folded into `ibGateway.accounts()` — the one other `env.ibGatewayUrl`
reader, so the **grep gate flips green** (`env.ibGatewayUrl` only under `adapters/ib/`).
`services/ibGateway.ts` deleted; `ibContainer`/`ibMappers`/`ibPassthroughAllowlist` stay put.
No control-flow change; two surfaced audit-only deltas (metric `endpoint` now vendor-namespaced
`ib:<path>`; the ibTransactions/ibTrades non-2xx warn drops the now-nulled body — it still reaches
Discord). Typecheck clean; 221/221 (+6); grep gate clean. **Phase 2 complete** (bar the deferred
`llm`). Next: Phase 3 (`schedule()` primitive) → Phase 4 (pure core into `domain/`).

## Strategy

Walking skeleton: build the **reference** (`news_sentiment`), review it together, then roll out
table-by-table. Each table is small and independently shippable as its own commit.
