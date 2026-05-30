#!/usr/bin/env node
// Universe survivor estimate for the intraday-scalping screener.
//
// Hits Finnhub /stock/symbol?exchange=US, filters by type (Common Stock + ADR)
// and MIC (XNAS + XNYS + XASE), then random-samples N symbols and queries
// /quote + /stock/profile2 to apply price ($1-100) + marketCap (>=$150M).
// Reports survivor count + Wilson 95% CI on extrapolated full-universe count,
// plus distributions by price and cap band. ~5 min wall-time at 1.1s/call.

import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    })
);
const KEY = env.FINNHUB_API_KEY;
if (!KEY) throw new Error('FINNHUB_API_KEY not in .env');

const SAMPLE_SIZE = 250;
const SLEEP_MS = 1100; // stay under Finnhub 60/min cap

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.status === 429) {
        await sleep(3000);
        continue;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      await sleep(1000);
    }
  }
  return null;
}

process.stderr.write('Pulling US symbol universe… ');
const all = await fetchJson(`https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${KEY}`);
if (!Array.isArray(all)) throw new Error('No symbol list returned');
process.stderr.write(`${all.length} total\n`);

const TYPES = new Set(['Common Stock', 'ADR']);
const MICS = new Set(['XNAS', 'XNYS', 'XASE']);
const pool = all.filter((s) => TYPES.has(s.type) && MICS.has(s.mic));
process.stderr.write(`After type + MIC filter: ${pool.length}\n`);

// Random sample without replacement
const shuffled = [...pool].sort(() => Math.random() - 0.5);
const sample = shuffled.slice(0, SAMPLE_SIZE);
process.stderr.write(`Sampling ${sample.length} (need ~${Math.round(SAMPLE_SIZE * 2 * SLEEP_MS / 60000)} min)…\n`);

const survivors = [];
const stats = {
  no_quote: 0,
  no_cap: 0,
  price_out_of_range: 0,
  cap_too_low: 0,
  passed: 0,
};

for (let i = 0; i < sample.length; i++) {
  const sym = sample[i].symbol;
  if (i % 10 === 0) process.stderr.write(`  ${i}/${sample.length}…\n`);

  const quote = await fetchJson(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${KEY}`);
  await sleep(SLEEP_MS);
  const profile = await fetchJson(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(sym)}&token=${KEY}`);
  await sleep(SLEEP_MS);

  const price = quote?.c;
  const capM = profile?.marketCapitalization; // Finnhub reports in millions

  if (!price || price === 0) {
    stats.no_quote++;
    continue;
  }
  if (price < 1 || price > 100) {
    stats.price_out_of_range++;
    continue;
  }
  if (capM == null) {
    stats.no_cap++;
    continue;
  }
  if (capM < 150) {
    stats.cap_too_low++;
    continue;
  }

  stats.passed++;
  survivors.push({
    sym,
    price,
    capM,
    name: profile.name,
    type: sample[i].type,
    mic: sample[i].mic,
  });
}

// Wilson 95% CI on survivor fraction
const n = sample.length;
const k = stats.passed;
const p = k / n;
const z = 1.96;
const denom = 1 + (z * z) / n;
const center = (p + (z * z) / (2 * n)) / denom;
const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
const loFrac = Math.max(0, center - margin);
const hiFrac = Math.min(1, center + margin);

const poolSize = pool.length;
const estLo = Math.round(loFrac * poolSize);
const estHi = Math.round(hiFrac * poolSize);
const estMid = Math.round(center * poolSize);

console.log('\n=== Universe Survivor Estimate ===');
console.log(`Pool (US + Common Stock/ADR + NYSE+NASDAQ+AMEX): ${poolSize}`);
console.log(`Sample size: ${n}`);
console.log(`Sample survivors: ${k}  (${(p * 100).toFixed(1)}%)`);
console.log(`Wilson 95% CI on full-universe count: ${estLo} – ${estHi}  (point ≈ ${estMid})`);
console.log('');
console.log('Sample filter breakdown:');
console.log(`  passed:              ${stats.passed}`);
console.log(`  no quote / price=0:  ${stats.no_quote}`);
console.log(`  no marketCap data:   ${stats.no_cap}`);
console.log(`  price ∉ [$1, $100]:  ${stats.price_out_of_range}`);
console.log(`  marketCap < $150M:   ${stats.cap_too_low}`);
console.log('');

const priceBuckets = { '$1-10': 0, '$10-30': 0, '$30-100': 0 };
const capBuckets = { '$150M-1B': 0, '$1B-10B': 0, '$10B+': 0 };
for (const s of survivors) {
  if (s.price < 10) priceBuckets['$1-10']++;
  else if (s.price < 30) priceBuckets['$10-30']++;
  else priceBuckets['$30-100']++;
  if (s.capM < 1000) capBuckets['$150M-1B']++;
  else if (s.capM < 10000) capBuckets['$1B-10B']++;
  else capBuckets['$10B+']++;
}
console.log('Survivors by price band:');
for (const [b, v] of Object.entries(priceBuckets)) console.log(`  ${b.padEnd(10)} ${v}`);
console.log('');
console.log('Survivors by market cap:');
for (const [b, v] of Object.entries(capBuckets)) console.log(`  ${b.padEnd(12)} ${v}`);
console.log('');
console.log('15 random surviving names:');
for (const s of survivors.slice(0, 15)) {
  console.log(`  ${s.sym.padEnd(8)} $${s.price.toFixed(2).padStart(7)}  cap=$${Math.round(s.capM).toString().padStart(6)}M  ${s.name || ''}`);
}
