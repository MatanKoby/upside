// TableModule for `watchlist_lists` — the SOLE server-side gatekeeper for the
// user's imported IB watchlists (spec/screens/watchlist.md). Writers: the IB
// sync (insert first-seen lists + refresh IB-owned metadata) and the active
// toggle. Readers: the sync's insert-vs-update probe and the poller's
// active-list-id seed.
//
// Batch ARCH-3 (rollout slice 13 — the watchlist_* trio). The module owns the
// column names + the "never overwrite the user-owned `active` flag on sync"
// column split; the IB reconciliation policy stays in services/watchlists.ts.
// Same SQL, no behavior change. See docs/arch/target-architecture.md.

import { TableModule } from './TableModule.js';

/** Existing-row slice for the sync insert-vs-update decision. */
export interface ListSyncRow {
  id: string;
  active: boolean;
}

/** A first-seen list as the sync inserts it (camelCase). */
export interface NewList {
  userId: string;
  ibListId: string;
  name: string;
  ibModifiedAt: string | null;
  syncedAt: string;
}

class WatchlistListsTableModule extends TableModule {
  constructor() {
    super('watchlist_lists');
  }

  /** Existing (id, active) for a user's IB list — the sync insert-vs-update
   *  probe. Null when first-seen. */
  async getByIbListId(userId: string, ibListId: string): Promise<ListSyncRow | null> {
    const r = await this.run<{ id: unknown; active: unknown } | null>(
      'getByIbListId',
      this.from().select('id, active').eq('user_id', userId).eq('ib_list_id', ibListId).maybeSingle(),
    );
    if (!r) return null;
    return { id: String(r.id), active: Boolean(r.active) };
  }

  /** Refresh the IB-owned metadata on an existing list — never touches the
   *  user-owned `active` flag. */
  async updateSyncMeta(listId: string, name: string, ibModifiedAt: string | null, syncedAt: string): Promise<void> {
    await this.run(
      'updateSyncMeta',
      this.from().update({ name, ib_modified_at: ibModifiedAt, synced_at: syncedAt }).eq('id', listId),
    );
  }

  /** Insert a first-seen list (active defaults false — opt-in) → the new id. */
  async insertList(l: NewList): Promise<string> {
    const r = await this.run<{ id: unknown } | null>(
      'insertList',
      this.from()
        .insert({
          user_id: l.userId,
          ib_list_id: l.ibListId,
          name: l.name,
          active: false,
          ib_modified_at: l.ibModifiedAt,
          synced_at: l.syncedAt,
        })
        .select('id')
        .single(),
    );
    if (!r) throw new Error('watchlist_lists.insertList: no row returned');
    return String(r.id);
  }

  /** Flip a list's `active` flag (RLS-safe via the user_id filter). */
  async setActive(userId: string, listId: string, active: boolean): Promise<void> {
    await this.run('setActive', this.from().update({ active }).eq('user_id', userId).eq('id', listId));
  }

  /** Ids of every active list — the watchlist quote poller's symbol-set seed. */
  async getActiveListIds(): Promise<string[]> {
    const rows = await this.run<Array<{ id: unknown }>>(
      'getActiveListIds',
      this.from().select('id').eq('active', true),
    );
    return (rows ?? []).map((r) => String(r.id));
  }
}

export const watchlistListsTableModule = new WatchlistListsTableModule();
