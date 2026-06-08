import { useNavigate, useParams } from 'react-router-dom';
import { IconArrowLeft } from '@tabler/icons-react';
import { TickerDetail } from '../components/TickerDetail/TickerDetail';
import { useTickerDetail } from '../hooks/useTickerDetail';

// Loading / error / no-symbol all keep the screen header (back + symbol title)
// visible — only the body area shows the state message. Avoids the prior "whole
// screen says coming-soon" pattern. TickerDetail opens for ANY ticker (held,
// watchlist, or virtual-curated) — see useTickerDetail; there is no "not held"
// dead-end.

function TickerDetailShell({
  symbol,
  body,
  tone,
}: {
  symbol: string;
  body: React.ReactNode;
  tone?: 'info' | 'error';
}) {
  const navigate = useNavigate();
  return (
    <div className="ticker-detail-screen">
      <header className="td-header">
        <button type="button" className="td-back" aria-label="Back" onClick={() => navigate(-1)}>
          <IconArrowLeft size={18} />
        </button>
        <div className="td-title-wrap">
          <h1>{symbol.toUpperCase()}</h1>
          <p>&nbsp;</p>
        </div>
        <div className="td-price-wrap" aria-hidden>
          {/* keep header geometry stable while loading — empty placeholder */}
        </div>
      </header>
      <div className={`td-state-body td-state-${tone ?? 'info'}`}>{body}</div>
    </div>
  );
}

export default function TickerDetailPage() {
  const { symbol } = useParams();
  const result = useTickerDetail(symbol);

  if (!symbol) {
    return <TickerDetailShell symbol="" body={<p>No ticker selected.</p>} />;
  }

  switch (result.state) {
    case 'loading':
      return <TickerDetailShell symbol={symbol} body={<p>Loading…</p>} />;
    case 'error':
      return (
        <TickerDetailShell
          symbol={symbol}
          tone="error"
          body={<p>Couldn’t load this ticker: {result.error}</p>}
        />
      );
    case 'loaded':
      return <TickerDetail detail={result.detail} />;
  }
}
