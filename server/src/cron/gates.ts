// cron/gates.ts — the concrete tick gates crons compose into defineCron.
//
// Kept out of kernel/scheduler.ts so the scheduler stays vendor-agnostic: the
// kernel knows the Gate *shape*, these know IB + market hours. A cron needing
// several preconditions passes them all (defineCron AND-composes the list).

import type { Gate } from '../kernel/scheduler.js';
import { ibGateway } from '../adapters/ib/ibGatewayAdapter.js';
import { marketPeriodAt } from '../utils/marketHours.js';

/**
 * Skip the tick unless the IB gateway is authenticated AND connected. The
 * IB-fed crons share this — daily/intraday bars come from IB only, so a tick is
 * a no-op when IB is down and the next tick after reconnect catches up.
 */
export const ibAuthGate: Gate = async () => {
  try {
    const s = await ibGateway.status();
    return s.authenticated && s.connected;
  } catch {
    return false; // IB unreachable ⇒ skip the tick, never crash the loop
  }
};

/**
 * Skip the tick when the feed is already fresh. `isFresh` returns true when the
 * cron's own data is current; the gate then returns false (skip). Pairs with
 * `CronHandle.trigger()` + the IB-reconnect catch-up: a reconnect triggers every
 * registered IB cron, but only the *stale* ones actually run their body — the
 * staleness decision lives here, local to each cron, with no central registry.
 */
export function freshnessGate(isFresh: () => boolean | Promise<boolean>): Gate {
  return async () => !(await isFresh());
}

/** Skip the tick outside the regular 09:30–16:00 ET session. */
export const marketRegularGate: Gate = () => marketPeriodAt() === 'regular';

/**
 * Skip the tick outside regular + after-hours (09:30–20:00 ET) — the band
 * engine / ib price poller window.
 */
export const marketRegularOrAfterHoursGate: Gate = () => {
  const p = marketPeriodAt();
  return p === 'regular' || p === 'after-hours';
};
