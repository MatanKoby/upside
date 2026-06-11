// Signal engine (Batch 14g) — orchestrates a single-direction playbook analysis.
//
// Direction is chosen by holding status (held → SELL playbook, not-held → BUY).
// Pulls IB price/history + Finnhub context, computes the deterministic feature
// pack, asks the LLM for one direction's playbook, then persists one `analyses`
// row plus exactly ONE `signals` row (leg[0] mirrored into price_range_*; the
// full ordered legs + horizon in `playbook jsonb`) and supersedes any prior
// analysis for the same (user, symbol).
//
// Designed to run fire-and-forget from the route: it never throws to the
// caller and always releases the `analysis_locks` row in `finally`. Failures
// fail soft — a malformed LLM response (after one stricter retry) is persisted
// as a `no_signal` row rather than crashing the api.

import { supabase } from './supabase.js';
import { quotesTableModule } from '../db/quotesTableModule.js';
import { positionsTableModule } from '../db/positionsTableModule.js';
import { analysesTableModule } from '../db/analysesTableModule.js';
import { analysisLocksTableModule } from '../db/analysisLocksTableModule.js';
import { userPreferencesTableModule } from '../db/userPreferencesTableModule.js';
import { notifyError } from './notify.js';
import { ibSnapshot, ibHistory, ibContractInfo, ibSecdefSearch } from './ibGateway.js';
import { companyNews, earningsCalendar, insiderTransactions, basicFinancials } from './finnhub.js';
import { buildFeaturePack, type Bars, type FeaturePack } from './technicals.js';
import { buildRiskFlagInputs } from './riskFlags/inputs.js';
import { scoreNews, type NewsArticle } from './news/scoreNews.js';
import { evaluateAndStore, riskFlagAsofDate } from './riskFlags/engine.js';
import { resolveRiskFlagConfig, CRITICAL_QUALITY_CAP } from '../config/riskFlags.js';
import { incrLlmCallsToday } from './redis.js';
import {
  LlmError,
  type LlmAnalysisInput,
  type LlmAnalysisOutput,
  type SignalDirection,
  type PlaybookLeg,
} from './llm.js';
import { activeLlm } from './llmConfig.js';
import { endOfRegularSessionEtIso } from '../utils/marketHours.js';
import type { RawIbHistory } from '../types/index.js';

const DEFAULT_EXPIRY_DAYS = 7;

// User-facing `no_signal` reasons for LLM failures that re-prompting can't fix
// (the raw error detail still goes to #errors via notifyError).
const NON_MALFORMED_REASON: Record<'rate_limited' | 'unavailable' | 'config', string> = {
  rate_limited: 'LLM rate-limited (quota/billing) — try again shortly',
  unavailable: 'LLM provider unavailable — try again',
  config: 'LLM not configured — check API key / model',
};

interface RunOpts {
  userId: string;
  symbol: string;
  lockId: string;
}

// Largest day-count out of a free-text window ("1-2 weeks" → 14, "3 days" → 3),
// falling back to the default horizon. Recognises weeks/months loosely.
function windowDays(window: string | null | undefined): number {
  if (!window) return DEFAULT_EXPIRY_DAYS;
  const nums = window.match(/\d+/g)?.map(Number) ?? [];
  const max = nums.length ? Math.max(...nums) : DEFAULT_EXPIRY_DAYS;
  if (max <= 0) return DEFAULT_EXPIRY_DAYS;
  if (/month/i.test(window)) return max * 30;
  if (/week/i.test(window)) return max * 7;
  return max; // days (or unitless → treat as days)
}

