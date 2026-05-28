import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconSettings, IconCloudDownload } from '@tabler/icons-react';
import { useWatchlistData, type WatchlistList, type WatchlistItem, type QuoteRow, type Marker, type EntryZoneRow, type Horizon } from '../hooks/useWatchlistData';
import { MarkerSheet } from '../components/Watchlist/MarkerSheet';
import { apiFetch } from '../services/supabase';
import { formatCurrency } from '../utils/formatters';

interface MarkerSheetState {
  symbol: string;
  itemId: string;
  marker?: Marker;
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
  const { lists, itemsByList, quotesByConid, markersByItem, entryZonesByConid, isLoading } = useWatchlistData();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [markerSheet, setMarkerSheet] = useState<MarkerSheetState | null>(null);
  const [activeListId, setActiveListId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const activeLists = useMemo(() => lists.filter((l) => l.active), [lists]);

  // Default the visible sub-tab to the first active list whenever the active
  // set changes (e.g. after toggling one on/off).
  const currentList = activeListId && activeLists.find((l) => l.id === activeListId)
    ? activeListId
    : (activeLists[0]?.id ?? null);

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

  if (isLoading) {
    return <div className="watchlist-page"><p className="watchlist-empty">Loading…</p></div>;
  }

  return (
    <div className="watchlist-page">
      <header className="watchlist-header">
        <h1>Watchlist</h1>
        <button
          type="button"
          className="icon-btn"
          aria-label="Watchlist settings"
          onClick={() => setSettingsOpen(true)}
        >
          <IconSettings size={20} stroke={1.5} />
        </button>
      </header>

      {lists.length === 0 ? (
        <EmptyState syncing={syncing} message={syncMessage} onSync={runSync} />
      ) : activeLists.length === 0 ? (
        <NoActiveLists onOpenSettings={() => setSettingsOpen(true)} />
      ) : (
        <>
          <SubTabStrip lists={activeLists} currentId={currentList} onPick={setActiveListId} />
          <ItemList
            items={itemsByList[currentList ?? ''] ?? []}
            quotes={quotesByConid}
            markersByItem={markersByItem}
            entryZonesByConid={entryZonesByConid}
            onAddMarker={(item) => setMarkerSheet({ symbol: item.symbol, itemId: item.id })}
            onEditMarker={(item, marker) => setMarkerSheet({ symbol: item.symbol, itemId: item.id, marker })}
          />
        </>
      )}

      {markerSheet && (
        <MarkerSheet
          symbol={markerSheet.symbol}
          itemId={markerSheet.itemId}
          marker={markerSheet.marker}
          onClose={() => setMarkerSheet(null)}
        />
      )}

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

function EmptyState({ syncing, message, onSync }: { syncing: boolean; message: string | null; onSync: () => void }) {
  return (
    <div className="watchlist-empty">
      <p>You haven't imported any watchlists yet.</p>
      <button type="button" className="btn btn-primary" disabled={syncing} onClick={onSync}>
        <IconCloudDownload size={16} stroke={1.5} />{' '}
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

function SubTabStrip({
  lists,
  currentId,
  onPick,
}: {
  lists: WatchlistList[];
  currentId: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <nav className="watchlist-tabstrip">
      {lists.map((l) => (
        <button
          key={l.id}
          type="button"
          className={`watchlist-tab ${l.id === currentId ? 'is-active' : ''}`}
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
  markersByItem,
  entryZonesByConid,
  onAddMarker,
  onEditMarker,
}: {
  items: WatchlistItem[];
  quotes: Record<number, QuoteRow>;
  markersByItem: Record<string, Marker[]>;
  entryZonesByConid: Record<number, Partial<Record<Horizon, EntryZoneRow>>>;
  onAddMarker: (item: WatchlistItem) => void;
  onEditMarker: (item: WatchlistItem, marker: Marker) => void;
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
        const markers = markersByItem[it.id] ?? [];
        const zones = entryZonesByConid[Number(it.conid)] ?? {};
        return (
          <li key={it.id}>
            <ItemRow
              item={it}
              price={price}
              source={source}
              markers={markers}
              zones={zones}
              onTap={() => navigate(`/ticker/${encodeURIComponent(it.symbol)}`)}
              onLongPress={() => onAddMarker(it)}
              onEditMarker={(m) => onEditMarker(it, m)}
            />
          </li>
        );
      })}
    </ul>
  );
}

const LONG_PRESS_MS = 500;

const HORIZON_SHORT: Record<Horizon, string> = {
  intraday: 'I',
  overnight: 'O',
  multiday: 'M',
};

function ItemRow({
  item,
  price,
  source,
  markers,
  zones,
  onTap,
  onLongPress,
  onEditMarker,
}: {
  item: WatchlistItem;
  price: number | null;
  source: 'ib' | 'finnhub' | null;
  markers: Marker[];
  zones: Partial<Record<Horizon, EntryZoneRow>>;
  onTap: () => void;
  onLongPress: () => void;
  onEditMarker: (m: Marker) => void;
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
        <span className="watchlist-item-sym">{item.symbol}</span>
        <span className="watchlist-item-price">
          {price != null ? formatCurrency(price) : '—'}
          {source && <span className="watchlist-item-src"> · {source}</span>}
        </span>
      </div>
      {(markers.length > 0 || Object.keys(zones).length > 0) && (
        <div className="watchlist-item-chips">
          {(['intraday', 'overnight', 'multiday'] as Horizon[]).map((h) => {
            const z = zones[h];
            if (!z) return null;
            const tooltip = `${z.reasoning}${z.overbought_tightened ? ' · overbought-tightened' : ''} · trend: ${z.trend_regime} · confidence ${z.confidence}%`;
            return (
              <span
                key={h}
                className={`zone-chip zone-chip-${h}`}
                title={tooltip}
                onClick={(e) => e.stopPropagation()}
              >
                <span className="zone-chip-horizon">{HORIZON_SHORT[h]}</span>
                <span className="zone-chip-price">${z.price}</span>
              </span>
            );
          })}
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
        </div>
      )}
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
