import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../services/supabase';
import { type ActiveSignal, type UseSignalsResult } from '../../hooks/useSignals';
import { useAnalysisLock } from '../../hooks/useAnalysisLock';
import { SignalPill } from '../primitives/SignalPill';
import { PreAnalysisGateModal } from './PreAnalysisGateModal';
import type { RiskFlagRow } from '../../utils/riskFlags';

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

const CONDITION_LABEL: Record<string, string> = {
  at_or_above: 'at/above',
  at_or_below: 'at/below',
  about: '≈',
};

const LEG_STATUS_GLYPH: Record<string, string> = { hit: '✓', missed: '✗', pending: '⋯' };

function horizonLabel(signal: ActiveSignal): string | null {
  const pb = signal.playbook;
  if (!pb) return null;
  if (pb.horizon === 'intraday') return 'Intraday';
  return pb.horizonWindow ? `Multiday · ${pb.horizonWindow}` : 'Multiday';
}

// The single-direction playbook: direction + quality + horizon header, the one
// signal pill, then the ordered legs (each: action · price/condition ·
// confidence · why). Live per-leg status (14h) renders only when present.
function PlaybookView({ signal }: { signal: ActiveSignal }) {
  if (signal.type === 'no_signal') return null;
  const pb = signal.playbook;
  const legs = pb?.legs ?? [];
  const hz = horizonLabel(signal);

  return (
    <div className={`td-signal-direction td-signal-direction-${signal.type}`}>
      <div className="td-playbook-head">
        <SignalPill
          type={signal.type}
          quality={signal.quality}
          motivation={signal.motivation}
          price={legs[0]?.price ?? signal.optimalPrice}
        />
        {hz && <span className="td-playbook-horizon">⏱ {hz}</span>}
      </div>

      {legs.length > 0 ? (
        <ol className="td-playbook-legs">
          {legs.map((leg, i) => (
            <li key={i} className="td-playbook-leg">
              <div className="td-playbook-leg-line">
                {leg.status && (
                  <span className={`td-playbook-leg-status td-playbook-leg-status-${leg.status}`}>
                    {LEG_STATUS_GLYPH[leg.status] ?? '⋯'}
                  </span>
                )}
                <span className={`td-playbook-leg-action td-playbook-leg-action-${leg.action}`}>
                  {leg.action.toUpperCase()}
                </span>
                <span className="td-playbook-leg-price">
                  {CONDITION_LABEL[leg.condition] ?? ''} ${leg.price}
                </span>
                <span className="td-playbook-leg-conf">{Math.round(leg.confidence)}%</span>
              </div>
              <p className="td-playbook-leg-why">{leg.reasoning}</p>
            </li>
          ))}
        </ol>
      ) : (
        signal.rationale && <p className="td-signal-rationale">{signal.rationale}</p>
      )}
    </div>
  );
}

export function SignalSection({
  symbol,
  signalsResult,
  riskRow = null,
}: {
  symbol: string;
  signalsResult: UseSignalsResult;
  riskRow?: RiskFlagRow | null;
}) {
  const { analysis, signals, previousCount, isLoading } = signalsResult;
  const { isLocked } = useAnalysisLock(symbol);

  const [btn, setBtn] = useState<ButtonState>('idle');
  const [softBlock, setSoftBlock] = useState<{ lastAnalyzedAt?: string } | null>(null);
  const [dailyLimit, setDailyLimit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // CRITICAL risk flags front Analyze/Refine with a DANGER gate (one confirm
  // per mount), BEFORE the normal two-step friction. WARNING never gates.
  const [gateOpen, setGateOpen] = useState(false);
  const [gatePassed, setGatePassed] = useState(false);
  const pendingAction = useRef<'primary' | 'reanalyze' | null>(null);
  const requireGate = riskRow?.severity === 'critical' && !gatePassed;

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

  function startArming() {
    setBtn('arming');
    armTimer.current = setTimeout(() => setBtn('confirm'), 1000);
  }

  // Two-step intentional friction: tap → grey 1s → "Confirm analyze" → tap.
  // CRITICAL tickers open the DANGER gate first; confirming it then runs the
  // same two-step.
  function onPrimaryClick() {
    if (btn === 'idle') {
      if (requireGate) {
        pendingAction.current = 'primary';
        setGateOpen(true);
        return;
      }
      startArming();
    } else if (btn === 'confirm') {
      void submit(false);
    }
  }

  function onReanalyze() {
    if (requireGate) {
      pendingAction.current = 'reanalyze';
      setGateOpen(true);
      return;
    }
    void submit(true);
  }

  function onGateConfirm() {
    setGateOpen(false);
    setGatePassed(true);
    const action = pendingAction.current;
    pendingAction.current = null;
    if (action === 'primary') startArming();
    else if (action === 'reanalyze') void submit(true);
  }

  function onGateCancel() {
    setGateOpen(false);
    pendingAction.current = null;
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
          {signals
            .filter((s) => s.type !== 'no_signal')
            .map((s) => (
              <PlaybookView key={s.id} signal={s} />
            ))}
        </div>
      ) : (
        analysis && <p className="td-signal-empty">No actionable signal — held position, no clear setup.</p>
      )}

      {dailyLimit && (
        <p className="td-signal-warn">Daily analysis limit reached — resets at midnight UTC.</p>
      )}

      {softBlock ? (
        <div className="td-signal-actions">
          <span className="td-signal-meta">
            {softBlock.lastAnalyzedAt ? `Last analyzed ${timeAgo(softBlock.lastAnalyzedAt)} — ` : ''}re-analyze anyway?
          </span>
          <button type="button" className="btn btn-primary" disabled={btn === 'submitting'} onClick={onReanalyze}>
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

      {gateOpen && riskRow && (
        <PreAnalysisGateModal
          symbol={symbol}
          row={riskRow}
          onConfirm={onGateConfirm}
          onCancel={onGateCancel}
        />
      )}
    </div>
  );
}