function isoPlusDays(fromIso: string, days: number): string {
  return new Date(new Date(fromIso).getTime() + days * 86_400_000).toISOString();
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// RawIbHistory bars → column-wise Bars for the feature pack.
function toBars(hist: RawIbHistory | null): Bars {
  const d = hist?.data ?? [];
  return {
    o: d.map((b) => b.o),
    h: d.map((b) => b.h),
    l: d.map((b) => b.l),
    c: d.map((b) => b.c),
    v: d.map((b) => b.v),
  };
}

export async function runAnalysis(opts: RunOpts): Promise<void> {
  const { userId, lockId } = opts;
  const sym = opts.symbol.toUpperCase();
  const db = supabase();

  try {
    // --- Position + preferences ------------------------------------------
    const position = await positionsTableModule.getByUserAndSymbol(userId, sym).catch(() => null);

    const prefs = await userPreferencesTableModule.getByUserId(userId);

    // --- Direction by holding status -------------------------------------
    // Held → SELL playbook; not held (watchlist candidate) → BUY. MVP is
    // held-only, so every analyze today is a SELL.
    const isHeld = !!position && (num(position.shares) ?? 0) > 0;
    const direction: SignalDirection = isHeld ? 'sell' : 'buy';

    // --- Pre-LLM filters (skip entirely) ---------------------------------
    if ((prefs?.suppressedSymbols ?? []).includes(sym)) {
      console.log(`[signalEngine] ${sym} suppressed — skipping`);
      return;
    }
    if (isHeld) {
      const minMktValue = prefs?.signalMinMarketValue ?? 1000;
      // Price SSOT (Batch X5): market value = quotes.canonical_price × shares.
      const heldConid = position?.conid != null ? Number(position.conid) : null;
      let heldPrice: number | null = null;
      if (heldConid != null && Number.isFinite(heldConid)) {
        heldPrice = await quotesTableModule.getCanonicalPrice(heldConid).catch(() => null);
      }
      const mktValue = heldPrice != null ? (num(position?.shares) ?? 0) * heldPrice : null;
      // Only skip when we can actually price it below the floor; proceed if unpriced.
      if (mktValue != null && mktValue < minMktValue) {
        console.log(`[signalEngine] ${sym} held value ${mktValue} < ${minMktValue} — skipping`);
        return;
      }
    }

    // --- Resolve conid + company name ------------------------------------
    let conid: number | null = position?.conid != null ? Number(position.conid) : null;
    let companyName: string | null = position?.companyName ?? null;
    if (conid == null) {
      const results = await ibSecdefSearch(sym);
      const stk = results.find((r) => r.sections?.some((s) => s.secType === 'STK')) ?? results[0];
      if (stk) {
        conid = Number(stk.conid);
        companyName = companyName ?? stk.companyName ?? null;
      }
    }
    if (conid == null || !Number.isFinite(conid)) {
      await persistNoSignal(userId, sym, null, `Could not resolve an IB contract for ${sym}.`, {});
      return;
    }

    // --- Ensure contracts cache row (lazy) -------------------------------
    const { data: contractRow } = await db
      .from('contracts')
      .select('conid, company_name')
      .eq('conid', conid)
      .maybeSingle();
    if (!contractRow) {
      const info = await ibContractInfo(conid);
      if (info) {
        companyName = companyName ?? info.company_name ?? null;
        await db.from('contracts').upsert({
          conid,
          symbol: sym,
          company_name: info.company_name,
          industry: info.industry,
          category: info.category,
          asset_class: info.instrument_type ?? 'STK',
          currency: info.currency ?? 'USD',
          exchange: info.exchange,
          valid_exchanges: info.valid_exchanges,
          refreshed_at: new Date().toISOString(),
        });
      }
    } else {
      companyName = companyName ?? contractRow.company_name ?? null;
    }

    // --- Current price (IB snapshot, fall back to canonical quote) -------
    // Price SSOT (Batch X5): the fallback is quotes.canonical_price by conid,
    // not a positions column.
    let currentPrice: number | null = await quotesTableModule.getCanonicalPrice(conid).catch(() => null);
    const snap = await ibSnapshot([conid]).catch(() => []);
    const live = num(snap[0]?.['31']);
    if (live != null) currentPrice = live;

    // Held P&L% recomputed from the live price + avg cost (was positions.unrealized_pnl_pct).
    const heldAvgCost = isHeld ? (num(position?.avgCost) ?? 0) : 0;
    const heldPnlPct =
      isHeld && heldAvgCost > 0 && currentPrice != null ? (currentPrice / heldAvgCost - 1) * 100 : null;

    // --- IB history → feature pack (the LLM's grounding) -----------------
    const daily = await ibHistory(conid, '1y', '1d');
    const intraday = await ibHistory(conid, '1d', '5min');
    const avgCost = isHeld ? num(position?.avgCost) : null;
    const dailyBars = toBars(daily);
    const featurePack = buildFeaturePack({
      daily: dailyBars,
      intraday: intraday ? toBars(intraday) : null,
      currentPrice,
      avgCost,
    });

    // --- Finnhub context (each source isolated) --------------------------
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
    const [news, earnings, insider, metric] = await Promise.all([
      companyNews(sym, from, to).catch(() => [] as unknown[]),
      earningsCalendar(sym).catch(() => null),
      insiderTransactions(sym).catch(() => null),
      basicFinancials(sym).catch(() => null),
    ]);

    // --- Risk flags (daily-grain; on-demand top-up + LLM clamp) ----------
    // Reuses the bars + earnings + market cap we already pulled. Persists the
    // row (Realtime → card badge / Risk-flags section, Batch R2) and feeds the
    // LLM both as prompt context and, on CRITICAL, a hard quality clamp.
    const riskConfig = resolveRiskFlagConfig(prefs?.riskFlagConfig);
    const riskInputs = buildRiskFlagInputs({
      closes: dailyBars.c,
      volumes: dailyBars.v,
      high52w: featurePack.levels.high52w,
      currentPrice,
      metric,
      earningsRaw: earnings,
      config: riskConfig,
      // Batch X7 — score the headlines we already pulled for the LLM (freshest,
      // zero extra call) so Analyze raises bad_news on the spot.
      newsScore: scoreNews(news as NewsArticle[]).score,
    });
    const riskRow = await evaluateAndStore(conid, riskInputs, riskConfig, riskFlagAsofDate());

    // --- Contextual triggers (profit-taking zone) ------------------------
    const thresholdPct = prefs?.profitZoneThresholdPct ?? 2.0;
    const zoneEnteredAt = position?.zoneEnteredAt;
    const inZone = zoneEnteredAt != null;
    const inProfitTakingZone = inZone
      ? {
          thresholdPct,
          currentPnlPct: heldPnlPct ?? 0,
          viaGap: Boolean(position?.enteredZoneViaGap),
        }
      : null;

    const input: LlmAnalysisInput = {
      symbol: sym,
      companyName,
      conid,
      currentPrice,
      position: isHeld
        ? {
            shares: num(position?.shares) ?? 0,
            avgCost: num(position?.avgCost) ?? 0,
            unrealizedPnlPct: heldPnlPct,
          }
        : null,
      featurePack,
      news,
      earnings,
      insider,
      contextualTriggers: {
        inProfitTakingZone,
        riskFlags: riskRow ? { severity: riskRow.severity, flags: riskRow.flags } : null,
      },
    };

    // --- LLM (one call counts once; retry once on malformed) -------------
    await incrLlmCallsToday();
    const provider = await activeLlm();
    let output: LlmAnalysisOutput;
    try {
      output = await provider.analyze(input, { direction });
    } catch (first) {
      // Only a malformed body is worth re-prompting. A rate-limit / outage /
      // bad-key won't be fixed by asking again, so fail soft immediately with
      // an honest reason instead of mislabeling it "malformed".
      const kind = first instanceof LlmError ? first.kind : 'malformed';
      if (kind !== 'malformed') {
        void notifyError('signalEngine.llm', `LLM ${kind} for ${sym}: ${(first as Error).message}`, first);
        await persistNoSignal(userId, sym, conid, NON_MALFORMED_REASON[kind], featurePack);
        return;
      }
      try {
        output = await provider.analyze(input, { direction, strict: true });
      } catch (second) {
        void notifyError(
          'signalEngine.llm',
          `LLM malformed for ${sym} after retry: ${(second as Error).message}`,
          second,
        );
        await persistNoSignal(userId, sym, conid, 'LLM response malformed', featurePack);
        return;
      }
    }

    // CRITICAL risk flags hard-cap the headline quality regardless of the
    // model's number — a momentum pump can't emit a high-confidence BUY (spec:
    // playbook.md → Risk-flag context + confidence cap).
    if (riskRow?.severity === 'critical' && output.signal) {
      output.signal.signalQuality = Math.min(output.signal.signalQuality, CRITICAL_QUALITY_CAP);
    }
    await persistAnalysis(userId, sym, conid, featurePack, output);
  } catch (err) {
    void notifyError('signalEngine.run', `${sym}: ${(err as Error).message}`, err);
  } finally {
    await analysisLocksTableModule.deleteById(lockId).catch(() => undefined);
  }
}

// Maps leg[0] (a single price + condition) onto the legacy range columns so the
// deferred range-notifications + accuracy tracking keep working against the
// immediate action. The band is half-ATR (falls back to 1% of price), placed
// per the condition: at_or_above → [price, price+band]; at_or_below →
// [price-band, price]; about → centred.
function legToRange(
  leg: PlaybookLeg,
  featurePack: FeaturePack,
): { low: number; high: number; optimal: number } {
  // Round to 4 dp so band arithmetic (price ± atr/2) can't leak float noise
  // like 4.1450000000000005 into the persisted columns.
  const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
  const price = leg.price;
  const atr = featurePack.volatility.atr14;
  const band = atr != null && atr > 0 ? atr / 2 : Math.abs(price) * 0.01;
  const optimal = round4(price);
  if (leg.condition === 'at_or_above') return { low: optimal, high: round4(price + band), optimal };
  if (leg.condition === 'at_or_below') return { low: round4(price - band), high: optimal, optimal };
  return { low: round4(price - band), high: round4(price + band), optimal };
}

// Inserts the analyses row, supersedes prior signals, inserts the one new
// signal row (or a no_signal row when the playbook is null).
async function persistAnalysis(
  userId: string,
  sym: string,
  conid: number | null,
  featurePack: FeaturePack,
  output: LlmAnalysisOutput,
): Promise<void> {
  const db = supabase();
  const analyzedAt = new Date().toISOString();
  const sig = output.signal;

  // Horizon-driven expiry: intraday → end of today's regular session; multiday
  // → analyzed_at + parsed window; no_signal → default horizon.
  const expiresAt = !sig
    ? isoPlusDays(analyzedAt, DEFAULT_EXPIRY_DAYS)
    : sig.horizon === 'intraday'
      ? endOfRegularSessionEtIso(new Date(analyzedAt))
      : isoPlusDays(analyzedAt, windowDays(sig.horizonWindow));

  let analysisId: string;
  try {
    analysisId = await analysesTableModule.insertAnalysis({
      userId,
      symbol: sym,
      conid,
      indicatorSnapshot: { values: featurePack, readings: output.indicatorAnalysis },
      reasoning: output.reasoning,
      analyzedAt,
      expiresAt,
    });
  } catch (e) {
    void notifyError('signalEngine.persist', `insert analyses failed for ${sym}: ${(e as Error).message}`);
    return;
  }

  // Whole-analysis supersede: every prior non-superseded signal for this
  // (user, symbol) points at the new analysis. Runs before inserting the new
  // row so it can't supersede itself.
  await db
    .from('signals')
    .update({ superseded_by_analysis_id: analysisId })
    .eq('user_id', userId)
    .eq('symbol', sym)
    .is('superseded_by_analysis_id', null);

  let row: Record<string, unknown>;
  if (sig && sig.legs.length > 0) {
    const leg0 = sig.legs[0]!;
    const range = legToRange(leg0, featurePack);
    row = {
      user_id: userId,
      symbol: sym,
      conid,
      analysis_id: analysisId,
      signal_type: sig.direction,
      signal_quality: Math.round(sig.signalQuality),
      price_range_low: range.low,
      price_range_high: range.high,
      optimal_price: range.optimal,
      motivation: sig.motivation,
      rationale: leg0.reasoning,
      playbook: {
        direction: sig.direction,
        signalQuality: Math.round(sig.signalQuality),
        motivation: sig.motivation,
        horizon: sig.horizon,
        horizonWindow: sig.horizonWindow,
        legs: sig.legs,
      },
      analyzed_at: analyzedAt,
      expires_at: expiresAt,
    };
  } else {
    row = {
      user_id: userId,
      symbol: sym,
      conid,
      analysis_id: analysisId,
      signal_type: 'no_signal',
      signal_quality: 0,
      analyzed_at: analyzedAt,
      expires_at: expiresAt,
    };
  }

  const { error: sErr } = await db.from('signals').insert(row);
  if (sErr) void notifyError('signalEngine.persist', `insert signal failed for ${sym}: ${sErr.message}`);
}

// Writes a single no_signal row (unresolved contract / LLM failure) so the
// failure is visible in history rather than silently swallowed.
async function persistNoSignal(
  userId: string,
  sym: string,
  conid: number | null,
  reasoning: string,
  featurePack: FeaturePack | Record<string, never>,
): Promise<void> {
  await persistAnalysis(userId, sym, conid, featurePack as FeaturePack, {
    indicatorAnalysis: {},
    reasoning,
    signal: null,
  });
}
