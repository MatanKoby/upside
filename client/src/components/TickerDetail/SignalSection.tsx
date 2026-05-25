import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../services/supabase';
import { type ActiveSignal, type UseSignalsResult } from '../../hooks/useSignals';
import { useAnalysisLock } from '../../hooks/useAnalysisLock';
import { SignalPill } from '../primitives/SignalPill';

// Relative "Last analyzed" label.
function timeAgo(iso: string): string {
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

type ButtonState = 'idle' | 'arming' | 'confirm' | 'submitting';

interface PostResult {
  status: number;
  reason?: string;
  lastAnalyzedAt?: string;
}

async function postAnalyze(symbol: string, force: boolean): Promise<PostResult> {
  const res = await apiFetch('/api/signals/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, force }),
  });
  if (res.status === 202) return { status: 202 };
  const body = (await res.json().catch(() => ({}))) as { reason?: string; lastAnalyzedAt?: string };
  return { status: res.status, reason: body.reason, lastAnalyzedAt: body.lastAnalyzedAt };
}

function DirectionBlock({ signal }: { signal: ActiveSignal }) {
  if (signal.type === 'no_signal') return null;
  return (
    <div className={`td-signal-direction td-signal-direction-${signal.type}`}>
      <SignalPill
        type={signal.type}
        quality={signal.quality}
        motivation={signal.motivation}
        low={signal.priceRangeLow}
        high={signal.priceRangeHigh}
      />
      {signal.rationale && <p className="td-signal-rationale">{signal.rationale}</p>}
    </div>
  );
}

export function SignalSection({ symbol, signalsResult }: { symbol: string; signalsResult: UseSignalsResult }) {
  const { analysis, signals, previousCount, isLoading } = signalsResult;
  const { isLocked } = useAnalysisLock(symbol);

  const [btn, setBtn] = useState<ButtonState>('idle');
  const [softBlock, setSoftBlock] = useState<{ lastAnalyzedAt?: string } | null>(null);
  const [dailyLimit, setDailyLimit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (armTimer.current) clearTimeout(armTimer.current);
  }, []);

  async function submit(force: boolean) {
    setBtn('submitting');
    setError(null);
    try {
      const r = await postAnalyze(symbol, force);
      if (r.status === 202) {
        setSoftBlock(null);
        // Lock Realtime takes over the UI from here; reset the button.
        setBtn('idle');
      } else if (r.status === 429 && r.reason === 'recent_analysis') {
        setSoftBlock({ lastAnalyzedAt: r.lastAnalyzedAt });
        setBtn('idle');
      } else if (r.status === 429 && r.reason === 'daily_limit_reached') {
        setDailyLimit(true);
        setBtn('idle');
      } else {
        setError(`Analyze failed (${r.status})`);
        setBtn('idle');
      }
    } catch (e) {
      setError((e as Error).message);
      setBtn('idle');
    }
  }

  // Two-step intentional friction: tap → grey 1s → "Confirm analyze" → tap.
  function onPrimaryClick() {
    if (btn === 'idle') {
      setBtn('arming');
      armTimer.current = setTimeout(() => setBtn('confirm'), 1000);
    } else if (btn === 'confirm') {
      void submit(false);
    }
  }

  const disabled = isLocked || btn === 'arming' || btn === 'submitting' || dailyLimit;
  const primaryLabel = isLocked
    ? 'Analyzing…'
    : btn === 'arming'
      ? '…'
      : btn === 'confirm'
        ? 'Confirm analyze'
        : btn === 'submitting'
          ? 'Starting…'
          : 'Analyze';

  return (
    <div className="td-signal">
      {analysis && (
        <div className="td-signal-head">
          <span className="td-signal-meta">
            Last analyzed {timeAgo(analysis.analyzedAt)}
            {previousCount > 0 && ` · ${previousCount} previous ${previousCount === 1 ? 'analysis' : 'analyses'}`}
          </span>
          {analysis.reasoning && <p>{analysis.reasoning}</p>}
        </div>
      )}

      {!isLoading && !analysis && <p className="td-signal-empty">No analysis yet. Tap Analyze to evaluate this ticker.</p>}

      {signals.some((s) => s.type !== 'no_signal') ? (
        <div className="td-signal-directions">
          {signals.map((s) => (
            <DirectionBlock key={s.id} signal={s} />
          ))}
        </div>
      ) : (
        analysis && <p className="td-signal-empty">No actionable signal in either direction.</p>
      )}

      {dailyLimit && (
        <p className="td-signal-warn">Daily analysis limit reached — resets at midnight UTC.</p>
      )}

      {softBlock ? (
        <div className="td-signal-actions">
          <span className="td-signal-meta">
            {softBlock.lastAnalyzedAt ? `Last analyzed ${timeAgo(softBlock.lastAnalyzedAt)} — ` : ''}re-analyze anyway?
          </span>
          <button type="button" className="btn btn-primary" disabled={btn === 'submitting'} onClick={() => void submit(true)}>
            Yes, re-analyze
          </button>
          <button type="button" className="btn" onClick={() => setSoftBlock(null)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="td-signal-actions">
          <button type="button" className="btn btn-primary" disabled={disabled} onClick={onPrimaryClick}>
            {primaryLabel}
          </button>
        </div>
      )}

      {error && <p className="td-signal-warn">{error}</p>}
    </div>
  );
}
