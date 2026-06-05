// Throwaway — see spec/signals/risk-flags.md → Calibration. Do NOT extend; not
// maintained, not in the cron set. Run once to seed the v1 price_surge defaults
// by retro-validating against the SPCE / RGTI / MNTS dangerous-peak cases vs a
// clean-breakout sample, then discard.
//
// Usage:  node server/scripts/risk-flags-calibrate.mjs
//
// Fetches ~1y of daily bars from Yahoo's keyless v8/chart endpoint, scans every
// session's trailing-N return + RSI, and reports the MAX surge + how many days
// each name would have raised `price_surge` at the seed threshold. The pumps
// should light up; the clean names should stay quiet. Tune SURGE_PCT / WINDOW
// until that separation holds, then copy into server/src/config/riskFlags.ts.

const PUMPS = ['SPCE', 'RGTI', 'MNTS'];
const CLEAN = ['AAPL', 'MSFT', 'KO'];

// Keep in sync with RISK_FLAG_DEFAULTS by hand (throwaway — no import on purpose).
const SURGE_PCT = 25;
const WINDOW = 5;
const RSI_Z = 78;

async function fetchDaily(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (risk-flags-calibrate)' } });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const closes = r?.indicators?.quote?.[0]?.close ?? [];
  return ts
    .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
    .filter((b) => Number.isFinite(b.close));
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

async function analyse(symbol) {
  const bars = await fetchDaily(symbol);
  const closes = bars.map((b) => b.close);
  let fires = 0;
  let maxSurge = -Infinity;
  let peakDate = null;
  for (let i = WINDOW; i < bars.length; i++) {
    const past = closes[i - WINDOW];
    if (!(past > 0)) continue;
    const surge = ((closes[i] - past) / past) * 100;
    if (surge >= SURGE_PCT) fires++;
    if (surge > maxSurge) {
      maxSurge = surge;
      peakDate = bars[i].date;
    }
  }
  return { symbol, fires, maxSurge, peakDate, lastRsi: rsi14(closes) };
}

async function main() {
  console.log(`thresholds: surge ≥ ${SURGE_PCT}% over ${WINDOW} sessions · rsi_overbought > ${RSI_Z}\n`);
  for (const [label, syms] of [
    ['PUMPS (should fire)', PUMPS],
    ['CLEAN (should stay quiet)', CLEAN],
  ]) {
    console.log(`== ${label} ==`);
    for (const s of syms) {
      try {
        const r = await analyse(s);
        console.log(
          `${s.padEnd(6)} surge-days=${String(r.fires).padStart(3)}  ` +
            `maxSurge=${r.maxSurge.toFixed(1).padStart(6)}% @ ${r.peakDate}  ` +
            `lastRSI=${r.lastRsi == null ? 'n/a' : r.lastRsi.toFixed(0)}`,
        );
      } catch (e) {
        console.log(`${s.padEnd(6)} error: ${e.message}`);
      }
    }
    console.log('');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
