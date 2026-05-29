// Add / edit / delete a marker sheet (Batch A2). Used by the Watchlist page
// for long-press → add and tap-on-chip → edit. Dip-buy (at_or_below) is
// the default condition since that's the only one with a wired Discord
// channel in this batch; the others are accepted so the UI is ready when
// their channels land.

import { useState, type FormEvent } from 'react';
import { apiFetch } from '../../services/supabase';
import type { Marker } from '../../hooks/useWatchlistData';

const CONDITIONS: Array<{ value: Marker['condition']; label: string }> = [
  { value: 'at_or_below', label: 'at_or_below (dip-buy — sends Discord ping)' },
  { value: 'at_or_above', label: 'at_or_above (target — Discord channel pending)' },
  { value: 'about',       label: 'about (level proximity — Discord channel pending)' },
];

export interface MarkerPrefill {
  price?: number;
  condition?: Marker['condition'];
  label?: string;
}

export function MarkerSheet({
  symbol,
  itemId,
  marker,
  prefill,
  onClose,
}: {
  symbol: string;
  itemId: string;
  marker?: Marker;
  // When in create mode (`marker` undefined), seeds the form. Used by the
  // entry-zone "promote to marker" flow so a one-tap converts a computed
  // zone into a user-owned marker.
  prefill?: MarkerPrefill;
  onClose: () => void;
}) {
  const editing = marker != null;
  const [label, setLabel] = useState(marker?.label ?? prefill?.label ?? '');
  const [price, setPrice] = useState(
    marker ? String(marker.price) : prefill?.price != null ? String(prefill.price) : '',
  );
  const [condition, setCondition] = useState<Marker['condition']>(
    marker?.condition ?? prefill?.condition ?? 'at_or_below',
  );
  const [cooldown, setCooldown] = useState(String(marker?.cooldown_hours ?? 24));
  const [enabled, setEnabled] = useState(marker?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      setErr('Price must be a positive number.');
      setBusy(false);
      return;
    }
    const cdNum = Number(cooldown);
    const body = {
      ...(editing ? {} : { item_id: itemId }),
      label: label.trim() || null,
      price: priceNum,
      condition,
      cooldown_hours: Number.isFinite(cdNum) && cdNum > 0 ? Math.round(cdNum) : 24,
      ...(editing ? { enabled } : {}),
    };
    const res = await apiFetch(
      editing ? `/api/watchlist-markers/${encodeURIComponent(marker!.id)}` : '/api/watchlist-markers',
      {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    setBusy(false);
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { error?: string };
      setErr(errBody.error ?? `Save failed (${res.status})`);
      return;
    }
    onClose();
  }

  async function remove() {
    if (!editing) return;
    if (!confirm('Delete this marker?')) return;
    setBusy(true);
    const res = await apiFetch(`/api/watchlist-markers/${encodeURIComponent(marker!.id)}`, { method: 'DELETE' });
    setBusy(false);
    if (!res.ok) {
      setErr(`Delete failed (${res.status})`);
      return;
    }
    onClose();
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-header">
          <h2>{editing ? 'Edit marker' : 'Add marker'} · {symbol}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </header>

        <form className="sheet-section" onSubmit={submit}>
          <label className="sheet-field">
            <span>Label (optional)</span>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. earnings dip"
            />
          </label>

          <label className="sheet-field">
            <span>Price</span>
            <input
              type="number"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="e.g. 135.00"
              required
            />
          </label>

          <label className="sheet-field">
            <span>Condition</span>
            <select value={condition} onChange={(e) => setCondition(e.target.value as Marker['condition'])}>
              {CONDITIONS.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </label>

          <label className="sheet-field">
            <span>Cooldown (hours)</span>
            <input
              type="number"
              min="1"
              step="1"
              value={cooldown}
              onChange={(e) => setCooldown(e.target.value)}
            />
          </label>

          {editing && (
            <label className="sheet-field-inline">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <span>Enabled</span>
            </label>
          )}

          {err && <p className="sheet-error">{err}</p>}

          <div className="sheet-actions">
            {editing && (
              <button type="button" className="btn btn-danger" disabled={busy} onClick={remove}>
                Delete
              </button>
            )}
            <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save' : 'Add marker'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
