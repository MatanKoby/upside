import { useRef } from 'react';
import { IconBolt, IconInfoCircle } from '@tabler/icons-react';
import type { VirtualRow } from '../../hooks/useVirtualList';
import type { ReasonChip } from '../../config/virtualList';
import type { RiskFlagRow } from '../../utils/riskFlags';
import { type EntryTemp, TEMP_META } from '../../utils/entryTemperature';
import { useLongPress } from '../../hooks/useLongPress';
import { openRobinhood } from '../../utils/robinhood';
import { MiniSparkline } from './MiniSparkline';
import { PriceFlicker } from '../common/PriceFlicker';
import { DangerBadge } from '../primitives/DangerBadge';
import { formatCurrency, formatSignedPercent } from '../../utils/formatters';

// One row of an Intraday / Swing virtual list (Batch X2). The shared
// watchlist-row layout plus the virtual-list extras: a ⚡ just-fired marker,
// `why` reason chips, a walking-band chip, and a rolling-30d hit-rate column.
// See spec/screens/watchlist.md → Upside-curated virtual lists.

const LONG_PRESS_MS = 500;

const REASON_LABEL: Record<ReasonChip, string> = {
  dip: 'dip',
  catalyst: 'catalyst',
  'post-earnings': 'post-earnings',
};

const REGIME_LABEL: Record<string, string> = {
  mean_reversion: 'mean-rev',
  bullish_trend: 'bull',
  bearish_trend: 'bear',
  mixed: 'mixed',
  ah_low_confidence: 'AH',
};

function bandChipTitle(band: NonNullable<VirtualRow['band']>): string {
  const parts: string[] = [];
  if (band.lowBand != null) parts.push(`next low ${formatCurrency(band.lowBand)}`);
  if (band.highBand != null) parts.push(`next high ${formatCurrency(band.highBand)}`);
  return parts.length ? parts.join(' · ') : 'walking band';
}

export function VirtualListRow({
  row,
  risk,
  temp,
  tailwindCount,
  headwindCount,
  onTap,
  onLongPress,
  onWhy,
}: {
  row: VirtualRow;
  risk: RiskFlagRow | null;
  temp: EntryTemp;
  tailwindCount: number;
  headwindCount: number;
  onTap: () => void;
  onLongPress: () => void;
  onWhy: () => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

  const start = () => {
    longPressFired.current = false;
    timer.current = setTimeout(() => {
      longPressFired.current = true;
      onLongPress();
    }, LONG_PRESS_MS);
  };
  const cancel = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const onClick = (e: React.MouseEvent) => {
    if (longPressFired.current) {
      e.preventDefault();
      return;
    }
    onTap();
  };
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    onLongPress();
  };

  const symbolPress = useLongPress(() => openRobinhood(row.symbol));

  const band = row.band;
  const volScalar = band?.volScalar ?? null;

  return (
    <div
      className="watchlist-item virtual-row"
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onContextMenu={onContextMenu}
      onClick={onClick}
      role="button"
      tabIndex={0}
    >
      <div className="watchlist-item-main">
        <div className="watchlist-item-left">
          {TEMP_META[temp].glyph && (
            <span className={`temp-badge temp-badge-${temp}`} title={TEMP_META[temp].label} aria-label={TEMP_META[temp].label}>
              {TEMP_META[temp].glyph}
            </span>
          )}
          <span
            className="watchlist-item-sym ticker-symbol-pressable"
            title="Long-press → Robinhood"
            {...symbolPress}
          >
            {row.justFired && (
              <IconBolt size={13} stroke={2} className="virtual-fired-icon" aria-label="just fired" />
            )}
            {row.symbol}
          </span>
        </div>
        {row.sparklineCloses && row.sparklineCloses.length >= 2 && (
          <div className="watchlist-item-spark">
            <MiniSparkline closes={row.sparklineCloses} />
          </div>
        )}
        <div className="watchlist-item-chip-cluster">
          {risk && <DangerBadge row={risk} compact />}
          {row.reasons.map((r) => (
            <span key={r} className={`reason-chip reason-chip-${r}`}>
              {REASON_LABEL[r]}
            </span>
          ))}
          {band && band.sessionRegime && (
            <span className="band-chip" title={bandChipTitle(band)}>
              <span className="band-chip-regime">{REGIME_LABEL[band.sessionRegime] ?? band.sessionRegime}</span>
              {volScalar != null && volScalar !== 1 && (
                <span className="band-chip-vol">{volScalar.toFixed(1)}×</span>
              )}
            </span>
          )}
          <NewsChip news={row.news} />
          <HitRate hitRate={row.hitRate} />
          <FactorFlags tailwinds={tailwindCount} headwinds={headwindCount} />
          <button
            type="button"
            className="why-btn"
            title="Why this row"
            aria-label="Why this row"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onWhy();
            }}
          >
            <IconInfoCircle size={14} stroke={1.75} />
          </button>
        </div>
      </div>
      <div className="watchlist-item-right">
        <PriceFlicker
          price={row.price}
          todayChangePct={row.todayChangePct}
          format={formatCurrency}
          className="watchlist-item-price"
        />
        {row.todayChangePct != null && (
          <span className={`watchlist-item-change pnl-${row.todayChangePct > 0.1 ? 'gain' : row.todayChangePct < -0.1 ? 'loss' : 'neutral'}`}>
            {formatSignedPercent(row.todayChangePct)}
          </span>
        )}
        {row.source && <span className="watchlist-item-src">{row.source}</span>}
      </div>
    </div>
  );
}

