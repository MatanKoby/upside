// Watchlists service (Batch A1) — IB-sync orchestration + active-toggle.
//
// Pull strategy follows spec/flows.md → Watchlist Import Flow:
//   1. GET /iserver/watchlists  → user_lists[] + system_lists[]
//   2. Filter to user_lists only (system_lists are IB-curated read-only).
//   3. Per user_list: GET /iserver/watchlist?id=<id>  → instruments[]
//   4. Upsert watchlist_lists (preserve any local `active` flag the user set).
//   5. Upsert watchlist_items per (list_id, conid). Items missing from the
//      new IB payload get DELETED — IB is the source of truth for membership.
//
// We DO NOT touch `quotes` here — the poller writes prices on its next cycle
// once a list is marked `active=true` (the poller queries
// watchlist_lists WHERE active=true to pick its symbol set).

import { ibWatchlists, ibWatchlist } from './ibGateway.js';
import { watchlistListsTableModule } from '../adapters/supabase/watchlistListsTableModule.js';
import { watchlistItemsTableModule } from '../adapters/supabase/watchlistItemsTableModule.js';
import { notifyError } from './notify.js';
import type { RawIbWatchlistInstrument } from '../types/index.js';

export interface SyncResult {
  imported: number;       // total user_lists seen from IB
  newLists: number;       // first-time imports
  removedItems: number;   // items removed from IB since last sync
  totalItems: number;     // total items across all synced lists
}

// `instrument.fullName` is the symbol in IB's payload (e.g. "MU"); `ticker`
// mirrors it but isn't always present. `name` is the company name. We persist
// `ticker || fullName` as `symbol`, fall back to "" if neither present.
function pickSymbol(inst: RawIbWatchlistInstrument): string {
  return (inst.ticker ?? inst.fullName ?? '').trim().toUpperCase();
}

export async function syncWatchlistsFromIb(userId: string): Promise<SyncResult> {
  const top = await ibWatchlists();
  if (!top) {
    throw new Error('ib_watchlists_fetch_failed');
  }

  // IB Client Portal currently wraps the payload in `{ data: {...}, action,
  // MID }`. Older captures had user_lists at the top level. Accept either —
  // unwrap `.data` when present (verified live 2026-05-28 via the
  // watchlists.sync.empty diagnostic).
  const payload = (top.data && typeof top.data === 'object' ? top.data : top) as {
    user_lists?: typeof top.user_lists;
    system_lists?: typeof top.system_lists;
  };
  const userLists = Array.isArray(payload.user_lists) ? payload.user_lists : [];

  // Observability for the silent-success class: if we got 200 but extracted
  // no user_lists, notify #errors with the top-level shape so we can spot
  // future format changes the same way.
  if (userLists.length === 0) {
    const topKeys = Object.keys(top ?? {});
    const sysLen = Array.isArray(payload.system_lists) ? payload.system_lists.length : 'n/a';
    void notifyError(
      'watchlists.sync.empty',
      `IB /iserver/watchlists returned 200 but user_lists is empty. top_keys=[${topKeys.join(',')}] system_lists_len=${sysLen}. Sample payload top: ${JSON.stringify(top).slice(0, 400)}`,
    );
  }
  const now = new Date().toISOString();

  let totalItems = 0;
  let removedItems = 0;
  let newLists = 0;

  // Upsert each user_list. We preserve `active` (don't overwrite) by reading
  // the current row first and only inserting when missing or updating fields
  // that aren't user-owned (name, ib_modified_at, synced_at).
  for (const list of userLists) {
    if (!list.id || !list.name) continue;

    // Look up an existing row to decide insert vs update-without-active.
    const existing = await watchlistListsTableModule.getByIbListId(userId, list.id).catch(() => null);
    const ibModifiedAt = list.modified ? new Date(list.modified).toISOString() : null;

    let localListId: string;
    if (existing) {
      localListId = existing.id;
      await watchlistListsTableModule.updateSyncMeta(localListId, list.name, ibModifiedAt, now).catch(() => undefined);
    } else {
      try {
        localListId = await watchlistListsTableModule.insertList({
          userId,
          ibListId: list.id,
          name: list.name,
          ibModifiedAt,
          syncedAt: now,
        });
      } catch (e) {
        void notifyError('watchlists.sync', `insert list failed for ${list.id}: ${(e as Error).message}`);
        continue;
      }
      newLists++;
    }

    // Fetch this list's instruments and reconcile.
    const contents = await ibWatchlist(list.id);
    const instruments = Array.isArray(contents?.instruments) ? contents!.instruments : [];

    const itemsToUpsert = instruments
      .filter((i) => i.conid && pickSymbol(i))
      .map((i) => ({
        listId: localListId,
        conid: i.conid,
        symbol: pickSymbol(i),
        // IB's `instrument.name` is the company name (e.g. "MICRON TECHNOLOGY
        // INC"); free to capture during sync rather than hit /contract/info
        // per ticker later. Falls back to symbol when missing.
        companyName: typeof i.name === 'string' && i.name.trim() ? i.name.trim() : null,
      }));

    const fromIbConids = new Set<number>(itemsToUpsert.map((i) => i.conid));

    if (itemsToUpsert.length) {
      try {
        await watchlistItemsTableModule.upsertItems(itemsToUpsert);
      } catch (e) {
        void notifyError('watchlists.sync', `upsert items failed for list ${list.id}: ${(e as Error).message}`);
      }
      totalItems += itemsToUpsert.length;
    }

    // Delete items that disappeared from IB (IB owns membership).
    const existingItems = await watchlistItemsTableModule.getItemsByListId(localListId).catch(() => []);
    const orphans = existingItems.filter((r) => !fromIbConids.has(r.conid));
    if (orphans.length) {
      await watchlistItemsTableModule.deleteItemsByIds(orphans.map((r) => r.id)).catch(() => undefined);
      removedItems += orphans.length;
    }
  }

  return {
    imported: userLists.length,
    newLists,
    removedItems,
    totalItems,
  };
}

/** Flip a list's `active` flag — RLS-safe via the user_id filter. */
export async function setListActive(
  userId: string,
  listId: string,
  active: boolean,
): Promise<boolean> {
  try {
    await watchlistListsTableModule.setActive(userId, listId, active);
    return true;
  } catch {
    return false;
  }
}
