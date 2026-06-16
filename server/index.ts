import express from 'express';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import { config, validateConfig } from './config.js';
import { getDb, closeDb } from './db/index.js';
import { apiRouter } from './routes/api.js';
import { authRouter } from './routes/auth.js';
import { studioRouter } from './routes/studio.js';
import { authMiddleware, handleLogin, handleAuthCheck } from './studio/auth.js';
import { getOrCreateCert } from './cert.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

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

// Startup
async function start(): Promise<void> {
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

  const httpServer = app.listen(config.port, () => {
    console.log(`[server] Local Multistream running at http://localhost:${config.port}`);
  });

  // Start HTTPS server for platforms that require SSL redirect URIs (e.g. Facebook)
  const cert = await getOrCreateCert();
  const httpsServer = https.createServer({ key: cert.private, cert: cert.cert }, app).listen(config.httpsPort, () => {
    console.log(`[server] HTTPS server running at https://localhost:${config.httpsPort}`);
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