// Today's news lean (Batch X7). Renders only a directional chip for a
// bullish/bearish read; neutral news adds no chip (it's noise). The top headline
// is the title tooltip — the full text isn't on the flag payload server-side.
function NewsChip({ news }: { news: VirtualRow['news'] }) {
  if (!news || news.label === 'neutral') return null;
  const arrow = news.label === 'bullish' ? '▲' : '▼';
  return (
    <span
      className={`news-chip news-chip-${news.label}`}
      title={news.headline ?? `News skews ${news.label} (${news.score.toFixed(2)})`}
    >
      news {arrow}
    </span>
  );
}

// Factor-flag counts (Batch X12) — a 🟢 tailwind / 🔴 headwind tally rolling up
// every for/against signal on the row. The full itemised list lives in the
// why-sheet (the ⓘ); this is just the at-a-glance balance. Renders nothing when
// the row has no classified factors either way.
function FactorFlags({ tailwinds, headwinds }: { tailwinds: number; headwinds: number }) {
  if (tailwinds === 0 && headwinds === 0) return null;
  return (
    <span className="factor-flags">
      {tailwinds > 0 && (
        <span className="factor-flag factor-flag-tail" title={`${tailwinds} tailwind${tailwinds === 1 ? '' : 's'}`}>
          🟢{tailwinds}
        </span>
      )}
      {headwinds > 0 && (
        <span className="factor-flag factor-flag-head" title={`${headwinds} headwind${headwinds === 1 ? '' : 's'}`}>
          🔴{headwinds}
        </span>
      )}
    </span>
  );
}

// Rolling-30d hit-rate. Shows `%` + sample size when there are graded fires;
// a plain "—" when none exist yet (genuinely-absent, not zero — most names
// won't have a forward-tracked fire until the engine has run for weeks).
function HitRate({ hitRate }: { hitRate: VirtualRow['hitRate'] }) {
  if (!hitRate) {
    return (
      <span className="hit-rate hit-rate-empty" title="No forward-tracked fires in the last 30 days">
        —
      </span>
    );
  }
  const pct = Math.round(hitRate.pct);
  const tier = pct >= 60 ? 'good' : pct >= 40 ? 'ok' : 'low';
  return (
    <span className={`hit-rate hit-rate-${tier}`} title={`Rolling-30d hit-rate · ${hitRate.sample} fire${hitRate.sample === 1 ? '' : 's'} graded`}>
      {pct}%<span className="hit-rate-n"> n{hitRate.sample}</span>
    </span>
  );
}
