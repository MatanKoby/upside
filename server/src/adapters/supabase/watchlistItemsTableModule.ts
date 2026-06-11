// TableModule for `watchlist_items` — the SOLE server-side gatekeeper for the
// per-list membership rows (spec/screens/watchlist.md). IB owns membership: the
// sync upserts the current instruments and deletes the orphans; the poller reads
// (conid, symbol) across the active lists.
//
// Batch ARCH-3 (rollout slice 13 — the watchlist_* trio). The module owns the
// column names + chunk-free I/O; the orphan-reconcile policy (IB is the source
// of truth for membership) stays in services/watchlists.ts. Same SQL, no
// behavior change. See docs/arch/target-architecture.md.

import { TableModule } from './TableModule.js';

/** One membership row as the sync upserts it (camelCase). */
export interface ItemUpsert {
  listId: string;
  conid: number;
  symbol: string;
  companyName: string | null;
}

class WatchlistItemsTableModule extends TableModule {
  constructor() {
    super('watchlist_items');
  }

  /** Bulk-upsert a list's items on the (list_id, conid) key. */
  async upsertItems(items: ItemUpsert[]): Promise<void> {
    if (items.length === 0) return;
    await this.run(
      'upsertItems',
      this.from().upsert(
        items.map((i) => ({ list_id: i.listId, conid: i.conid, symbol: i.symbol, company_name: i.companyName })),
        { onConflict: 'list_id,conid' },
      ),
    );
  }

  /** (id, conid) for a list's items — the orphan-reconcile read. */
  async getItemsByListId(listId: string): Promise<Array<{ id: string; conid: number }>> {
    const rows = await this.run<Array<{ id: unknown; conid: unknown }>>(
      'getItemsByListId',
      this.from().select('id, conid').eq('list_id', listId),
    );
    return (rows ?? []).map((r) => ({ id: String(r.id), conid: Number(r.conid) }));
  }

  /** Delete items by id — the IB-membership orphan sweep. */
  async deleteItemsByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.run('deleteItemsByIds', this.from().delete().in('id', ids));
  }

  /** (conid, symbol) across a set of lists — the active-watchlist quote set.
   *  `conid` is raw `Number(...)` (may be NaN); the caller applies its finite
   *  guard + held-conid filter. */
  async getItemsByListIds(listIds: string[]): Promise<Array<{ conid: number; symbol: string }>> {
    if (listIds.length === 0) return [];
    const rows = await this.run<Array<{ conid: unknown; symbol: unknown }>>(
      'getItemsByListIds',
      this.from().select('conid, symbol').in('list_id', listIds),
    );
    return (rows ?? []).map((r) => ({ conid: Number(r.conid), symbol: String(r.symbol ?? '') }));
  }
}

export const watchlistItemsTableModule = new WatchlistItemsTableModule();
