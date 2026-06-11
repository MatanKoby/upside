// Profit-taking zone state machine (Batch 14c).
//
// A position is "in zone" when its unrealized P&L percent is at or above the
// user's threshold. `computeZoneState` is the single source of truth for the
// zone-field transitions; both pollers call it on every write so the behavior
// stays identical regardless of which source (IB / Finnhub) refreshed the price.
//
// Notifications: a fresh entry (!inZone → inZone) fires one Discord ping, but
// only if the 4h cooldown (anchored on `last_zone_notification_at`) has elapsed.
// Re-entry chop near the threshold within the window is suppressed. Zone-exit
// never notifies in MVP — exit data is recorded for post-mortem only.

import { userPreferencesTableModule } from '../adapters/supabase/userPreferencesTableModule.js';
import { marketPeriodAt } from '../utils/marketHours.js';

const ZONE_NOTIFY_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h
const DEFAULT_THRESHOLD_PCT = 2.0;

export interface ZoneFields {
  zone_entered_at: string | null;
  zone_exited_at: string | null;
  last_zone_notification_at: string | null;
  entered_zone_via_gap: boolean;
}

export interface ZoneResult {
  fields: ZoneFields;
  changed: boolean; // any field differs from `prev` → caller must persist it
  notify: boolean;  // fresh entry past the cooldown → caller fires notifyProfitZoneEntry
}

// Pure (save for the clock + market-period read). Given the prior zone fields,
// the new P&L%, and the threshold, return the next zone fields plus whether to
// persist / notify. `pnlPct == null` is treated as "not in zone".
export function computeZoneState(
  prev: ZoneFields,
  pnlPct: number | null,
  thresholdPct: number,
  now: Date = new Date(),
): ZoneResult {
  const wasInZone = prev.zone_entered_at != null;
  const nowInZone = pnlPct != null && pnlPct >= thresholdPct;
  const nowIso = now.toISOString();
  const fields: ZoneFields = { ...prev };
  let notify = false;

  if (!wasInZone && nowInZone) {
    const period = marketPeriodAt(now);
    fields.zone_entered_at = nowIso;
    fields.zone_exited_at = null;
    // "via gap" = entry happened outside the regular session (pre-market or
    // overnight/weekend), which tends to fade at the open as others take profit.
    fields.entered_zone_via_gap = period === 'pre-market' || period === 'closed';
    const lastNotif = prev.last_zone_notification_at
      ? Date.parse(prev.last_zone_notification_at)
      : 0;
    if (now.getTime() - lastNotif >= ZONE_NOTIFY_COOLDOWN_MS) {
      notify = true;
      fields.last_zone_notification_at = nowIso;
    }
  } else if (wasInZone && !nowInZone) {
    fields.zone_exited_at = nowIso;
    fields.zone_entered_at = null;
    // entered_zone_via_gap is intentionally left as-is — zoneGapCleanup clears
    // it at end of the regular session, not on exit.
  }

  const changed =
    fields.zone_entered_at !== prev.zone_entered_at
    || fields.zone_exited_at !== prev.zone_exited_at
    || fields.last_zone_notification_at !== prev.last_zone_notification_at
    || fields.entered_zone_via_gap !== prev.entered_zone_via_gap;

  return { fields, changed, notify };
}

// The owner's configured threshold, falling back to the default when the
// preferences row or column is missing/invalid.
export async function getProfitZoneThreshold(userId: string): Promise<number> {
  const prefs = await userPreferencesTableModule.getByUserId(userId);
  const raw = prefs?.profitZoneThresholdPct;
  const n = raw == null ? DEFAULT_THRESHOLD_PCT : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_THRESHOLD_PCT;
}
