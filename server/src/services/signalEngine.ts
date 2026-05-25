// Signal engine (Batch 14a) — orchestrates a single unified analysis.
//
// Pulls IB price/history + Finnhub context, computes indicators, asks the LLM
// for a unified SELL+BUY read, then persists one `analyses` row plus 1-2
// `signals` rows and supersedes any prior analysis for the same (user, symbol).
//
// Designed to run fire-and-forget from the route: it never throws to the
// caller and always releases the `analysis_locks` row in `finally`. Failures
// fail soft — a malformed LLM response (after one stricter retry) is persisted
// as a `no_signal` row rather than crashing the api.

import { supabase } from './supabase.js';
import { notifyError } from './notify.js';
import { ibSnapshot, ibHistory, ibContractInfo, ibSecdefSearch } from './ibGateway.js';
import { companyNews, earningsCalendar, insiderTransactions } from './finnhub.js';
import { rsi, macd, bollinger, vwap } from './technicals.js';
import { incrLlmCallsToday } from './redis.js';
import { llm, type LlmAnalysisInput, type LlmAnalysisOutput } from './llm.js';

const DEFAULT_EXPIRY_DAYS = 7;

interface RunOpts {
  userId: string;
  symbol: string;
  lockId: string;
}

// Pulls the largest day-count out of a free-text timeframe ("3-7 days" → 7),
// falling back to the default horizon.
function timeframeDays(timeframe: string | undefined): number {
  if (!timeframe) return DEFAULT_EXPIRY_DAYS;
  const nums = timeframe.match(/\d+/g)?.map(Number) ?? [];
  const max = nums.length ? Math.max(...nums) : DEFAULT_EXPIRY_DAYS;
  return max > 0 ? max : DEFAULT_EXPIRY_DAYS;
}

