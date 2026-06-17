// IB-reconnect staleness catch-up (Batch ARCH-10).
//
// When the IB session returns to authenticated+connected — explicit Connect,
// recovery from the nightly forced logout, or from an external session kill —
// the IB-dependent producers should refresh *now* instead of waiting out their
// 12–24h boot-relative cadence. See spec/flows.md → Connect/Disconnect Flow →
// "Reconnect → staleness catch-up".
//
// Mechanism: each IB-dependent cron registers its `defineCron` handle here; on a
// disconnected→connected edge we `.trigger()` each one, staggered. Each cron's
// own `freshnessGate` (cron/gates.ts) makes the trigger a no-op when its feed is
// already fresh — so the staleness check is per-cron, not central.

import type { CronHandle } from '../kernel/scheduler.js';
import { ibGateway } from '../adapters/ib/ibGatewayAdapter.js';

// Spacing between successive triggers, so a reconnect doesn't fire a burst of IB
// history calls all at once (a single producer tick has issued 35 in a minute).
const STAGGER_MS = 3_000;

const registered: CronHandle[] = [];

/** Register a cron to be triggered on the next IB reconnect. */
export function onIbReconnect(handle: CronHandle): void {
  registered.push(handle);
}

/** Trigger every registered cron, staggered. Each cron's freshness gate decides
 *  whether its body actually runs. */
export function fireIbReconnect(): void {
  registered.forEach((handle, i) => {
    setTimeout(() => handle.trigger(), i * STAGGER_MS).unref();
  });
}

// Last observed auth state — the edge is a transition into connected, so a
// steady (or briefly-flapping-while-connected) session never re-fires. Starts
// false: if IB is already up at boot, the first detect fires once and the
// freshness gates keep redundant triggers cheap.
let lastConnected = false;

/**
 * Poll the IB auth status once and fire the catch-up on a `false→true` edge.
 * Called from the keepalive tickle (the 30s IB heartbeat) so it covers every
 * connect path without a second timer.
 */
export async function detectIbReconnect(): Promise<void> {
  let nowConnected = false;
  try {
    const s = await ibGateway.status();
    nowConnected = s.authenticated && s.connected;
  } catch {
    nowConnected = false; // unreachable ⇒ treat as down; never throw into keepalive
  }
  if (nowConnected && !lastConnected) fireIbReconnect();
  lastConnected = nowConnected;
}

// Test seam — reset module state between cases.
export const __test = {
  reset(): void {
    registered.length = 0;
    lastConnected = false;
  },
  setLastConnected(v: boolean): void {
    lastConnected = v;
  },
};
