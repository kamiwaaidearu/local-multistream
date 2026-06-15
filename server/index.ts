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
app.get('*', (_req, res) => {
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

  // Facebook auto-setup: check for pending events now within 7 days
  autoSetupPendingFacebookEvents().catch((err) =>
    console.warn('[server] Facebook auto-setup check failed:', err),
  );

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

/**
 * Auto-create Facebook live videos for pending events that are now within 7 days.
 */
async function autoSetupPendingFacebookEvents(): Promise<void> {
  const db = getDb();
  const pendingFb = db.prepare(`
    SELECT ps.*, s.name, s.description, s.scheduled_start
    FROM platform_streams ps
    JOIN streams s ON s.id = ps.stream_id
    WHERE ps.platform = 'facebook' AND ps.status = 'pending'
  `).all() as Array<{
    id: string; stream_id: string; scheduled_start: number | null;
    name: string; description: string | null;
  }>;

  if (pendingFb.length === 0) return;

  const now = Math.floor(Date.now() / 1000);
  const sevenDays = 7 * 24 * 60 * 60;

  let count = 0;
  for (const ps of pendingFb) {
    if (ps.scheduled_start && ps.scheduled_start - now <= sevenDays) {
      try {
        const { createFacebookLiveVideo } = await import('./platforms/facebook.js');
        const fb = await createFacebookLiveVideo(ps.name, ps.description, ps.scheduled_start);
        db.prepare(`
          UPDATE platform_streams SET broadcast_id = ?, rtmp_url = ?, status = 'created', error_message = NULL
          WHERE id = ?
        `).run(fb.liveVideoId, fb.streamUrl, ps.id);
        count++;
      } catch (err) {
        console.warn(`[server] Auto-setup failed for stream ${ps.stream_id}:`, err);
      }
    }
  }

  if (count > 0) {
    console.log(`[server] Auto-created ${count} Facebook live video(s) for upcoming events`);
  }
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
