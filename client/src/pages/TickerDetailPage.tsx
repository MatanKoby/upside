import { useParams } from 'react-router-dom';
import { TickerDetail } from '../components/TickerDetail/TickerDetail';
import { useTickerDetail } from '../hooks/useTickerDetail';
import ComingSoon from './ComingSoon';

export default function TickerDetailPage() {
  const { symbol } = useParams();
  const result = useTickerDetail(symbol);

  if (!symbol) {
    return <ComingSoon label="Ticker detail" showBack />;
  }

  switch (result.state) {
    case 'loading':
      return <ComingSoon label={`Loading ${symbol.toUpperCase()}…`} showBack />;
    case 'error':
      return <ComingSoon label={`Couldn’t load ${symbol.toUpperCase()}: ${result.error}`} showBack />;
    case 'not-held':
      // Non-held ticker browsing is a post-MVP path (would need a separate
      // /api/marketdata fetch by symbol). For MVP, route to ComingSoon so
      // the screen doesn't crash with an empty TickerDetailData.
      return <ComingSoon label={`${symbol.toUpperCase()} is not in your portfolio`} showBack />;
    case 'loaded':
      return <TickerDetail detail={result.detail} />;
  }
}
