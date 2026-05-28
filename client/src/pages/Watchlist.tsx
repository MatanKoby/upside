import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconSettings, IconCloudDownload } from '@tabler/icons-react';
import { useWatchlistData, type WatchlistList, type WatchlistItem, type QuoteRow } from '../hooks/useWatchlistData';
import { apiFetch } from '../services/supabase';
import { formatCurrency } from '../utils/formatters';

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
  const { lists, itemsByList, quotesByConid, isLoading } = useWatchlistData();
  const [settingsOpen, setSettingsOpen] = useState(false);
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
          />
        </>
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

function ItemList({
  items,
  quotes,
}: {
  items: WatchlistItem[];
  quotes: Record<number, QuoteRow>;
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
        return (
          <li key={it.id}>
            <button
              type="button"
              className="watchlist-item"
              onClick={() => navigate(`/ticker/${encodeURIComponent(it.symbol)}`)}
            >
              <span className="watchlist-item-sym">{it.symbol}</span>
              <span className="watchlist-item-price">
                {price != null ? formatCurrency(price) : '—'}
                {source && <span className="watchlist-item-src"> · {source}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
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
