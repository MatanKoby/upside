// Shared stale-while-revalidate cache for the main data hooks (Batch X11).
//
// The big data hooks (usePositions / useWatchlistData / useVirtualList) are
// each `useState` + a Supabase Realtime subscription, so they refetch from
// scratch on every mount and hold nothing across unmount — every route / sub-
// tab switch that unmounts a consumer shows a loading flash and re-queries
// data that was just on screen.
//
// This is a tiny module-level cache that holds the last successful snapshot per
// (hook, key). On mount a hook seeds its state from the cache and paints
// instantly (no loading state on a cache hit), while its existing Realtime sub
// + a background reload revalidate; every successful load writes the snapshot
// back, so a remount is always warm. Module-level = survives unmount, resets on
// a full page reload. FE-only, no new dependency (react-query / SWR is the
// heavier alternative, deferred until measured need — see
// spec/architecture.md → Frontend data caching).
//
// Single-user app: the cache isn't user-scoped. A full reload (or the natural
// Realtime revalidation) is the reset; we don't try to evict on auth change.

const store = new Map<string, unknown>();

/** Last cached snapshot for `key`, or undefined on a cold cache. */
export function readCache<T>(key: string): T | undefined {
  return store.get(key) as T | undefined;
}

/** Record the latest successful snapshot for `key`. */
export function writeCache<T>(key: string, value: T): void {
  store.set(key, value);
}
