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

// Documented for the next contributor — do NOT add any path containing these
// substrings to the allowlist. Trade-execution surface area. The endpoint's
// GET-only constraint and this allowlist together are the defense.
//
//   /orders
//   /reply/
//   /scanner/
//   anything containing: order, place, cancel, modify
//
// We don't enforce these as a deny-list in code because the positive
// allowlist already excludes them; this comment exists so future allowlist
// changes are reviewed against the rule.

export function isAllowedIbPath(path: string): boolean {
  return ALLOWED.some((r) => r.test(path));
}

export function allowedPathsForError(): readonly string[] {
  // Surface a human-readable list in the 400 response. Strip the regex
  // anchors and double-backslashes so the user sees clean paths.
  return ALLOWED.map((r) =>
    r.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/').replace(/\\d/g, '\\d'),
  );
}
