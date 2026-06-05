// bandEngineCron — Batch S3.
//
// Five-minute cadence during regular session + after-hours (16:30 IDT –
// 03:00 IDT ≈ 09:30 ET – 20:00 ET). On each tick, walks the curated list
// (today's `intraday_range_trader` survivors), pulls today's 5-min bars,
// computes the three adaptive band layers, persists `band_state`, and fires
// Discord band-touch pings (4h cooldown) when the published low/high band
// is crossed for the first time in the window.
//
// Layer 1 (sessionRegime classifier) fires once per ticker per session — on
// the first tick after 16:45 IDT (15 min after regular open) when the
// band_state row for today still has session_regime = null. After-hours
// ticks override the label to 'ah_low_confidence' (per spec).
//
// Layer 2 (volScalar) recomputes every tick. v1 simplification: the 30d
// baseline ATR is approximated from `intraday_stats.intraday_low_pct_p50` —
// converted to price-space (open × p50 / 100). Sharpening to a true 30d ATR
// is a Track-10 follow-up (band-engine.md → Fade-pct sourcing note).
//
// Layer 3 (walkingState) ticks the state machine with the latest 5-min bar
// close. Seed on first tick of session_date when no band_state row exists.
//
// Spec: spec/signals/band-engine.md.

import { ibHistory, ibStatus } from '../services/ibGateway.js';
import { supabase } from '../services/supabase.js';
import {
  notifyError,
  notifyBandTouchLow,
  notifyBandTouchHigh,
} from '../services/notify.js';
import { marketPeriodAt, etDateString } from '../utils/marketHours.js';
import { loadComputeSet } from '../services/dipBounce/computeSet.js';
import { classifySessionRegime, type SessionRegime } from '../services/bandEngine/sessionRegime.js';
import { atr, computeVolScalar } from '../services/bandEngine/volScalar.js';
import { computeVolRegimeShift, type SessionBar } from '../services/bandEngine/volRegimeShift.js';
import {
  seedBandWalkState,
  tickBandWalk,
  type BandWalkState,
  type AnchorEvent,
} from '../services/bandEngine/walkingState.js';
import type { RawIbHistoryBar } from '../types/index.js';

const CADENCE_MS = 5 * 60_000;
const FIRST_RUN_DELAY_MS = 7 * 60_000;       // 7 min — lands after intradayStatsCron's first tick
const COOLDOWN_HOURS = 4;
const REVERSAL_THRESHOLD_K = 0.5;
const VOL_SCALAR_BARS = 12;                  // last 12 5-min bars (~1 hour)

interface CuratedRow {
  conid: number;
  symbol: string;
  todayOpen: number | null;
  yesterdayClose: number | null;
  premktVolRatio: number | null;
  bars: RawIbHistoryBar[];
  recentBars: RawIbHistoryBar[];
  /** Aggregated daily bars from the 30d window (for vol_regime_shift). */
  dailyBars: SessionBar[];
  /** Intraday-stats baseline values. */
  intradayLowPctP50: number | null;
  isHeld: boolean;
}

