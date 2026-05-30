#!/usr/bin/env node
// Retroactive band validation for the screener vision.
//
// For each ticker, load the IB-passthrough 60-day history capture and run it
// through computeIntradayStats. Report typical_intraday_low percentiles +
// what the predicted-low band would have been on 2026-05-29's open vs the
// prices the user actually bought at.
//
// NOTE: IB returned 1h bars when asked for 5-min over a 2-month period (IB
// API caps 5-min bars at ~1w window). The intraday_low math doesn't care
// about bar resolution — `sessionLow = min over all session bars` is valid
// at any granularity. Open/close fade math IS sensitive; we ignore those
// outputs for this validation.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const TICKERS = [
  {
    symbol: 'MNTS',
    conid: 839174082,
    capture: 'captures/iserver/marketdata/history/bar=5mins&conid=839174082&period=2m/latest.json',
    trades: [
      { buy: 16.70, sell: 17.20 },
      { buy: 16.90, sell: 17.20 },
      { buy: 17.00, sell: 17.30 },
    ],
  },
  {
    symbol: 'RGTI',
    conid: 547605251,
    capture: 'captures/iserver/marketdata/history/bar=5mins&conid=547605251&period=2m/latest.json',
    trades: [
      { buy: 25.00, sell: 25.20 },
    ],
  },
];

// computeIntradayStats is a TS module; we can't `import` it directly from
// pure JS without a build step. Re-implement the intraday_low_pct portion
// inline (the only stat we need for this validation, given hourly bars).
//
// Logic mirrors server/src/services/intradayStats.ts → intradayLows[].

const ET_TZ = 'America/New_York';

function etDateKey(ts_ms) {
  const d = new Date(ts_ms);
  // YYYY-MM-DD in ET
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const dd = parts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${dd}`;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function mean(arr) {
  if (arr.length === 0) return null;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function pct(a, base) {
  return ((base - a) / base) * 100; // positive = a < base (low below open)
}

function analyze(symbol, bars, openOf29) {
  // Group by ET session date
  const sessions = new Map();
  for (const b of bars) {
    const key = etDateKey(b.t);
    let s = sessions.get(key);
    if (!s) {
      s = { open: b.o, low: b.l, high: b.h, close: b.c, bars: 0 };
      sessions.set(key, s);
    } else {
      s.low = Math.min(s.low, b.l);
      s.high = Math.max(s.high, b.h);
      s.close = b.c;
    }
    s.bars++;
  }

  const intradayLows = [];
  let session29 = null;
  for (const [date, s] of sessions) {
    if (s.bars < 2) continue;
    intradayLows.push(pct(s.low, s.open));
    if (date === '2026-05-29') session29 = { date, ...s };
  }

  const sorted = [...intradayLows].sort((a, b) => a - b);

  return {
    session_count: intradayLows.length,
    p25: percentile(sorted, 0.25),
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    mean: mean(intradayLows),
    session_29: session29,
  };
}

// ---- main ----

console.log('=== Retroactive Band Validation ===\n');

for (const t of TICKERS) {
  const data = JSON.parse(readFileSync(t.capture, 'utf8'));
  const bars = data.data || [];

  // Find 2026-05-29's open from the bar data
  const may29bars = bars.filter((b) => etDateKey(b.t) === '2026-05-29');
  const open29 = may29bars[0]?.o;
  const low29 = may29bars.reduce((m, b) => Math.min(m, b.l), may29bars[0]?.l ?? Infinity);

  const stats = analyze(t.symbol, bars, open29);

  console.log(`${t.symbol}  (conid ${t.conid})`);
  console.log(`  history: ${bars.length} bars across ${stats.session_count} sessions, barLength=${data.barLength}s`);

  if (stats.p50 == null) {
    console.log('  insufficient data');
    console.log('');
    continue;
  }

  console.log(`  typical intraday_low_pct (open → session low):`);
  console.log(`    p25  ${stats.p25.toFixed(2)}%   (shallow dips)`);
  console.log(`    p50  ${stats.p50.toFixed(2)}%   (median dip)`);
  console.log(`    p75  ${stats.p75.toFixed(2)}%   (deep dips)`);
  console.log(`    mean ${stats.mean.toFixed(2)}%`);
  console.log('');

  if (open29 != null && Number.isFinite(low29)) {
    const realizedFade = pct(low29, open29);
    console.log(`  2026-05-29 actual:`);
    console.log(`    open  $${open29.toFixed(2)}`);
    console.log(`    low   $${low29.toFixed(2)}   (realized fade ${realizedFade.toFixed(2)}%)`);

    const bandP50 = open29 * (1 - stats.p50 / 100);
    const bandP25 = open29 * (1 - stats.p25 / 100);
    const bandP75 = open29 * (1 - stats.p75 / 100);
    console.log(`  predicted-low bands from 60d history × today's open:`);
    console.log(`    p25  $${bandP25.toFixed(2)}   (shallow dip → safe buy zone)`);
    console.log(`    p50  $${bandP50.toFixed(2)}   (median dip → primary buy zone)`);
    console.log(`    p75  $${bandP75.toFixed(2)}   (deep dip → "wait for this if patient")`);

    console.log(`  user's actual buys on 2026-05-29:`);
    for (const trade of t.trades) {
      const distFromP50 = trade.buy - bandP50;
      const distAbsPct = Math.abs(distFromP50 / trade.buy) * 100;
      const inEnvelope = trade.buy >= bandP75 && trade.buy <= bandP25;
      console.log(
        `    buy $${trade.buy.toFixed(2)}  →  ${distFromP50 >= 0 ? '+' : ''}${distFromP50.toFixed(2)} ` +
          `vs p50 (${distAbsPct.toFixed(1)}% off) · ${inEnvelope ? 'inside p25–p75 envelope ✓' : 'outside envelope'}`,
      );
    }
  } else {
    console.log('  2026-05-29 not in bar data (window may not extend that far)');
  }
  console.log('');
}
