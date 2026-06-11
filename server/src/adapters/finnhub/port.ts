// FinnhubPort — the vendor-shaped contract for finnhub.io (Phase 2, ports &
// adapters). Callers depend on this interface + the `finnhub` singleton, never
// on the HTTP client or the rate-limit queue. The adapter is the SOLE importer
// of env.finnhubApiKey. See docs/arch/target-architecture.md → Phase 2.

// Bulk earnings-calendar pull (Batch S2). One call returns every US ticker
// that reported in [from, to]. `from`/`to` are YYYY-MM-DD wall-clock dates.
// Used by catalystReversalProducer + postEarningsDriftProducer for the
// daily Stage 0 / candidate-set computation.
export interface FinnhubEarningsRow {
  date?: string;        // YYYY-MM-DD report date
  symbol?: string;
  hour?: 'bmo' | 'amc' | 'dmh' | string;  // before-mkt-open / after-mkt-close / during
  epsActual?: number | null;
  epsEstimate?: number | null;
  revenueActual?: number | null;
  revenueEstimate?: number | null;
  quarter?: number;
  year?: number;
}

// Real-time-ish quote for one symbol. Used by the fallback finnhubPricePoller
// when IB is disconnected. Shape (Finnhub):
//   c  = current price
//   h  = today's high
//   l  = today's low
//   o  = today's open
//   pc = previous close
//   t  = unix-seconds timestamp
export interface FinnhubQuote {
  c: number | null;   // current
  h: number | null;   // today high
  l: number | null;   // today low
  o: number | null;   // today open
  pc: number | null;  // prior close
  t: number | null;   // unix-seconds
  d: number | null;   // today change ($)
  dp: number | null;  // today change (%)
}

// Basic financials / fundamentals via `/stock/metric?metric=all`. Keys vary by
// symbol; callers fall back across synonyms.
export type FinnhubMetrics = Record<string, number | string | null | undefined>;

// /stock/symbol?exchange=US — the universe pull for the Screener track
// (Batch S1). Returns ~30,538 US symbols across all listing venues; the
// cron filters them down in-process before any per-symbol call.
export interface FinnhubSymbolRow {
  currency?: string;
  description?: string;
  displaySymbol?: string;
  figi?: string;
  mic?: string;        // exchange identifier (XNAS / XNYS / XASE / OOTC / etc.)
  symbol?: string;
  type?: string;       // 'Common Stock' | 'ADR' | 'ETP' | 'REIT' | ...
}

// /stock/profile2?symbol=… — company profile used by the universe filter
// for marketCapitalization. Finnhub reports cap in MILLIONS of USD (so 1500
// = $1.5B).
export interface FinnhubProfile2 {
  country?: string;
  currency?: string;
  estimateCurrency?: string;
  exchange?: string;
  finnhubIndustry?: string;
  ipo?: string;
  marketCapitalization?: number;  // millions USD
  name?: string;
  phone?: string;
  shareOutstanding?: number;       // millions
  ticker?: string;
  weburl?: string;
  logo?: string;
}

export interface FinnhubPort {
  /** Company news headlines in [from, to] (YYYY-MM-DD). Always an array. */
  companyNews(symbol: string, from: string, to: string): Promise<unknown[]>;
  /** Per-symbol earnings calendar (raw `{ earningsCalendar: [...] }` shape). */
  earningsCalendar(symbol: string): Promise<unknown>;
  /** Bulk earnings calendar across [from, to] — every US ticker that reported. */
  earningsCalendarRange(from: string, to: string): Promise<FinnhubEarningsRow[]>;
  /** Per-symbol insider transactions (raw shape). */
  insiderTransactions(symbol: string): Promise<unknown>;
  /** Real-time-ish quote; null when the response isn't an object. */
  getQuote(symbol: string): Promise<FinnhubQuote | null>;
  /** `metric=all` fundamentals map; null when absent. */
  basicFinancials(symbol: string): Promise<FinnhubMetrics | null>;
  /** All symbols on an exchange (default US). Always an array. */
  getSymbolList(exchange?: string): Promise<FinnhubSymbolRow[]>;
  /** Company profile; null when absent. */
  getProfile2(symbol: string): Promise<FinnhubProfile2 | null>;
}
