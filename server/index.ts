import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { config, validateConfig } from './config.js';
import { getDb, closeDb } from './db/index.js';
import { apiRouter } from './routes/api.js';
import { authRouter } from './routes/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// Middleware
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// API routes
app.use('/api', apiRouter);
app.use('/auth', authRouter);

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

  app.listen(config.port, () => {
    console.log(`[server] Local Multistream running at http://localhost:${config.port}`);
  });
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
async function shutdown(): Promise<void> {
  console.log('\n[server] Shutting down...');
  try {
    const { killAll } = await import('./fanout/ffmpeg.js');
    killAll();
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
