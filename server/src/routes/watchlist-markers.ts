// /api/watchlist-markers (Batch A2) — CRUD for user-defined price markers
// attached to a watchlist_items row. Reads go via Supabase Realtime + RLS;
// no GET endpoint here. The server-side supabase() client uses service_role
// (bypasses RLS), so we explicitly validate ownership via the item → list →
// user_id chain before any insert/update/delete.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { supabase } from '../services/supabase.js';

const router = Router();
router.use(requireAuth);

const CONDITIONS = ['at_or_above', 'at_or_below', 'about'] as const;
type Condition = (typeof CONDITIONS)[number];

interface CreatePayload {
  item_id?: unknown;
  label?: unknown;
  price?: unknown;
  condition?: unknown;
  cooldown_hours?: unknown;
}

function parseCreate(body: CreatePayload): {
  ok: true;
  row: { item_id: string; label: string | null; price: number; condition: Condition; cooldown_hours: number };
} | { ok: false; error: string } {
  const item_id = typeof body.item_id === 'string' ? body.item_id : null;
  const priceRaw = typeof body.price === 'number' ? body.price : Number(body.price);
  const condition = typeof body.condition === 'string' && (CONDITIONS as readonly string[]).includes(body.condition)
    ? (body.condition as Condition)
    : null;
  const cdRaw = body.cooldown_hours;
  const cooldown_hours = typeof cdRaw === 'number' && Number.isFinite(cdRaw) && cdRaw > 0
    ? Math.round(cdRaw)
    : 24;
  const label = typeof body.label === 'string' && body.label.trim().length > 0 ? body.label.trim() : null;

  if (!item_id) return { ok: false, error: 'item_id required' };
  if (!Number.isFinite(priceRaw) || priceRaw <= 0) return { ok: false, error: 'price must be > 0' };
  if (!condition) return { ok: false, error: `condition must be one of ${CONDITIONS.join('|')}` };
  return { ok: true, row: { item_id, label, price: priceRaw, condition, cooldown_hours } };
}

async function ownsItem(userId: string, itemId: string): Promise<boolean> {
  const { data } = await supabase()
    .from('watchlist_items')
    .select('id, watchlist_lists!inner(user_id)')
    .eq('id', itemId)
    .maybeSingle();
  if (!data) return false;
  const lists = (data as { watchlist_lists?: { user_id?: string } | { user_id?: string }[] }).watchlist_lists;
  const owner = Array.isArray(lists) ? lists[0]?.user_id : lists?.user_id;
  return owner === userId;
}

async function ownsMarker(userId: string, markerId: string): Promise<boolean> {
  const { data } = await supabase()
    .from('watchlist_markers')
    .select('item_id')
    .eq('id', markerId)
    .maybeSingle();
  if (!data?.item_id) return false;
  return ownsItem(userId, data.item_id as string);
}

router.post('/', async (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: 'unauthorized' }); return; }
  const parsed = parseCreate(req.body ?? {});
  if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
  if (!(await ownsItem(req.user.id, parsed.row.item_id))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const ins = await supabase()
    .from('watchlist_markers')
    .insert(parsed.row)
    .select('id, item_id, label, price, condition, enabled, cooldown_hours, last_fired_at, created_at')
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
    .select('id, item_id, label, price, condition, enabled, cooldown_hours, last_fired_at, created_at')
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
