import { useParams } from 'react-router-dom';
import { getTickerDetail } from '../data/mockPositions';
import { TickerDetail } from '../components/TickerDetail/TickerDetail';
import ComingSoon from './ComingSoon';

export default function TickerDetailPage() {
  const { symbol } = useParams();

  if (!symbol) {
    return <ComingSoon label="Ticker detail" showBack />;
  }

  const detail = getTickerDetail(symbol);
  if (!detail) {
    return <ComingSoon label={`Ticker ${symbol.toUpperCase()} not found`} showBack />;
  }

  return <TickerDetail detail={detail} />;
}
