import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconSettings, IconCloudDownload, IconHelpCircle } from '@tabler/icons-react';
import { useWatchlistData, type WatchlistList, type WatchlistItem, type QuoteRow, type Marker, type EntryZoneRow, type Horizon, type IntradayStatsRow } from '../hooks/useWatchlistData';
import { MarkerSheet, type MarkerPrefill } from '../components/Watchlist/MarkerSheet';
import { VirtualList } from '../components/Watchlist/VirtualList';
import type { VirtualKind } from '../config/virtualList';
import { MiniSparkline } from '../components/Watchlist/MiniSparkline';
import { EntryZoneCluster } from '../components/Watchlist/EntryZoneCluster';
import { IntradayStatsChip } from '../components/Watchlist/IntradayStatsChip';
import { Glossary } from '../components/Watchlist/Glossary';
import { PriceFlicker } from '../components/common/PriceFlicker';
import { DangerBadge } from '../components/primitives/DangerBadge';
import { useAllRiskFlags } from '../hooks/useRiskFlags';
import { useLongPress } from '../hooks/useLongPress';
import { openRobinhood } from '../utils/robinhood';
import type { RiskFlagRow } from '../utils/riskFlags';
import { apiFetch } from '../services/supabase';
import { formatCurrency, formatSignedPercent } from '../utils/formatters';

interface MarkerSheetState {
  symbol: string;
  conid: number;
  marker?: Marker;
  prefill?: MarkerPrefill;
}

// Watchlist screen (Batch A1). Per-list active/hidden lives in the in-screen
// gear-icon sheet (`<SettingsSheet>` below); only active lists render as
// sub-tabs. Tap a row → TickerDetail (which works for non-held tickers).
//
// Markers + entry-zone chips come in A2 / A+.

interface ImportResult {
  imported: number;
  newLists: number;
  totalItems: number;
}

const TAB_STORAGE_KEY = 'upside_watchlist_tab';
function readStoredTab(): string {
  try {
    return localStorage.getItem(TAB_STORAGE_KEY) ?? 'virtual:intraday';
  } catch {
    return 'virtual:intraday';
  }
}

