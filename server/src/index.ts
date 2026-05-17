import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { env } from './env.js';
import authRoutes from './routes/auth.js';
import portfolioRoutes from './routes/portfolio.js';
import marketdataRoutes from './routes/marketdata.js';
import signalRoutes from './routes/signals.js';
import healthRoutes from './routes/health.js';
import { startSignalRunner } from './cron/signalRunner.js';
import { startKeepalive } from './cron/keepalive.js';
import { startPricePoller } from './cron/pricePoller.js';
import { startTunnelWatcher } from './services/tunnelWatcher.js';
import { notifyError, notifyCritical } from './services/notify.js';

// Top-level safety net — anything thrown async without a catch lands here.
// Notify Discord (if configured) and keep running; let the platform decide
// whether to restart based on the type of error.
process.on('unhandledRejection', (reason) => {
  void notifyCritical('process.unhandledRejection', 'unhandled promise rejection', reason);
});
process.on('uncaughtException', (err) => {
  void notifyCritical('process.uncaughtException', 'uncaught exception', err);
});

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use('/healthz', healthRoutes);

app.use('/api/auth', authRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/marketdata', marketdataRoutes);
app.use('/api/signals', signalRoutes);

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  void notifyError(`http.${req.method}.${req.path}`, err.message ?? 'internal error', err);
  res.status(500).json({ error: err.message || 'internal error' });
});

app.listen(env.port, () => {
  console.log(`[upside] listening on :${env.port} (${env.nodeEnv})`);
  startSignalRunner();
  startKeepalive();
  startPricePoller();
  startTunnelWatcher();
});
