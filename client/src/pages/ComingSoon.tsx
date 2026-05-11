import { useNavigate, useParams } from 'react-router-dom';
import { IconArrowLeft } from '@tabler/icons-react';

export default function ComingSoon({ label, showBack = false }: { label: string; showBack?: boolean }) {
  const navigate = useNavigate();
  const { symbol } = useParams();
  return (
    <div className="coming-soon">
      {showBack && (
        <button onClick={() => navigate(-1)} className="coming-soon-back" aria-label="Back">
          <IconArrowLeft size={20} stroke={1.5} />
        </button>
      )}
      <p className="coming-soon-text">
        {label}{symbol ? ` · ${symbol}` : ''} — coming soon
      </p>
    </div>
  );
}