interface BandStateRow {
  conid: number;
  session_date: string;
  anchors: AnchorEvent[];
  current_low_band: number | null;
  current_high_band: number | null;
  session_regime: SessionRegime | 'ah_low_confidence' | null;
  vol_scalar: number | null;
  vol_regime_shift: boolean;
  band_touch_last_fired_at: Record<string, string | null>;
  updated_at: string;
  /** In-memory state machine carried alongside the persisted columns. */
  walk: BandWalkState;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function etDateOf(tsMs: number): string {
  return etDateString(new Date(tsMs));
}

/**
 * Aggregate intraday 5-min bars into one row per ET session date — used by
 * volRegimeShift (which compares the last 5 sessions' ATR to the prior 30).
 */
function aggregateToDailyBars(bars: RawIbHistoryBar[]): SessionBar[] {
  const bySession = new Map<string, RawIbHistoryBar[]>();
  for (const b of bars) {
    const key = etDateOf(b.t);
    const arr = bySession.get(key);
    if (arr) arr.push(b);
    else bySession.set(key, [b]);
  }
  return Array.from(bySession.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => {
      const h = list.reduce((m, b) => Math.max(m, b.h), -Infinity);
      const l = list.reduce((m, b) => Math.min(m, b.l), Infinity);
      const c = list[list.length - 1]?.c ?? 0;
      return { date, h, l, c };
    });
}

async function loadIntradayStatsFor(conids: number[]): Promise<Map<number, { p50: number | null }>> {
  const out = new Map<number, { p50: number | null }>();
  for (let i = 0; i < conids.length; i += 900) {
    const chunk = conids.slice(i, i + 900);
    const { data, error } = await supabase()
      .from('intraday_stats')
      .select('conid, intraday_low_pct_p50')
      .in('conid', chunk);
    if (error) {
      void notifyError('bandEngineCron.loadStats', error.message);
      continue;
    }
    for (const r of (data ?? []) as Array<{ conid: number; intraday_low_pct_p50: number | string | null }>) {
      out.set(r.conid, { p50: num(r.intraday_low_pct_p50) });
    }
  }
  return out;
}

async function loadBandStateFor(conids: number[], sessionDate: string): Promise<Map<number, BandStateRow>> {
  const out = new Map<number, BandStateRow>();
  for (let i = 0; i < conids.length; i += 900) {
    const chunk = conids.slice(i, i + 900);
    const { data, error } = await supabase()
      .from('band_state')
      .select('*')
      .eq('session_date', sessionDate)
      .in('conid', chunk);
    if (error) {
      void notifyError('bandEngineCron.loadState', error.message);
      continue;
    }
    for (const r of (data ?? []) as Array<{
      conid: number;
      session_date: string;
      anchors: AnchorEvent[];
      current_low_band: number | string | null;
      current_high_band: number | string | null;
      session_regime: SessionRegime | 'ah_low_confidence' | null;
      vol_scalar: number | string | null;
      vol_regime_shift: boolean;
      band_touch_last_fired_at: Record<string, string | null> | null;
      updated_at: string;
    }>) {
      // Reconstruct the walk state from persisted anchors + bands. We don't
      // round-trip running_max/running_min through the DB — the cron is the
      // sole writer and the next tick recomputes them by replaying anchors
      // against the latest bar. For v1 we approximate by treating the most
      // recent anchor's price as the running extremum on the *opposite* side
      // and the current price (later applied) as the active side.
      const anchors = (r.anchors ?? []) as AnchorEvent[];
      const lastAnchor = anchors[anchors.length - 1];
      const lastLow = [...anchors].reverse().find((a) => a.kind === 'low')?.price;
      const lastHigh = [...anchors].reverse().find((a) => a.kind === 'high')?.price;
      const seedLow = num(lastLow) ?? num(r.current_low_band) ?? 0;
      const seedHigh = num(lastHigh) ?? num(r.current_high_band) ?? 0;
      const walk: BandWalkState = {
        anchor_low: seedLow,
        anchor_high: seedHigh,
        running_max: seedHigh,
        running_min: seedLow,
        leg_direction: lastAnchor ? (lastAnchor.kind === 'low' ? 'up' : 'down') : null,
        anchors,
        current_low_band: num(r.current_low_band),
        current_high_band: num(r.current_high_band),
      };
      out.set(r.conid, {
        conid: r.conid,
        session_date: r.session_date,
        anchors,
        current_low_band: num(r.current_low_band),
        current_high_band: num(r.current_high_band),
        session_regime: r.session_regime,
        vol_scalar: num(r.vol_scalar),
        vol_regime_shift: !!r.vol_regime_shift,
        band_touch_last_fired_at: r.band_touch_last_fired_at ?? {},
        updated_at: r.updated_at,
        walk,
      });
    }
  }
  return out;
}

function cooldownPassed(ts: string | null | undefined): boolean {
  if (!ts) return true;
  return Date.now() - new Date(ts).getTime() >= COOLDOWN_HOURS * 3600 * 1000;
}

/**
 * Detect a band-touch crossing on this tick. We define "touch" as:
 *   - low touch: prev tick's price was > current_low_band AND this tick's price ≤ current_low_band
 *   - high touch: prev tick's price was < current_high_band AND this tick's price ≥ current_high_band
 * The previous-tick price comes from the persisted band_state's `running_max`
 * / `running_min` which approximate the most recent observed extreme; first
 * tick after seed has no prev so no touch can fire.
 */
function detectBandTouch(args: {
  prevPrice: number | null;
  currentPrice: number;
  lowBand: number | null;
  highBand: number | null;
}): 'low' | 'high' | null {
  const { prevPrice, currentPrice, lowBand, highBand } = args;
  if (prevPrice == null) return null;
  if (lowBand != null && prevPrice > lowBand && currentPrice <= lowBand) return 'low';
  if (highBand != null && prevPrice < highBand && currentPrice >= highBand) return 'high';
  return null;
}

interface ProcessOneArgs {
  conid: number;
  symbol: string;
  isHeld: boolean;
  isRegular: boolean;
  sessionDate: string;
  curated: CuratedRow;
  state: BandStateRow | undefined;
  fireClassifier: boolean;
}

function deriveCuratedRow(
  conid: number,
  symbol: string,
  bars: RawIbHistoryBar[],
  isHeld: boolean,
  intradayLowPctP50: number | null,
): CuratedRow | null {
  if (bars.length === 0) return null;
  const today = etDateString();
  const todayBars = bars.filter((b) => etDateOf(b.t) === today);
  const todayOpen = todayBars[0]?.o ?? null;
  if (todayOpen == null) return null;

  // Yesterday's close = last bar before today (chronologically).
  const priorBars = bars.filter((b) => etDateOf(b.t) !== today);
  const yesterdayClose = priorBars.length > 0 ? priorBars[priorBars.length - 1]!.c : null;

  // Today's recent N bars for vol_scalar.
  const recent = todayBars.slice(-VOL_SCALAR_BARS);

  return {
    conid,
    symbol,
    todayOpen,
    yesterdayClose,
    premktVolRatio: null,    // not implemented v1 — classifier downgrades gracefully when null
    bars: todayBars,
    recentBars: recent,
    dailyBars: aggregateToDailyBars(bars),
    intradayLowPctP50,
    isHeld,
  };
}

async function processOne(args: ProcessOneArgs): Promise<void> {
  const { conid, symbol, isHeld, isRegular, sessionDate, curated, state, fireClassifier } = args;
  const todayOpen = curated.todayOpen;
  if (todayOpen == null) return;

  // 1. Walking state — seed or carry forward.
  let walk = state?.walk ?? seedBandWalkState(todayOpen);
  let prevLowBand = walk.current_low_band;
  let prevHighBand = walk.current_high_band;

  // 2. Latest price = last bar's close (the tick we're processing).
  const lastBar = curated.bars[curated.bars.length - 1];
  if (!lastBar) return;
  const currentPrice = lastBar.c;
  const currentTs = new Date(lastBar.t).toISOString();

  // 3. Layer 2: vol_scalar.
  // Baseline approximation: convert intraday_low_pct_p50 to price-space via
  // today_open × p50 / 100. Rough but captures cross-stock variation; spec'd
  // as v1 simplification.
  const baselineAtr = curated.intradayLowPctP50 != null
    ? (todayOpen * curated.intradayLowPctP50) / 100
    : null;
  const vs = computeVolScalar({ recentBars: curated.recentBars, baselineAtr });

  // 4. Layer 1: classifier — only on the once-per-session trigger tick.
  let regime: SessionRegime | 'ah_low_confidence' | null = state?.session_regime ?? null;
  if (fireClassifier && regime == null && curated.yesterdayClose != null) {
    const gapPct = ((todayOpen - curated.yesterdayClose) / curated.yesterdayClose) * 100;
    // First-15-min: bar at index 2 (0,1,2 = three bars of 5min = first 15 min). Defensive.
    const after15 = curated.bars[2]?.c ?? curated.bars[curated.bars.length - 1]?.c;
    const first15Pct = after15 != null ? ((after15 - todayOpen) / todayOpen) * 100 : 0;
    regime = classifySessionRegime({
      gapPct,
      first15Pct,
      premktVolRatio: curated.premktVolRatio,
    });
  }
  // After-hours overrides for low-confidence labeling per spec.
  if (!isRegular && regime != null && regime !== 'ah_low_confidence') {
    regime = 'ah_low_confidence';
  }

  // 5. Layer 3: tick the walking state machine.
  const atrToday = atr(curated.recentBars) ?? 0;
  const reversalThreshold = REVERSAL_THRESHOLD_K * atrToday;
  const upFadePct = curated.intradayLowPctP50 ?? 0;
  const downFadePct = curated.intradayLowPctP50 ?? 0;
  const tick = tickBandWalk({
    state: walk,
    price: currentPrice,
    ts: currentTs,
    reversalThreshold,
    upFadePct,
    downFadePct,
    volScalar: vs.scalar,
  });
  walk = tick.state;

  // 6. vol_regime_shift (daily flag — cheap to recompute each tick).
  const volRegimeShift = computeVolRegimeShift(curated.dailyBars);

  // 7. Band-touch detection — only when bands are published AND we have a
  // prior published band to compare against (otherwise no "crossing").
  const touch = detectBandTouch({
    prevPrice: prevLowBand != null || prevHighBand != null ? walk.running_max : null,
    // running_max is the last-seen high (used as prev when high-leg); running_min for low-leg.
    // Heuristic: pass the running-extremum as a proxy for prev observed price.
    currentPrice,
    lowBand: walk.current_low_band,
    highBand: walk.current_high_band,
  });
  const cooldowns = state?.band_touch_last_fired_at ?? {};
  let firedKind: 'low' | 'high' | null = null;
  if (touch === 'low' && !isHeld && cooldownPassed(cooldowns.low)) {
    try {
      await notifyBandTouchLow({
        symbol,
        currentPrice,
        lowBand: walk.current_low_band!,
        highBand: walk.current_high_band ?? walk.current_low_band!,
        sessionRegime: regime,
        volScalar: vs.scalar,
      });
      firedKind = 'low';
    } catch (e) {
      void notifyError(`bandEngineCron.notifyLow.${symbol}`, (e as Error).message, e);
    }
  } else if (touch === 'high' && isHeld && cooldownPassed(cooldowns.high)) {
    try {
      await notifyBandTouchHigh({
        symbol,
        currentPrice,
        lowBand: walk.current_low_band ?? walk.current_high_band!,
        highBand: walk.current_high_band!,
        sessionRegime: regime,
        volScalar: vs.scalar,
      });
      firedKind = 'high';
    } catch (e) {
      void notifyError(`bandEngineCron.notifyHigh.${symbol}`, (e as Error).message, e);
    }
  }

  // 8. Persist updated band_state.
  const newCooldowns = { ...cooldowns };
  if (firedKind) newCooldowns[firedKind] = new Date().toISOString();
  const { error } = await supabase()
    .from('band_state')
    .upsert({
      conid,
      session_date: sessionDate,
      anchors: walk.anchors,
      current_low_band: walk.current_low_band,
      current_high_band: walk.current_high_band,
      session_regime: regime,
      vol_scalar: vs.scalar,
      vol_regime_shift: volRegimeShift,
      band_touch_last_fired_at: newCooldowns,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'conid,session_date' });
  if (error) {
    void notifyError(`bandEngineCron.persist.${symbol}`, error.message);
  }
  // suppress unused-var lint without changing functional shape.
  void prevHighBand;
}

/**
 * Returns true on the tick that crosses the 15-min-after-open boundary if
 * the classifier hasn't fired yet today. Anchored on ET so DST + cron skew
 * don't drift the trigger.
 */
function shouldFireClassifier(now: Date = new Date()): boolean {
  // Regular open = 9:30 ET; classifier fires at 9:45 ET (15 min in).
  const period = marketPeriodAt(now);
  if (period !== 'regular') return false;
  // Use the same minutes-from-midnight ET arithmetic as marketPeriodAt.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const minutes = hh * 60 + mm;
  // Classifier window: any tick ≥ 9:45 ET. Per-conid gate (regime == null)
  // ensures we don't reclassify on every subsequent tick.
  return minutes >= 9 * 60 + 45;
}

async function tickAll(): Promise<void> {
  const period = marketPeriodAt();
  if (period !== 'regular' && period !== 'after-hours') return;

  const ibAuth = await ibStatus().catch(() => ({ authenticated: false, connected: false }));
  if (!ibAuth.authenticated || !ibAuth.connected) {
    // Bars come from IB. Skip silently; next tick will catch up.
    return;
  }

  const sessionDate = etDateString();
  const isRegular = period === 'regular';

  // Compute set widened (Batch X1): curated ∪ active-watchlist ∪ held, so every
  // ticker on a visible imported list gets a walking band, not just curated names.
  const asof = new Date().toISOString().slice(0, 10);
  const members = await loadComputeSet(asof);
  if (members.length === 0) {
    console.log('[bandEngineCron] no compute-set tickers; nothing to walk');
    return;
  }

  const statsByConid = await loadIntradayStatsFor(members.map((c) => c.conid));
  const stateByConid = await loadBandStateFor(members.map((c) => c.conid), sessionDate);
  const fireClassifier = shouldFireClassifier();

  let ok = 0;
  let fail = 0;
  for (const { conid, symbol, isHeld } of members) {
    try {
      // ~60d 5min bars give us today + yesterday close + 30d-aggregated history
      // for vol_regime_shift in one call. Same period as intradayStatsCron uses.
      const hist = await ibHistory(conid, '2m', '5mins');
      if (!hist?.data || hist.data.length === 0) {
        fail++;
        continue;
      }
      const stats = statsByConid.get(conid);
      const curated = deriveCuratedRow(conid, symbol, hist.data, isHeld, stats?.p50 ?? null);
      if (!curated) {
        fail++;
        continue;
      }
      await processOne({
        conid,
        symbol,
        isHeld,
        isRegular,
        sessionDate,
        curated,
        state: stateByConid.get(conid),
        fireClassifier,
      });
      ok++;
    } catch (e) {
      fail++;
      void notifyError(`bandEngineCron.${symbol}`, (e as Error).message, e);
    }
  }
  console.log(`[bandEngineCron] period=${period} members=${members.length} ok=${ok} fail=${fail}`);
}

export function startBandEngineCron(): void {
  console.log('[bandEngineCron] starting, 5-min cadence during regular + after-hours');
  const loop = async () => {
    try {
      await tickAll();
    } catch (e) {
      void notifyError('bandEngineCron.tick', (e as Error).message, e);
    }
    setTimeout(loop, CADENCE_MS).unref();
  };
  setTimeout(loop, FIRST_RUN_DELAY_MS).unref();
}
