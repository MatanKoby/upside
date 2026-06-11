// TableModule for `contracts` — the SOLE server-side gatekeeper for the IB
// contract-metadata cache (conid → company name / industry / exchange / …).
// Writers/readers: ibPricePoller (staleness-refresh on each holding) and
// signalEngine (lazy fill on analyze). Conflict key: conid.
//
// Speaks the shared camelCase `Contract` domain type (types/index.ts); the
// snake↔camel mapping lives here. Staleness policy stays in the callers.
//
// Batch ARCH-4 — finishes Phase 1 ("every table behind a module").
// See docs/arch/target-architecture.md → Phase 1.

import { TableModule } from './TableModule.js';
import type { Contract } from '../types/index.js';

interface ContractRow {
  conid: number | string;
  symbol: string;
  company_name: string | null;
  industry: string | null;
  category: string | null;
  asset_class: string;
  currency: string;
  exchange: string | null;
  valid_exchanges: string | null;
  refreshed_at: string;
}

function fromRow(r: ContractRow): Contract {
  return {
    conid: Number(r.conid),
    symbol: String(r.symbol),
    companyName: r.company_name ?? null,
    industry: r.industry ?? null,
    category: r.category ?? null,
    assetClass: String(r.asset_class),
    currency: String(r.currency),
    exchange: r.exchange ?? null,
    validExchanges: r.valid_exchanges ?? null,
    refreshedAt: String(r.refreshed_at),
  };
}

class ContractsTableModule extends TableModule {
  constructor() {
    super('contracts');
  }

  /** The cached contract for a conid, or null when not yet cached. */
  async getByConid(conid: number): Promise<Contract | null> {
    const row = await this.run<ContractRow>(
      'getByConid',
      this.from().select('*').eq('conid', conid).maybeSingle(),
    );
    return row ? fromRow(row) : null;
  }

  /** Upsert one contract-cache row (conflict on conid). */
  async upsert(c: Contract): Promise<void> {
    await this.run(
      'upsert',
      this.from().upsert(
        {
          conid: c.conid,
          symbol: c.symbol,
          company_name: c.companyName,
          industry: c.industry,
          category: c.category,
          asset_class: c.assetClass,
          currency: c.currency,
          exchange: c.exchange,
          valid_exchanges: c.validExchanges,
          refreshed_at: c.refreshedAt,
        },
        { onConflict: 'conid' },
      ),
    );
  }
}

export const contractsTableModule = new ContractsTableModule();
