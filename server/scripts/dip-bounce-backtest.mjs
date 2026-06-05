// Throwaway — see spec/signals/dip-bounce-scorer.md → Throwaway calibration. Do
// NOT extend; not maintained, not in the cron set. Rebuild calibration from
// forward-tracker (signal_fires + signal_outcomes) data after a month of real
// fires.
//
// Purpose: a rough sanity-check on the SWING scorer's fire rate before going
// live, so the v1 thresholds in server/src/config/dipBounceScorer.ts produce
// ~1-3 fires/day per channel rather than a flood or a silence.
//
// Honest limitation: the live scorers compose band_state.session_regime,
// vol_regime_shift, and entry_zones confluence — none of which are reconstructable
// from daily bars alone. This script approximates ONLY the bar-derivable swing
// components (daily trend via SMA50 slope, RSI(14) ≤ 40 pullback, ATR-proximity
// to a recent support) over a representative sample, and reports how often the
// approximation would fire. Treat the number as an order-of-magnitude check, not
// a true backtest. The intraday scorer is not approximated here (it's almost
// entirely band_state/entry_zones driven).
//
// Usage:  node server/scripts/dip-bounce-backtest.mjs

// Representative liquid mid/large caps + a couple of volatile names — stand-ins
// for a real curated list (which would come from the curated_list table).
const SAMPLE = ['AMD', 'PLTR', 'SOFI', 'RIVN', 'AFRM', 'COIN', 'UBER', 'SNAP', 'F', 'NIO'];

const LOOKBACK_SESSIONS = 60;
const RSI_PULLBACK_MAX = 40; // keep in sync with SWING_RSI_PULLBACK_MAX
const NEAR_SUPPORT_ATR_MULT = 1; // keep in sync with SWING_NEAR_ZONE_ATR_MULT

async function fetchDaily(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (dip-bounce-backtest)' } });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0] ?? {};
  return ts
    .map((t, i) => ({ h: q.high?.[i], l: q.low?.[i], c: q.close?.[i] }))
    .filter((b) => Number.isFinite(b.c) && Number.isFinite(b.h) && Number.isFinite(b.l));
}

function rsi14(closes) {
  if (closes.length < 15) return null;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = gain / 14 / (loss / 14);
  return 100 - 100 / (1 + rs);
}

function atr14(bars) {
  if (bars.length < 15) return null;
  let sum = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c),
    );
    sum += tr;
  }
  return sum / 14;
}

function sma(closes, period) {
  if (closes.length < period) return null;
  let s = 0;
  for (let i = closes.length - period; i < closes.length; i++) s += closes[i];
  return s / period;
}

// Approximated swing fire over each session window.
function analyse(symbol, bars) {
  let fires = 0;
  let evaluated = 0;
  for (let end = bars.length - LOOKBACK_SESSIONS; end < bars.length; end++) {
    if (end < 60) continue;
    const window = bars.slice(0, end + 1);
    const closes = window.map((b) => b.c);
    const price = closes[closes.length - 1];
    const rsi = rsi14(closes);
    const a = atr14(window);
    const sma50 = sma(closes, 50);
    const sma50Prior = sma(closes.slice(0, -5), 50);
    if (rsi == null || a == null || sma50 == null || sma50Prior == null) continue;
    evaluated++;
    const trendUp = sma50 >= sma50Prior; // proxy for {up, mixed}
    const pullback = rsi <= RSI_PULLBACK_MAX;
    // "near support": within N·ATR of the recent 20-session low.
    const recentLow = Math.min(...window.slice(-20).map((b) => b.l));
    const nearSupport = Math.abs(price - recentLow) <= NEAR_SUPPORT_ATR_MULT * a;
    if (trendUp && pullback && nearSupport) fires++;
  }
  const perDay = evaluated > 0 ? fires / evaluated : 0;
  return { symbol, fires, evaluated, perDay };
}

async function main() {
  console.log(
    `Approx SWING fire rate over last ${LOOKBACK_SESSIONS} sessions ` +
      `(trend-up ∧ RSI≤${RSI_PULLBACK_MAX} ∧ within ${NEAR_SUPPORT_ATR_MULT}·ATR of 20d low)\n`,
  );
  let totalFires = 0;
  let totalDays = 0;
  for (const s of SAMPLE) {
    try {
      const bars = await fetchDaily(s);
      const r = analyse(s, bars);
      totalFires += r.fires;
      totalDays = Math.max(totalDays, r.evaluated);
      console.log(
        `${s.padEnd(6)} fires=${String(r.fires).padStart(3)} / ${String(r.evaluated).padStart(3)} sessions ` +
          `(${(r.perDay * 100).toFixed(0)}% of sessions)`,
      );
    } catch (e) {
      console.log(`${s.padEnd(6)} error: ${e.message}`);
    }
  }
  const firesPerDayAcrossSample = totalDays > 0 ? totalFires / totalDays : 0;
  console.log(
    `\nAcross ${SAMPLE.length} names: ~${firesPerDayAcrossSample.toFixed(1)} approx swing fires/day.` +
      `\nTarget 1-3/day combined across both channels — adjust SWING_* constants if wildly off.` +
      `\n(Reminder: approximation only; real calibration comes from signal_outcomes.)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
