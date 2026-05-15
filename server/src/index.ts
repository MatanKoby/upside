import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { env } from './env.js';
import authRoutes from './routes/auth.js';
import portfolioRoutes from './routes/portfolio.js';
import marketdataRoutes from './routes/marketdata.js';
import signalRoutes from './routes/signals.js';
import { startSignalRunner } from './cron/signalRunner.js';
import { startKeepalive } from './cron/keepalive.js';
import { startPricePoller } from './cron/pricePoller.js';
import { startTunnelWatcher } from './services/tunnelWatcher.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req: Request, res: Response) => {
  res.json({ ok: true, env: env.nodeEnv });
});

app.use('/api/auth', authRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/marketdata', marketdataRoutes);
app.use('/api/signals', signalRoutes);

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[error]', err);
  res.status(500).json({ error: err.message || 'internal error' });
});

app.listen(env.port, () => {
  console.log(`[upside] listening on :${env.port} (${env.nodeEnv})`);
  startSignalRunner();
  startKeepalive();
  startPricePoller();
  startTunnelWatcher();
});
