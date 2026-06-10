// Base for per-table persistence modules ("TableModule") — one gatekeeper
// per Supabase table, the only place a table is read or written (one
// writer-owner per table). The base owns the *mechanics* shared by every
// table: the client/table binding, consistent error wrapping, and the
// date-retention primitive. It owns NO *meaning* — row mapping and the
// intention-revealing methods live in each subclass.
//
// Design: Batch ARCH-1. See docs/arch/target-architecture.md → Phase 1.

import { supabase } from '../services/supabase.js';

/** Minimal structural shape of the supabase query result we depend on. */
interface PgResult<T> {
  data: T | null;
  error: { message: string } | null;
}

export abstract class TableModule {
  protected constructor(protected readonly table: string) {}

  /** Query builder bound to this module's table. */
  protected from() {
    return supabase().from(this.table);
  }

  /** Await a supabase query; throw a consistent `<table>.<op>` error on
   *  failure. Returns the `data` payload — the caller supplies the row type. */
  protected async run<T>(op: string, query: PromiseLike<PgResult<T>>): Promise<T | null> {
    const { data, error } = await query;
    if (error) throw new Error(`${this.table}.${op}: ${error.message}`);
    return data;
  }

  /** Retention primitive — delete rows whose `dateColumn` is older than
   *  `cutoff`. Subclasses expose a public `purgeOlderThan(cutoff)` with their
   *  own date column bound, so callers never pass the column name. */
  protected async deleteOlderThan(dateColumn: string, cutoff: string): Promise<void> {
    await this.run('purgeOlderThan', this.from().delete().lt(dateColumn, cutoff));
  }
}
