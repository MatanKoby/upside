import type { VirtualKind } from '../../config/virtualList';
import { type EntryTemp, type Factor, TEMP_META } from '../../utils/entryTemperature';

// Per-row "why" sheet (Batch X12). One tap on a virtual-list row's ⓘ opens this:
// the entry-temperature verdict in plain language, then the 🟢 tailwinds /
// 🔴 headwinds itemised, then the rank context. The contextual complement to the
// static Glossary. See spec/screens/watchlist.md → Reading a row.

export function WhySheet({
  symbol,
  kind,
  temp,
  reason,
  tailwinds,
  headwinds,
  rankDrivers,
  rank,
  total,
  onClose,
}: {
  symbol: string;
  kind: VirtualKind;
  temp: EntryTemp;
  reason: string;
  tailwinds: Factor[];
  headwinds: Factor[];
  rankDrivers: { label: string; value: number }[];
  rank: number;
  total: number;
  onClose: () => void;
}) {
  const meta = TEMP_META[temp];
  const listName = kind === 'intraday' ? 'Intraday' : 'Swing';

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet why-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-header">
          <h2>
            {symbol} <span className="why-sheet-sub">· why</span>
          </h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className={`why-verdict why-verdict-${temp}`}>
          <span className="why-verdict-glyph">{meta.glyph || '•'}</span>
          <div className="why-verdict-text">
            <div className="why-verdict-label">{meta.label}</div>
            <div className="why-verdict-reason">{reason}</div>
          </div>
        </div>

        <FactorSection title="Tailwinds" tone="tail" factors={tailwinds} />
        <FactorSection title="Headwinds" tone="head" factors={headwinds} />

        <section className="sheet-section why-rank">
          <h3>Rank</h3>
          <p className="why-rank-line">
            #{rank} of {total} on {listName}
            {rankDrivers.length > 0 ? ` · ranks mainly on ${rankDrivers[0].label}` : ''}.
          </p>
        </section>
      </div>
    </div>
  );
}

function FactorSection({ title, tone, factors }: { title: string; tone: 'tail' | 'head'; factors: Factor[] }) {
  if (factors.length === 0) return null;
  const dot = tone === 'tail' ? '🟢' : '🔴';
  return (
    <section className={`sheet-section why-factors why-factors-${tone}`}>
      <h3>
        {dot} {title} ({factors.length})
      </h3>
      <ul className="why-factor-list">
        {factors.map((f, i) => (
          <li key={i}>
            <span className="why-factor-label">{f.label}</span>
            {f.detail && <span className="why-factor-detail"> · {f.detail}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
