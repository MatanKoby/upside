// /api/watchlist-markers (Batch A2, re-keyed in migration 016).
//
// Markers are now per (user_id, conid) — see migration 016. The same ticker
// across multiple lists shares one set of markers; CRUD operates by conid.
// Reads go through Supabase Realtime + RLS (auth.uid() = user_id).
// supabase() bypasses RLS, so writes explicitly stamp user_id from the JWT.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { supabase } from '../services/supabase.js';

const router = Router();
router.use(requireAuth);

const CONDITIONS = ['at_or_above', 'at_or_below', 'about'] as const;
type Condition = (typeof CONDITIONS)[number];

interface CreatePayload {
  conid?: unknown;
  label?: unknown;
  price?: unknown;
  condition?: unknown;
  cooldown_hours?: unknown;
}

function parseCreate(body: CreatePayload): {
  ok: true;
  row: { conid: number; label: string | null; price: number; condition: Condition; cooldown_hours: number };
} | { ok: false; error: string } {
  const conid = typeof body.conid === 'number' ? body.conid : Number(body.conid);
  const priceRaw = typeof body.price === 'number' ? body.price : Number(body.price);
  const condition = typeof body.condition === 'string' && (CONDITIONS as readonly string[]).includes(body.condition)
    ? (body.condition as Condition)
    : null;
  const cdRaw = body.cooldown_hours;
  const cooldown_hours = typeof cdRaw === 'number' && Number.isFinite(cdRaw) && cdRaw > 0
    ? Math.round(cdRaw)
    : 24;
  const label = typeof body.label === 'string' && body.label.trim().length > 0 ? body.label.trim() : null;

  if (!Number.isFinite(conid) || conid <= 0) return { ok: false, error: 'conid required' };
  if (!Number.isFinite(priceRaw) || priceRaw <= 0) return { ok: false, error: 'price must be > 0' };
  if (!condition) return { ok: false, error: `condition must be one of ${CONDITIONS.join('|')}` };
  return { ok: true, row: { conid, label, price: priceRaw, condition, cooldown_hours } };
}

async function ownsMarker(userId: string, markerId: string): Promise<boolean> {
  const { data } = await supabase()
    .from('watchlist_markers')
    .select('user_id')
    .eq('id', markerId)
    .maybeSingle();
  return data?.user_id === userId;
}

router.post('/', async (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'unauthorized' }); return; }
  const parsed = parseCreate(req.body ?? {});
  if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
  // We trust the JWT's user.id and stamp user_id ourselves — supabase()
  // bypasses RLS, so we don't get the policy's user_id check for free.
  const ins = await supabase()
    .from('watchlist_markers')
    .insert({ ...parsed.row, user_id: req.user.id })
    .select('id, user_id, conid, label, price, condition, enabled, cooldown_hours, last_fired_at, created_at')
    .single();
  if (ins.error || !ins.data) {
    res.status(500).json({ error: ins.error?.message ?? 'insert failed' });
    return;
  }
  res.status(201).json(ins.data);
});

router.patch('/:id', async (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'unauthorized' }); return; }
  const id = req.params.id!;
  if (!(await ownsMarker(req.user.id, id))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const body = (req.body ?? {}) as Partial<CreatePayload & { enabled?: unknown }>;
  const update: Record<string, unknown> = {};
  if (typeof body.label === 'string') update.label = body.label.trim() || null;
  if (body.label === null) update.label = null;
  if (typeof body.price === 'number' && body.price > 0) update.price = body.price;
  if (typeof body.condition === 'string' && (CONDITIONS as readonly string[]).includes(body.condition)) {
    update.condition = body.condition;
  }
  if (typeof body.enabled === 'boolean') update.enabled = body.enabled;
  if (typeof body.cooldown_hours === 'number' && Number.isFinite(body.cooldown_hours) && body.cooldown_hours > 0) {
    update.cooldown_hours = Math.round(body.cooldown_hours);
  }
  if (Object.keys(update).length === 0) { res.status(400).json({ error: 'no_valid_fields' }); return; }
  const upd = await supabase()
    .from('watchlist_markers')
    .update(update)
    .eq('id', id)
    .select('id, user_id, conid, label, price, condition, enabled, cooldown_hours, last_fired_at, created_at')
    .single();
  if (upd.error || !upd.data) {
    res.status(500).json({ error: upd.error?.message ?? 'update failed' });
    return;
  }
  res.json(upd.data);
});

router.delete('/:id', async (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'unauthorized' }); return; }
  const id = req.params.id!;
  if (!(await ownsMarker(req.user.id, id))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const del = await supabase().from('watchlist_markers').delete().eq('id', id);
  if (del.error) { res.status(500).json({ error: del.error.message }); return; }
  res.status(204).end();
});

export default router;
