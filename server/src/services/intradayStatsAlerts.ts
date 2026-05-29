// Intraday-stats hit detection (Batch B). Runs from `upsertQuote` on every
// canonical price write. Fires a Discord alert when current price enters the
// **typical intraday-low band** — i.e., today's drawdown from open is now in
// the [p50, p75] range we observed historically. 24h cooldown anchored on
// `intraday_stats.last_fired_at`.
//
// Band definition (in price space):
//   band_top    = today_open × (1 - intraday_low_pct_p50 / 100)
//   band_bottom = today_open × (1 - intraday_low_pct_p75 / 100)
// where p50 = typical dip, p75 = deeper-than-typical dip. Both are positive
// percentages, so band_top > band_bottom (the band is below open).
//
// "Entering the band" = price was ABOVE band_top on the prior write and is
// now AT or BELOW band_top. We don't re-fire when it dips deeper into the
// band (the user knows; they have the chip / Discord ping already).

import { supabase } from './supabase.js';
import { notifyIntradayStatsHit, notifyError } from './notify.js';

interface StatsRow {
  conid: number | string;
  intraday_low_pct_p50: number | string | null;
  intraday_low_pct_p75: number | string | null;
  last_fired_at: string | null;
}

const COOLDOWN_HOURS = 24;

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function cooldownPassed(lastFiredAt: string | null): boolean {
  if (!lastFiredAt) return true;
  return Date.now() - new Date(lastFiredAt).getTime() >= COOLDOWN_HOURS * 3600 * 1000;
}

export async function checkIntradayStatsForConid(
  conid: number,
  symbol: string,
  prev: number | null,
  curr: number,
): Promise<void> {
  if (prev == null || !Number.isFinite(curr)) return;
  if (prev === curr) return;

  const { data, error } = await supabase()
    .from('intraday_stats')
    .select('conid, intraday_low_pct_p50, intraday_low_pct_p75, last_fired_at')
    .eq('conid', conid)
    .maybeSingle();
  if (error) {
    void notifyError('intradayStatsAlerts.query', `query failed for conid ${conid}: ${error.message}`);
    return;
  }
  if (!data) return;
  const stats = data as StatsRow;
  const p50 = num(stats.intraday_low_pct_p50);
  const p75 = num(stats.intraday_low_pct_p75);
  if (p50 == null || p75 == null) return;

  // Need today's open to compute the band in price space.
  const { data: q } = await supabase()
    .from('quotes')
    .select('today_open')
    .eq('conid', conid)
    .maybeSingle();
  const todayOpen = num(q?.today_open as number | string | null | undefined);
  if (todayOpen == null || todayOpen <= 0) return;

  // p50/p75 are positive percentages (low below open). Convert to price.
  const bandTop = todayOpen * (1 - p50 / 100);
  // band_bottom = todayOpen * (1 - p75 / 100); kept conceptually but only
  // surfaced in the message — the fire trigger is just "entered the band."
  if (!Number.isFinite(bandTop) || bandTop <= 0) return;

  // Cross-into-band: prev was above band_top, curr is at/below it.
  if (!(prev > bandTop && curr <= bandTop)) return;
  if (!cooldownPassed(stats.last_fired_at)) return;

  try {
    await notifyIntradayStatsHit({
      symbol,
      currentPrice: curr,
      todayOpen,
      bandTop,
      bandBottom: todayOpen * (1 - p75 / 100),
      typicalDipPct: p50,
      deepDipPct: p75,
    });
  } catch (e) {
    void notifyError('intradayStatsAlerts.notify', `notify failed for ${symbol}: ${(e as Error).message}`, e);
  }
  const upd = await supabase()
    .from('intraday_stats')
    .update({ last_fired_at: new Date().toISOString() })
    .eq('conid', conid);
  if (upd.error) {
    void notifyError('intradayStatsAlerts.update', `last_fired_at update failed: ${upd.error.message}`);
  }
}
