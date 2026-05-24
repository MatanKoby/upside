// Positive-list of IB Client Portal paths the /api/debug/ib-passthrough
// endpoint will proxy. Anything not matching a regex here is rejected with
// 400 path_not_allowed.
//
// Rule for additions: ONLY safe, read-only, GET-able paths that we'd ever
// legitimately want to inspect for schema-discovery. NEVER add anything
// under the "forbidden families" below — the passthrough endpoint accepts
// auth tokens from any whitelisted user, and order operations would let a
// compromised token execute trades. Read-only is the structural mitigation.

const ALLOWED: readonly RegExp[] = [
  /^\/v1\/api\/iserver\/accounts$/,
  /^\/v1\/api\/iserver\/account\/[^/]+\/summary$/,
  /^\/v1\/api\/iserver\/account\/trades$/,
  /^\/v1\/api\/iserver\/auth\/status$/,
  /^\/v1\/api\/iserver\/contract\/\d+\/info$/,
  /^\/v1\/api\/iserver\/marketdata\/history$/,
  /^\/v1\/api\/iserver\/marketdata\/snapshot$/,
  /^\/v1\/api\/iserver\/secdef\/search$/,
  /^\/v1\/api\/iserver\/watchlists$/,
  /^\/v1\/api\/iserver\/watchlist$/,
  /^\/v1\/api\/portfolio\/accounts$/,
  /^\/v1\/api\/portfolio\/[^/]+\/ledger$/,
  /^\/v1\/api\/portfolio\/[^/]+\/positions\/\d+$/,
  /^\/v1\/api\/portfolio\/[^/]+\/summary$/,
  /^\/v1\/api\/portfolio\/[^/]+\/transactions$/,
  /^\/v1\/api\/tickle$/,
];

// HARD DENY-GATE — trade-execution surface area. Checked BEFORE either positive
// allowlist, for BOTH GET and POST, so the passthrough can NEVER place, modify,
// or cancel an order — even if a future allowlist edit mistakenly includes a
// dangerous path. This is the structural guarantee (not just a convention) that
// this surface is read-only. Do not weaken without a very good reason.
const FORBIDDEN: readonly RegExp[] = [
  /\/orders?(\/|$)/i,          // /orders, /order/{id}
  /\/reply(\/|$)/i,            // order confirmation replies
  /\/(place|cancel|modify)/i,  // any order place/cancel/modify verb
  /\/scanner(\/|$)/i,          // market scanner (not read-only schema discovery)
];

// True if the path touches the trade-execution surface and must be rejected
// outright (403), regardless of allowlists.
export function isForbiddenIbPath(path: string): boolean {
  return FORBIDDEN.some((r) => r.test(path));
}

// Positive-list for the POST passthrough. POST is the verb IB uses to PLACE
// ORDERS, so this list is deliberately tiny and audited: read-only Portfolio
// Analyst query endpoints ONLY. They take a JSON body (acctIds/conids/days) and
// return analytics/history — they cannot mutate account state. NEVER add
// anything under the forbidden families above (orders / reply / place / cancel
// / modify) or any session-mutating endpoint (e.g. auth/ssodh/init). The GET
// and POST allowlists are independent on purpose: a path being safe to GET says
// nothing about it being safe to POST.
const ALLOWED_POST: readonly RegExp[] = [
  /^\/v1\/api\/pa\/transactions$/,
  /^\/v1\/api\/pa\/summary$/,
  /^\/v1\/api\/pa\/performance$/,
  /^\/v1\/api\/pa\/allperiods$/,
];

export function isAllowedIbPath(path: string): boolean {
  return ALLOWED.some((r) => r.test(path));
}

export function isAllowedIbPostPath(path: string): boolean {
  return ALLOWED_POST.some((r) => r.test(path));
}

// Surface a human-readable list in the 400 response. Strip the regex anchors
// and double-backslashes so the user sees clean paths.
function humanize(list: readonly RegExp[]): readonly string[] {
  return list.map((r) =>
    r.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/').replace(/\\d/g, '\\d'),
  );
}

export function allowedPathsForError(): readonly string[] {
  return humanize(ALLOWED);
}

export function allowedPostPathsForError(): readonly string[] {
  return humanize(ALLOWED_POST);
}
