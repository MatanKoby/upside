// Runtime app config the FE can read + change without a redeploy. Currently:
// the active LLM provider/model (stored in app_config; keys stay in .env).
// Auth-gated to whitelisted emails like every route.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { availableProviders, defaultModelFor } from '../services/llm.js';
import { getLlmSelection, setLlmSelection } from '../services/llmConfig.js';

const router = Router();
router.use(requireAuth);

function llmState(provider: string, model: string | null) {
  return {
    provider,
    model,
    defaultModel: defaultModelFor(provider),
    available: availableProviders(),
  };
}

router.get('/llm', async (_req: Request, res: Response) => {
  const sel = await getLlmSelection();
  res.json(llmState(sel.provider, sel.model));
});

router.post('/llm', async (req: Request, res: Response) => {
  const { provider, model } = req.body ?? {};
  if (!provider || typeof provider !== 'string') {
    res.status(400).json({ error: 'provider required' });
    return;
  }
  if (model != null && typeof model !== 'string') {
    res.status(400).json({ error: 'model must be a string' });
    return;
  }
  try {
    const sel = await setLlmSelection(provider, model);
    res.json(llmState(sel.provider, sel.model));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

export default router;
