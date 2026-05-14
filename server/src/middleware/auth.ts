import type { Request, Response, NextFunction } from 'express';
import { env } from '../env.js';
import { supabase } from '../services/supabase.js';

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }

  const { data, error } = await supabase().auth.getUser(token);
  if (error || !data?.user) {
    res.status(401).json({ error: 'invalid token' });
    return;
  }

  const email = (data.user.email ?? '').toLowerCase();
  if (!email || !env.allowedEmails.includes(email)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  req.user = { id: data.user.id, email };
  next();
}
