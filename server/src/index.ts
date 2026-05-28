import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { env } from './env.js';
import authRoutes from './routes/auth.js';
import portfolioRoutes from './routes/portfolio.js';
import marketdataRoutes from './routes/marketdata.js';
import signalRoutes from './routes/signals.js';
import configRoutes from './routes/config.js';
import healthRoutes from './routes/health.js';
import debugRoutes from './routes/debug.js';
import watchlistsRoutes from './routes/watchlists.js';
import watchlistMarkersRoutes from './routes/watchlist-markers.js';
import { startLockCleanup } from './cron/lockCleanup.js';
import { startKeepalive } from './cron/keepalive.js';
import { startIbPricePoller } from './cron/ibPricePoller.js';
import { startFinnhubPricePoller } from './cron/finnhubPricePoller.js';
import { startWatchlistQuotePoller } from './cron/watchlistQuotePoller.js';
import { startZoneGapCleanup } from './cron/zoneGapCleanup.js';
import { startMetricsRetention } from './cron/metricsRetention.js';
import { startTunnelWatcher } from './services/tunnelWatcher.js';
import { notifyError, notifyCritical } from './services/notify.js';

// Top-level safety net — anything thrown async without a catch lands here.
// Notify Discord (if configured) and keep running; let the platform decide
// whether to restart based on the type of error.
// IB gateway is intentionally down between on-demand sessions, so a poller
// call that rejects with a connection error to it is expected — route those to
// the routine channel so #errors-critical stays signal, not noise.
function isIbGatewayUnreachable(reason: unknown): boolean {
  const s = reason instanceof Error ? reason.message : String(reason);
  return /EAI_AGAIN|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/.test(s) && /ib-gateway|:5000/.test(s);
}
process.on('unhandledRejection', (reason) => {
  if (isIbGatewayUnreachable(reason)) {
    void notifyError('ib.gateway_unreachable', 'IB gateway unreachable (expected while disconnected)', reason);
  } else {
    void notifyCritical('process.unhandledRejection', 'unhandled promise rejection', reason);
  }
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
app.use('/api/config', configRoutes);
app.use('/api/debug', debugRoutes);
app.use('/api/watchlists', watchlistsRoutes);
app.use('/api/watchlist-markers', watchlistMarkersRoutes);

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  void notifyError(`http.${req.method}.${req.path}`, err.message ?? 'internal error', err);
  res.status(500).json({ error: err.message || 'internal error' });
});

app.listen(env.port, () => {
  console.log(`[upside] listening on :${env.port} (${env.nodeEnv})`);
  startLockCleanup();
  startKeepalive();
  startIbPricePoller();
  startFinnhubPricePoller();
  startWatchlistQuotePoller();
  startZoneGapCleanup();
  startTunnelWatcher();
  startMetricsRetention();
});