async function postSync(): Promise<{ ok: boolean; reason?: string; result?: ImportResult; status: number }> {
  const res = await apiFetch('/api/watchlists/sync', { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as { reason?: string; imported?: number; newLists?: number; totalItems?: number };
  if (res.status === 200 && typeof body.imported === 'number') {
    return {
      ok: true,
      result: { imported: body.imported, newLists: body.newLists ?? 0, totalItems: body.totalItems ?? 0 },
      status: res.status,
    };
  }
  return { ok: false, reason: body.reason, status: res.status };
}

async function patchActive(listId: string, active: boolean): Promise<boolean> {
  const res = await apiFetch(`/api/watchlists/${encodeURIComponent(listId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active }),
  });
  return res.ok;
}

export default function Watchlist() {
  const { lists, itemsByList, quotesByConid, markersByConid, entryZonesByConid, statsByConid, isLoading } = useWatchlistData();
  const { byConid: riskByConid } = useAllRiskFlags();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [markerSheet, setMarkerSheet] = useState<MarkerSheetState | null>(null);
  // Selected sub-tab: a virtual list (`virtual:intraday` / `virtual:swing`) or
  // an imported list id. The two virtual tabs are always present and lead the
  // strip, so Intraday is the default landing tab. Persisted to localStorage so
  // a refresh keeps you on the tab you were viewing (a stale imported-list id
  // falls back gracefully via the currentList resolution below).
  const [selectedKey, setSelectedKey] = useState<string>(readStoredTab);
  const pickTab = (key: string) => {
    setSelectedKey(key);
    try {
      localStorage.setItem(TAB_STORAGE_KEY, key);
    } catch {
      // localStorage unavailable (private mode etc.) — selection just won't persist.
    }
  };
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const activeLists = useMemo(() => lists.filter((l) => l.active), [lists]);

  const virtualKind: VirtualKind | null = selectedKey === 'virtual:intraday'
    ? 'intraday'
    : selectedKey === 'virtual:swing'
      ? 'swing'
      : null;

  // For an imported-list selection, resolve to a valid active list (the
  // selected one may have just been hidden); fall back to the first active.
  const currentList = virtualKind
    ? null
    : (activeLists.find((l) => l.id === selectedKey)?.id ?? activeLists[0]?.id ?? null);

  async function runSync() {
    setSyncing(true);
    setSyncMessage(null);
    const r = await postSync();
    setSyncing(false);
    if (r.ok && r.result) {
      if (r.result.imported === 0) {
        // Honest copy when the route succeeded but there was nothing to
        // import — the BE also notifies #errors with the IB top-level shape
        // (see services/watchlists.ts) so we can diagnose why.
        setSyncMessage('IB returned 0 user lists. Check IBKR Mobile → Watchlists to confirm you have lists there.');
      } else {
        setSyncMessage(`Imported ${r.result.imported} list${r.result.imported === 1 ? '' : 's'} (${r.result.totalItems} tickers).`);
      }
    } else if (r.status === 403 && r.reason === 'ib_required') {
      setSyncMessage('Connect IB to import watchlists.');
    } else {
      setSyncMessage(`Sync failed (${r.status}).`);
    }
  }

  return (
    <div className="watchlist-page">
      <header className="watchlist-header">
        <h1>Watchlist</h1>
        <div className="watchlist-header-actions">
          <button
            type="button"
            className="icon-btn"
            aria-label="Glossary"
            onClick={() => setGlossaryOpen(true)}
          >
            <IconHelpCircle size={20} stroke={1.5} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Watchlist settings"
            onClick={() => setSettingsOpen(true)}
          >
            <IconSettings size={20} stroke={1.5} />
          </button>
        </div>
      </header>

      {isLoading ? (
        <p className="watchlist-empty">Loading…</p>
      ) : (
        <>
          <SubTabStrip lists={activeLists} selectedKey={selectedKey} onPick={pickTab} />
          {lists.length === 0 && <ImportHint syncing={syncing} message={syncMessage} onSync={runSync} />}
          {virtualKind ? (
            <VirtualList
              kind={virtualKind}
              riskByConid={riskByConid}
              onAddMarker={(row) =>
                setMarkerSheet({
                  symbol: row.symbol,
                  conid: row.conid,
                  prefill: {
                    price: row.band?.lowBand ?? undefined,
                    condition: 'at_or_below',
                    label: 'from walking band',
                  },
                })
              }
            />
          ) : currentList ? (
            <ItemList
              items={itemsByList[currentList] ?? []}
              quotes={quotesByConid}
              markersByConid={markersByConid}
              entryZonesByConid={entryZonesByConid}
              statsByConid={statsByConid}
              riskByConid={riskByConid}
              onAddMarker={(item) => setMarkerSheet({ symbol: item.symbol, conid: Number(item.conid) })}
              onEditMarker={(item, marker) => setMarkerSheet({ symbol: item.symbol, conid: Number(item.conid), marker })}
              onPromoteZone={(item, zone) =>
                setMarkerSheet({
                  symbol: item.symbol,
                  conid: Number(item.conid),
                  prefill: {
                    price: zone.price,
                    condition: 'at_or_below',
                    label: `from ${zone.horizon} entry zone`,
                  },
                })
              }
            />
          ) : (
            <NoActiveLists onOpenSettings={() => setSettingsOpen(true)} />
          )}
        </>
      )}

      {markerSheet && (
        <MarkerSheet
          symbol={markerSheet.symbol}
          conid={markerSheet.conid}
          marker={markerSheet.marker}
          prefill={markerSheet.prefill}
          onClose={() => setMarkerSheet(null)}
        />
      )}

      {glossaryOpen && <Glossary onClose={() => setGlossaryOpen(false)} />}

      {settingsOpen && (
        <SettingsSheet
          lists={lists}
          syncing={syncing}
          syncMessage={syncMessage}
          onClose={() => setSettingsOpen(false)}
          onSync={runSync}
        />
      )}
    </div>
  );
}

// Slim banner under the strip when the user has no imported lists yet. The
// virtual tabs (Intraday / Swing) still render above it, so the screen is never
// blank — this just keeps the first-run "Import from IB" CTA discoverable.
function ImportHint({ syncing, message, onSync }: { syncing: boolean; message: string | null; onSync: () => void }) {
  return (
    <div className="watchlist-import-hint">
      <span>No imported watchlists yet.</span>
      <button type="button" className="btn btn-primary btn-sm" disabled={syncing} onClick={onSync}>
        <IconCloudDownload size={14} stroke={1.5} />{' '}
        {syncing ? 'Importing…' : 'Import from IB'}
      </button>
      {message && <p className="watchlist-empty-msg">{message}</p>}
    </div>
  );
}

function NoActiveLists({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="watchlist-empty">
      <p>No watchlists active.</p>
      <p className="watchlist-empty-msg">
        Tap the gear icon to choose which imported lists to track. Hidden lists are not polled.
      </p>
      <button type="button" className="btn" onClick={onOpenSettings}>Open settings</button>
    </div>
  );
}

const VIRTUAL_TABS: Array<{ key: string; label: string }> = [
  { key: 'virtual:intraday', label: 'Intraday ✨' },
  { key: 'virtual:swing', label: 'Swing ✨' },
];

function SubTabStrip({
  lists,
  selectedKey,
  onPick,
}: {
  lists: WatchlistList[];
  selectedKey: string;
  onPick: (key: string) => void;
}) {
  return (
    <nav className="watchlist-tabstrip">
      {/* Two Upside-curated virtual tabs always lead the strip (can't be
          hidden), then one tab per active imported list. */}
      {VIRTUAL_TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          className={`watchlist-tab watchlist-tab-virtual ${t.key === selectedKey ? 'is-active' : ''}`}
          onClick={() => onPick(t.key)}
        >
          {t.label}
        </button>
      ))}
      {lists.map((l) => (
        <button
          key={l.id}
          type="button"
          className={`watchlist-tab ${l.id === selectedKey ? 'is-active' : ''}`}
          onClick={() => onPick(l.id)}
        >
          {l.name}
        </button>
      ))}
    </nav>
  );
}

const CONDITION_GLYPH: Record<Marker['condition'], string> = {
  at_or_below: '↓',
  at_or_above: '↑',
  about:        '≈',
};

function ItemList({
  items,
  quotes,
  markersByConid,
  entryZonesByConid,
  statsByConid,
  riskByConid,
  onAddMarker,
  onEditMarker,
  onPromoteZone,
}: {
  items: WatchlistItem[];
  quotes: Record<number, QuoteRow>;
  markersByConid: Record<number, Marker[]>;
  entryZonesByConid: Record<number, Partial<Record<Horizon, EntryZoneRow>>>;
  statsByConid: Record<number, IntradayStatsRow>;
  riskByConid: Map<number, RiskFlagRow>;
  onAddMarker: (item: WatchlistItem) => void;
  onEditMarker: (item: WatchlistItem, marker: Marker) => void;
  onPromoteZone: (item: WatchlistItem, zone: EntryZoneRow & { horizon: Horizon }) => void;
}) {
  const navigate = useNavigate();
  if (items.length === 0) {
    return <p className="watchlist-empty-msg">No tickers in this list.</p>;
  }
  return (
    <ul className="watchlist-items">
      {items.map((it) => {
        const q = quotes[Number(it.conid)];
        const price = q?.canonical_price ?? null;
        const source = q?.canonical_source ?? null;
        const markers = markersByConid[Number(it.conid)] ?? [];
        const zones = entryZonesByConid[Number(it.conid)] ?? {};
        const stats = statsByConid[Number(it.conid)];
        const risk = riskByConid.get(Number(it.conid)) ?? null;
        return (
          <li key={it.id}>
            <ItemRow
              item={it}
              price={price}
              source={source}
              todayChangePct={q?.today_change_pct ?? null}
              todayOpen={q?.today_open ?? null}
              sparklineCloses={q?.sparkline_closes ?? null}
              markers={markers}
              zones={zones}
              stats={stats}
              risk={risk}
              onTap={() => navigate(`/ticker/${encodeURIComponent(it.symbol)}`)}
              onLongPress={() => onAddMarker(it)}
              onEditMarker={(m) => onEditMarker(it, m)}
              onPromoteZone={(zoneRow, horizon) => onPromoteZone(it, { ...zoneRow, horizon })}
            />
          </li>
        );
      })}
    </ul>
  );
}

const LONG_PRESS_MS = 500;

function ItemRow({
  item,
  price,
  source,
  todayChangePct,
  todayOpen,
  sparklineCloses,
  markers,
  zones,
  stats,
  risk,
  onTap,
  onLongPress,
  onEditMarker,
  onPromoteZone,
}: {
  item: WatchlistItem;
  price: number | null;
  source: 'ib' | 'finnhub' | null;
  todayChangePct: number | null;
  todayOpen: number | null;
  sparklineCloses: number[] | null;
  markers: Marker[];
  zones: Partial<Record<Horizon, EntryZoneRow>>;
  stats: IntradayStatsRow | undefined;
  risk: RiskFlagRow | null;
  onTap: () => void;
  onLongPress: () => void;
  onEditMarker: (m: Marker) => void;
  onPromoteZone: (zone: EntryZoneRow, horizon: Horizon) => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  const symbolPress = useLongPress(() => openRobinhood(item.symbol));

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

  return (
    <div
      className="watchlist-item"
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
          <span className="watchlist-item-sym ticker-symbol-pressable" title="Long-press → Robinhood" {...symbolPress}>
            {item.symbol}
          </span>
          {item.company_name && (
            <span className="watchlist-item-co" title={item.company_name}>
              {item.company_name}
            </span>
          )}
        </div>
        {sparklineCloses && sparklineCloses.length >= 2 && (
          <div className="watchlist-item-spark">
            <MiniSparkline closes={sparklineCloses} />
          </div>
        )}
        {/* Chip cluster: user markers (left) + engine zone (right) on the same
            vertical line. Uses margin-left: auto so the whole group floats to
            the right edge of the main flex (just inside the absolute price
            column's reserved space). flex-wrap allows graceful overflow if a
            row has many markers. */}
        <div className="watchlist-item-chip-cluster">
          {risk && <DangerBadge row={risk} compact />}
          {markers.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`marker-chip ${m.enabled ? '' : 'is-disabled'} marker-chip-${m.condition}`}
              onClick={(e) => {
                e.stopPropagation();
                onEditMarker(m);
              }}
              title={m.label ?? m.condition}
            >
              <span className="marker-chip-cond">{CONDITION_GLYPH[m.condition]}</span>
              <span className="marker-chip-price">${m.price}</span>
              {m.label && <span className="marker-chip-label">· {m.label}</span>}
            </button>
          ))}
          <EntryZoneCluster
            zones={zones}
            onPromote={(z) => onPromoteZone(z, z.horizon)}
          />
          <IntradayStatsChip stats={stats} price={price} todayOpen={todayOpen} />
        </div>
      </div>
      {/* Right column is absolutely positioned so price always sits in the
          same spot regardless of left-side content length. */}
      <div className="watchlist-item-right">
        <PriceFlicker
          price={price}
          todayChangePct={todayChangePct}
          format={formatCurrency}
          className="watchlist-item-price"
        />

        {todayChangePct != null && (
          <span className={`watchlist-item-change pnl-${todayChangePct > 0.1 ? 'gain' : todayChangePct < -0.1 ? 'loss' : 'neutral'}`}>
            {formatSignedPercent(todayChangePct)}
          </span>
        )}
        {source && <span className="watchlist-item-src">{source}</span>}
      </div>
    </div>
  );
}

function SettingsSheet({
  lists,
  syncing,
  syncMessage,
  onClose,
  onSync,
}: {
  lists: WatchlistList[];
  syncing: boolean;
  syncMessage: string | null;
  onClose: () => void;
  onSync: () => void;
}) {
  const [pending, setPending] = useState<Set<string>>(new Set());

  async function toggle(id: string, next: boolean) {
    setPending((p) => new Set(p).add(id));
    await patchActive(id, next);
    // The realtime sub on watchlist_lists will refresh `lists` automatically;
    // we just clear the pending marker.
    setPending((p) => {
      const n = new Set(p);
      n.delete(id);
      return n;
    });
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-header">
          <h2>Watchlist settings</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </header>

        <section className="sheet-section">
          <h3>Imported lists</h3>
          {lists.length === 0 ? (
            <p className="watchlist-empty-msg">No lists imported yet.</p>
          ) : (
            <ul className="sheet-list">
              {lists.map((l) => (
                <li key={l.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={l.active}
                      disabled={pending.has(l.id)}
                      onChange={(e) => void toggle(l.id, e.target.checked)}
                    />
                    <span>{l.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="sheet-section">
          <button type="button" className="btn" disabled={syncing} onClick={onSync}>
            {syncing ? 'Re-importing…' : 'Re-import from IB'}
          </button>
          {syncMessage && <p className="watchlist-empty-msg">{syncMessage}</p>}
        </section>
      </div>
    </div>
  );
}
