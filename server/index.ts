import express from 'express';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { config, validateConfig } from './config.js';
import { getDb, closeDb } from './db/index.js';
import { apiRouter } from './routes/api.js';
import { authRouter } from './routes/auth.js';
import { studioRouter } from './routes/studio.js';
import { authMiddleware, handleLogin, handleAuthCheck } from './studio/auth.js';
import { getOrCreateCert } from './cert.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// Behind a reverse proxy / Cloudflare Tunnel, honor forwarding headers so the per-IP login limiter
// keys on the real client IP rather than the proxy's. Off by default — enabling it when NOT proxied
// would let clients spoof their IP. See TRUST_PROXY in config.ts.
if (config.trustProxy !== null) {
  app.set('trust proxy', config.trustProxy);
}

// Request logging for API/auth calls: method, path, status, duration. Static assets and the SPA
// shell are skipped to keep the log focused on meaningful activity. 5xx logs at error level.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/auth')) return next();
  const started = Date.now();
  res.on('finish', () => {
    const line = `[http] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`;
    if (res.statusCode >= 500) console.error(line);
    else console.log(line);
  });
  next();
});

// Middleware
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// Auth endpoints (before auth middleware so they're accessible)
app.post('/api/auth/login', handleLogin);
app.get('/api/auth/check', handleAuthCheck);

// Auth middleware for all API routes (skipped if APP_SECRET is empty)
app.use('/api', authMiddleware);

// API routes
app.use('/api', apiRouter);
app.use('/auth', authRouter);
app.use('/api/studio', studioRouter);

// Serve React app in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => {
  // Only serve the SPA shell for client routes (extensionless paths). A missing static file
  // (anything with an extension) must 404 — otherwise an HTML body can get cached under a
  // .css/.js URL and silently break styling/scripts.
  if (path.extname(req.path)) {
    res.status(404).end();
    return;
  }
  res.sendFile(path.join(clientDist, 'index.html'));
});

// Central error handler — must be last. Logs the failure with request context and returns clean
// JSON instead of Express's default HTML 500. Also maps multer upload rejections to 400s so a bad
// thumbnail (too large / wrong type) reads as a clear client error rather than a server crash.
const errorHandler: express.ErrorRequestHandler = (err, req, res, next) => {
  let status = 500;
  let message = err?.message || 'Internal server error';
  if (err?.code === 'LIMIT_FILE_SIZE') { status = 400; message = 'Image too large (max 2MB per file)'; }
  else if (/only jpeg and png/i.test(message)) { status = 400; }

  console.error(`[error] ${req.method} ${req.originalUrl} → ${status}: ${message}`);
  if (status >= 500 && err?.stack) console.error(err.stack);

  if (res.headersSent) { next(err); return; }
  res.status(status).json({ error: message });
};
app.use(errorHandler);

// Best-effort build identity so a restart's logs make it obvious which code is live.
function gitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return 'unknown';
  }
}

// Startup
async function start(): Promise<void> {
  console.log(`[server] Booting ${new Date().toISOString()} | node ${process.version} | commit ${gitCommit()} | NODE_ENV=${process.env.NODE_ENV ?? 'development'}`);

  validateConfig();
  getDb(); // Initialize database

  // Reconcile any streams left 'live' by a crash/restart — no FFmpeg survives a restart,
  // so a leftover 'live' row is stale and would otherwise block all future go-lives.
  const { reconcileLiveStreams } = await import('./stream/manager.js');
  reconcileLiveStreams();

  // Check FFmpeg availability
  try {
    const ffmpegPath = (await import('ffmpeg-static')).default;
    console.log(`[ffmpeg] Binary found at: ${ffmpegPath}`);
  } catch {
    console.warn('[ffmpeg] ffmpeg-static not available. FFmpeg is required for go-live.');
  }

  // Start RTMP server
  const { startRtmpServer } = await import('./rtmp/server.js');
  startRtmpServer();

  // BIND_HOST empty → bind all interfaces (omit host); '127.0.0.1' → local-only (the hardened
  // Cloudflare-tunnel default). Passing host: undefined to listen() binds all interfaces.
  const host = config.bindHost || undefined;
  const shownHost = host ?? 'localhost';

  const httpServer = app.listen({ port: config.port, host }, () => {
    console.log(`[server] Local Multistream running at http://${shownHost}:${config.port}`);
  });

  // Start HTTPS server for platforms that require SSL redirect URIs (e.g. Facebook)
  const cert = await getOrCreateCert();
  const httpsServer = https
    .createServer({ key: cert.private, cert: cert.cert }, app)
    .listen({ port: config.httpsPort, host }, () => {
      console.log(`[server] HTTPS server running at https://${shownHost}:${config.httpsPort}`);
    });

  // Initialize studio WebSocket on both servers
  const { initStudioWebSocket } = await import('./studio/ingest.js');
  initStudioWebSocket(httpServer, httpsServer);
}

// Graceful shutdown
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return; // ignore repeated signals
  shuttingDown = true;
  console.log('\n[server] Shutting down...');

  // End any live stream first so platform broadcasts aren't left dangling. Capped with a
  // timeout so a slow or hung platform API can't block shutdown indefinitely.
  try {
    const { endLiveStreamsForShutdown } = await import('./stream/manager.js');
    await Promise.race([
      endLiveStreamsForShutdown(),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
  } catch (err) {
    console.error('[server] Error ending live streams on shutdown:', err);
  }

  try {
    const { killAll } = await import('./fanout/ffmpeg.js');
    await killAll();
  } catch { /* not initialized */ }
  try {
    const { shutdownStudio } = await import('./studio/ingest.js');
    await shutdownStudio();
  } catch { /* not initialized */ }
  closeDb();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch((err) => {
  console.error('[server] Failed to start:', err);
  process.exit(1);
});
