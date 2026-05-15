// Full-screen IB reconnect prompt — replaces the entire UI when IB session
// is expired. Embeds IB's own login UI via the BE's /ib-portal reverse proxy
// in an iframe so the user authenticates inside the Upside app without
// credentials ever passing through Upside code. See UPSIDE_MVP_SPEC.md →
// "IB Authentication Flow" for the rationale.
//
// Some browsers / IB configurations may still block the iframe even after
// our proxy strips X-Frame-Options + frame-ancestors CSP. A "Open in new
// tab" button below the iframe is the fallback.

import { useEffect, useState } from 'react';
import { getIbPortalUrl } from '../../services/apiUrl';

interface Props {
  // Called by the parent (useMarketSession in App.tsx) when its polling
  // detects the gateway is now authenticated. Same hook as before; only the
  // mechanism inside the block changed.
  onReconnected: () => void;
}

export function IBReconnectBlock({ onReconnected: _onReconnected }: Props) {
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getIbPortalUrl()
      .then((url) => {
        if (!cancelled) setPortalUrl(url);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="ib-reconnect-block">
      <h1 className="ph-logo">Upside</h1>
      <p className="ib-reconnect-message">Sign in to Interactive Brokers</p>

      {error && <div className="ib-reconnect-error">{error}</div>}

      {portalUrl && (
        <>
          <iframe
            className="ib-reconnect-iframe"
            src={portalUrl}
            title="Interactive Brokers Login"
          />
          <p className="ib-reconnect-help">
            If the login form doesn’t appear,{' '}
            <a href={portalUrl} target="_blank" rel="noopener noreferrer">
              open it in a new tab
            </a>
            . Approve the 2FA push on your IB Key app after submitting.
          </p>
        </>
      )}
    </div>
  );
}
