// Full-screen IB reconnect prompt — replaces the entire UI when IB session is
// expired. Renders the credential form per spec (autocomplete attrs so the
// browser password manager handles it).
//
// In Batch 9 this is the lightweight version: simple form, basic submit, no
// fancy "waiting for 2FA approval" animation yet (Batch 16 polish).

import { useState } from 'react';
import { apiFetch } from '../../services/supabase';

interface Props {
  onReconnected: () => void;
}

export function IBReconnectBlock({ onReconnected }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/auth/ib/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Login failed (${res.status})`);
        return;
      }
      onReconnected();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="ib-reconnect-block">
      <h1 className="ph-logo">Upside</h1>
      <p className="ib-reconnect-message">Your IB session has expired</p>
      <form className="ib-reconnect-form" onSubmit={onSubmit}>
        <input
          type="text"
          name="username"
          autoComplete="username"
          placeholder="IB username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          autoFocus
        />
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="IB password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button type="submit" disabled={submitting || !username || !password}>
          {submitting ? 'Connecting…' : 'Reconnect'}
        </button>
        {error && <div className="ib-reconnect-error">{error}</div>}
      </form>
      <p className="ib-reconnect-help">
        Approve the 2FA push on your IB Key phone app after submitting.
      </p>
    </div>
  );
}
