import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
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

// Reverse proxy: /ib-portal/* → https://ib-gateway:5000/*
// User-facing IB authentication runs through this — they hit
// `<tunnel>/ib-portal/` in an iframe (or new tab fallback) and complete
// IB's own browser login flow. Credentials never touch our code; the
// gateway holds the session. See UPSIDE_MVP_SPEC.md → "IB Authentication Flow".
//
// Mounted before express.json() so the proxy gets raw request bodies; the
// JSON middleware would otherwise consume the stream and break POSTs.
app.use(
  '/ib-portal',
  createProxyMiddleware({
    target: env.ibGatewayUrl,
    changeOrigin: true,
    secure: false, // gateway uses a self-signed cert
    pathRewrite: { '^/ib-portal': '' },
    ws: true,
    on: {
      proxyRes: (proxyRes) => {
        // Strip headers that would block embedding our iframe.
        delete proxyRes.headers['x-frame-options'];
        const csp = proxyRes.headers['content-security-policy'];
        if (typeof csp === 'string') {
          proxyRes.headers['content-security-policy'] = csp
            .split(';')
            .filter((d) => !d.trim().toLowerCase().startsWith('frame-ancestors'))
            .join(';');
        }
      },
    },
  }),
);

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
