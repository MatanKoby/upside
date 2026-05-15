// Full-screen "connecting" / "expired" state for the IB session.
//
// IBeam authenticates the IB Client Portal Gateway automatically on container
// start (see UPSIDE_MVP_SPEC.md → "IB Authentication Flow"). From the user's
// perspective there is no login form — just a one-time 2FA push to approve
// on the IB Key phone app the first time IBeam attempts login. While the
// gateway is unauthenticated, the FE polls /api/auth/status every 30s via
// useMarketSession and shows this block. Once IBeam reports authenticated,
// the parent unmounts this block and renders the portfolio.

interface Props {
  // Kept for API parity with earlier batches; useMarketSession's polling is
  // what actually dismisses the block, so we don't call this directly here.
  onReconnected?: () => void;
}

export function IBReconnectBlock(_props: Props) {
  return (
    <div className="ib-reconnect-block">
      <h1 className="ph-logo">Upside</h1>
      <p className="ib-reconnect-message">Connecting to Interactive Brokers…</p>
      <div className="auth-spinner" />
      <p className="ib-reconnect-help">
        If this is the first connect of the day, approve the 2FA push on your IB Key app.
      </p>
    </div>
  );
}