function isoPlusDays(fromIso: string, days: number): string {
  return new Date(new Date(fromIso).getTime() + days * 86_400_000).toISOString();
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

export async function runAnalysis(opts: RunOpts): Promise<void> {
  const { userId, lockId } = opts;
  const sym = opts.symbol.toUpperCase();
  const db = supabase();

  try {
    // --- Position + preferences ------------------------------------------
    const { data: position } = await db
      .from('positions')
      .select('*')
      .eq('user_id', userId)
      .eq('symbol', sym)
      .maybeSingle();

    const { data: prefs } = await db
      .from('user_preferences')
      .select('signal_min_market_value, suppressed_symbols, profit_zone_threshold_pct')
      .eq('user_id', userId)
      .maybeSingle();

    // --- Pre-LLM filters (skip entirely) ---------------------------------
    if ((prefs?.suppressed_symbols ?? []).includes(sym)) {
      console.log(`[signalEngine] ${sym} suppressed — skipping`);
      return;
    }
    if (position) {
      const minMktValue = Number(prefs?.signal_min_market_value ?? 1000);
      const mktValue =
        num(position.market_value) ??
        (num(position.shares) ?? 0) * (num(position.current_price) ?? 0);
      if (mktValue < minMktValue) {
        console.log(`[signalEngine] ${sym} held value ${mktValue} < ${minMktValue} — skipping`);
        return;
      }
    }

    // --- Resolve conid + company name ------------------------------------
    let conid: number | null = position?.conid != null ? Number(position.conid) : null;
    let companyName: string | null = position?.company_name ?? null;
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

    // --- IB history → indicators -----------------------------------------
    const daily = await ibHistory(conid, '1y', '1d');
    const intraday = await ibHistory(conid, '1d', '5min');
    const dailyCloses = (daily?.data ?? []).map((b) => b.c);
    const indicatorSnapshot: Record<string, unknown> = {
      rsi14: rsi(dailyCloses),
      macd: macd(dailyCloses),
      bollinger: bollinger(dailyCloses),
      vwap: intraday
        ? vwap(
            intraday.data.map((b) => b.h),
            intraday.data.map((b) => b.l),
            intraday.data.map((b) => b.c),
            intraday.data.map((b) => b.v),
          )
        : null,
      lastClose: dailyCloses.length ? dailyCloses[dailyCloses.length - 1] : null,
      dailyBars: dailyCloses.length,
    };

    // --- Current price (IB snapshot, fall back to stored price) ----------
    let currentPrice: number | null = num(position?.current_price);
    const snap = await ibSnapshot([conid]).catch(() => []);
    const live = num(snap[0]?.['31']);
    if (live != null) currentPrice = live;

    // --- Finnhub context (each source isolated) --------------------------
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
    const [news, earnings, insider] = await Promise.all([
      companyNews(sym, from, to).catch(() => [] as unknown[]),
      earningsCalendar(sym).catch(() => null),
      insiderTransactions(sym).catch(() => null),
    ]);

    // --- Contextual triggers (profit-taking zone fields land in 14c) -----
    // `position` is selected with `*`, so pre-14c the zone columns are simply
    // absent → inZone is false. Null-safe by construction.
    const thresholdPct = Number(prefs?.profit_zone_threshold_pct ?? 2.0);
    const zoneEnteredAt = (position as Record<string, unknown> | null)?.['zone_entered_at'];
    const inZone = zoneEnteredAt != null;
    const inProfitTakingZone = inZone
      ? {
          thresholdPct,
          currentPnlPct: num(position?.unrealized_pnl_pct) ?? 0,
          viaGap: Boolean((position as Record<string, unknown>)?.['entered_zone_via_gap']),
        }
      : null;

    const input: LlmAnalysisInput = {
      symbol: sym,
      companyName,
      conid,
      currentPrice,
      position: position
        ? {
            shares: num(position.shares) ?? 0,
            avgCost: num(position.avg_cost) ?? 0,
            unrealizedPnlPct: num(position.unrealized_pnl_pct),
          }
        : null,
      indicatorSnapshot,
      news,
      earnings,
      insider,
      contextualTriggers: { inProfitTakingZone },
    };

    // --- LLM (one unified call counts once; retry once on malformed) -----
    await incrLlmCallsToday();
    const provider = llm();
    let output: LlmAnalysisOutput;
    try {
      output = await provider.analyze(input);
    } catch (first) {
      try {
        output = await provider.analyze(input, { strict: true });
      } catch (second) {
        void notifyError(
          'signalEngine.llm',
          `LLM malformed for ${sym} after retry: ${(second as Error).message}`,
        );
        await persistNoSignal(userId, sym, conid, 'LLM response malformed', indicatorSnapshot);
        return;
      }
    }

    await persistAnalysis(userId, sym, conid, indicatorSnapshot, output);
  } catch (err) {
    void notifyError('signalEngine.run', `${sym}: ${(err as Error).message}`, err);
  } finally {
    await supabase().from('analysis_locks').delete().eq('id', lockId);
  }
}

// Inserts the analyses row, supersedes prior signals, inserts new signal rows.
async function persistAnalysis(
  userId: string,
  sym: string,
  conid: number | null,
  indicatorSnapshot: Record<string, unknown>,
  output: LlmAnalysisOutput,
): Promise<void> {
  const db = supabase();
  const analyzedAt = new Date().toISOString();

  const sellDays = output.sellSignal ? timeframeDays(output.sellSignal.timeframe) : 0;
  const buyDays = output.buySignal ? timeframeDays(output.buySignal.timeframe) : 0;
  const maxDays = Math.max(sellDays, buyDays, output.sellSignal || output.buySignal ? 0 : DEFAULT_EXPIRY_DAYS);
  const analysisExpiresAt = isoPlusDays(analyzedAt, maxDays || DEFAULT_EXPIRY_DAYS);

  const { data: analysisRow, error: aErr } = await db
    .from('analyses')
    .insert({
      user_id: userId,
      symbol: sym,
      conid,
      indicator_snapshot: { values: indicatorSnapshot, readings: output.indicatorAnalysis },
      reasoning: output.reasoning,
      analyzed_at: analyzedAt,
      expires_at: analysisExpiresAt,
    })
    .select('analysis_id')
    .single();
  if (aErr || !analysisRow) {
    void notifyError('signalEngine.persist', `insert analyses failed for ${sym}: ${aErr?.message}`);
    return;
  }
  const analysisId = analysisRow.analysis_id;

  // Whole-analysis supersede: every prior non-superseded signal for this
  // (user, symbol) points at the new analysis. Runs before inserting the new
  // rows so it can't supersede them.
  await db
    .from('signals')
    .update({ superseded_by_analysis_id: analysisId })
    .eq('user_id', userId)
    .eq('symbol', sym)
    .is('superseded_by_analysis_id', null);

  const rows: Record<string, unknown>[] = [];
  if (output.sellSignal) {
    const s = output.sellSignal;
    rows.push({
      user_id: userId,
      symbol: sym,
      conid,
      analysis_id: analysisId,
      signal_type: 'sell',
      signal_quality: Math.round(s.signalQuality),
      price_range_low: s.priceRangeLow,
      price_range_high: s.priceRangeHigh,
      optimal_price: s.optimalPrice,
      motivation: s.motivation,
      rationale: s.rationale,
      analyzed_at: analyzedAt,
      expires_at: isoPlusDays(analyzedAt, sellDays),
    });
  }
  if (output.buySignal) {
    const b = output.buySignal;
    rows.push({
      user_id: userId,
      symbol: sym,
      conid,
      analysis_id: analysisId,
      signal_type: 'buy',
      signal_quality: Math.round(b.signalQuality),
      price_range_low: b.priceRangeLow,
      price_range_high: b.priceRangeHigh,
      optimal_price: b.optimalPrice,
      motivation: b.motivation,
      rationale: b.rationale,
      analyzed_at: analyzedAt,
      expires_at: isoPlusDays(analyzedAt, buyDays),
    });
  }
  if (rows.length === 0) {
    rows.push({
      user_id: userId,
      symbol: sym,
      conid,
      analysis_id: analysisId,
      signal_type: 'no_signal',
      signal_quality: 0,
      analyzed_at: analyzedAt,
      expires_at: analysisExpiresAt,
    });
  }

  const { error: sErr } = await db.from('signals').insert(rows);
  if (sErr) void notifyError('signalEngine.persist', `insert signals failed for ${sym}: ${sErr.message}`);
}

// Writes a single no_signal row (unresolved contract / malformed LLM) so the
// failure is visible in history rather than silently swallowed.
async function persistNoSignal(
  userId: string,
  sym: string,
  conid: number | null,
  reasoning: string,
  indicatorSnapshot: Record<string, unknown>,
): Promise<void> {
  await persistAnalysis(userId, sym, conid, indicatorSnapshot, {
    indicatorAnalysis: {},
    reasoning,
    sellSignal: null,
    buySignal: null,
  });
}
