import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import type { Stream, PlatformStream } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Helper to safely extract a string param from Express route params
function param(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

const upload = multer({
  dest: path.join(__dirname, '..', '..', 'uploads'),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG and PNG images are allowed'));
    }
  },
});

export const apiRouter = Router();

// --- Stream CRUD ---

apiRouter.get('/streams', (_req: Request, res: Response) => {
  const db = getDb();
  const streams = db.prepare('SELECT * FROM streams ORDER BY created_at DESC').all() as unknown as Stream[];
  res.json(streams);
});

apiRouter.post('/streams', upload.single('thumbnail'), (req: Request, res: Response) => {
  const db = getDb();
  const id = nanoid();
  const { name, description, scheduled_start, series_id } = req.body;
  const thumbnail_path = req.file ? `/uploads/${req.file.filename}` : null;

  db.prepare(`
    INSERT INTO streams (id, series_id, name, description, thumbnail_path, scheduled_start, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)
  `).run(id, series_id ?? null, name, description ?? null, thumbnail_path, scheduled_start ? parseInt(scheduled_start) : null, Date.now());

  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(id) as unknown as Stream;
  res.status(201).json(stream);
});

apiRouter.get('/streams/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = param(req, 'id');
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(id) as unknown as Stream | undefined;
  if (!stream) {
    res.status(404).json({ error: 'Stream not found' });
    return;
  }

  const platformStreams = db.prepare('SELECT * FROM platform_streams WHERE stream_id = ?').all(id) as unknown as PlatformStream[];
  const events = db.prepare('SELECT * FROM event_log WHERE stream_id = ? ORDER BY ts DESC LIMIT 50').all(id);

  res.json({ ...stream, platforms: platformStreams, events });
});

apiRouter.patch('/streams/:id', upload.single('thumbnail'), async (req: Request, res: Response) => {
  const db = getDb();
  const id = param(req, 'id');
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(id) as unknown as Stream | undefined;
  if (!stream) {
    res.status(404).json({ error: 'Stream not found' });
    return;
  }
  if (stream.status !== 'draft' && stream.status !== 'ready') {
    res.status(400).json({ error: 'Can only edit draft or ready streams' });
    return;
  }

  const { name, description, scheduled_start } = req.body;
  const thumbnail_path = req.file ? `/uploads/${req.file.filename}` : undefined;

  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (name !== undefined) { updates.push('name = ?'); values.push(name as string); }
  if (description !== undefined) { updates.push('description = ?'); values.push(description as string); }
  if (scheduled_start !== undefined) { updates.push('scheduled_start = ?'); values.push(scheduled_start ? parseInt(scheduled_start as string) : null); }
  if (thumbnail_path !== undefined) { updates.push('thumbnail_path = ?'); values.push(thumbnail_path); }

  if (updates.length > 0) {
    values.push(id);
    db.prepare(`UPDATE streams SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  // Sync changes to YouTube/Facebook if platform_streams exist with 'created' status
  const updated = db.prepare('SELECT * FROM streams WHERE id = ?').get(id) as unknown as Stream;
  const platformStreams = db.prepare("SELECT * FROM platform_streams WHERE stream_id = ? AND status = 'created'").all(id) as unknown as PlatformStream[];

  const syncWarnings: string[] = [];

  for (const ps of platformStreams) {
    try {
      if (ps.platform === 'youtube' && ps.broadcast_id) {
        const { updateYouTubeBroadcast } = await import('../platforms/youtube.js');
        await updateYouTubeBroadcast(
          ps.broadcast_id,
          name as string | undefined,
          description as string | undefined,
          scheduled_start !== undefined ? (scheduled_start ? parseInt(scheduled_start as string) : null) : undefined,
        );
        // Re-upload thumbnail if changed
        if (thumbnail_path) {
          const { google } = await import('googleapis');
          const { getYouTubeAuth } = await import('../auth/youtube.js');
          const auth = getYouTubeAuth();
          if (auth) {
            const yt = google.youtube({ version: 'v3', auth });
            const { readFileSync } = await import('fs');
            const fullPath = path.join(__dirname, '..', '..', thumbnail_path);
            const body = readFileSync(fullPath);
            await yt.thumbnails.set({ videoId: ps.broadcast_id, media: { body } });
          }
        }
      } else if (ps.platform === 'facebook' && ps.broadcast_id) {
        const { updateFacebookLiveVideo } = await import('../platforms/facebook.js');
        await updateFacebookLiveVideo(
          ps.broadcast_id,
          name as string | undefined,
          description as string | undefined,
        );
      }
      // Twitch: just update locally (applied at go-live)
    } catch (err) {
      syncWarnings.push(`${ps.platform}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const response: Record<string, unknown> = { ...updated };
  if (syncWarnings.length > 0) {
    response.sync_warnings = syncWarnings;
  }
  res.json(response);
});

apiRouter.delete('/streams/:id', async (req: Request, res: Response) => {
  const db = getDb();
  const id = param(req, 'id');
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(id) as unknown as Stream | undefined;
  if (!stream) {
    res.status(404).json({ error: 'Stream not found' });
    return;
  }
  if (stream.status !== 'draft' && stream.status !== 'ready') {
    res.status(400).json({ error: 'Can only delete draft or ready streams' });
    return;
  }

  // Cancel YouTube broadcast + delete Facebook live video if platform_streams exist
  const platformStreams = db.prepare('SELECT * FROM platform_streams WHERE stream_id = ?').all(id) as unknown as PlatformStream[];

  for (const ps of platformStreams) {
    try {
      if (ps.platform === 'youtube' && ps.broadcast_id) {
        const { deleteYouTubeBroadcast } = await import('../platforms/youtube.js');
        await deleteYouTubeBroadcast(ps.broadcast_id);
      } else if (ps.platform === 'facebook' && ps.broadcast_id) {
        const { deleteFacebookLiveVideo } = await import('../platforms/facebook.js');
        await deleteFacebookLiveVideo(ps.broadcast_id);
      }
    } catch (err) {
      console.warn(`[api] Failed to cleanup ${ps.platform} broadcast:`, err);
    }
  }

  db.prepare('DELETE FROM streams WHERE id = ?').run(id);
  res.status(204).end();
});

// --- Series ---

apiRouter.post('/series', upload.array('thumbnails', 20), (req: Request, res: Response) => {
  const db = getDb();
  const seriesId = nanoid();
  const { streams: streamsJson } = req.body;
  const files = (req.files as Express.Multer.File[]) ?? [];

  let streamEntries: Array<{ name: string; description?: string; scheduled_start?: number }>;
  try {
    streamEntries = JSON.parse(streamsJson);
  } catch {
    res.status(400).json({ error: 'Invalid streams JSON' });
    return;
  }

  const insertStmt = db.prepare(`
    INSERT INTO streams (id, series_id, name, description, thumbnail_path, scheduled_start, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)
  `);

  const created: Stream[] = [];
  const now = Date.now();

  // DatabaseSync.transaction() exists at runtime but isn't in the type defs yet
  const transaction = (db as unknown as { transaction: (fn: () => void) => () => void }).transaction;
  const insertAll = transaction(() => {
    streamEntries.forEach((entry, i) => {
      const id = nanoid();
      const thumbnail = files[i] ? `/uploads/${files[i].filename}` : null;
      insertStmt.run(id, seriesId, entry.name, entry.description ?? null, thumbnail, entry.scheduled_start ?? null, now);
      created.push(db.prepare('SELECT * FROM streams WHERE id = ?').get(id) as unknown as Stream);
    });
  });

  insertAll();
  res.status(201).json({ series_id: seriesId, streams: created });
});

apiRouter.get('/series/:seriesId', (req: Request, res: Response) => {
  const db = getDb();
  const seriesId = param(req, 'seriesId');
  const streams = db.prepare('SELECT * FROM streams WHERE series_id = ? ORDER BY scheduled_start ASC').all(seriesId) as unknown as Stream[];
  if (streams.length === 0) {
    res.status(404).json({ error: 'Series not found' });
    return;
  }
  res.json({ series_id: seriesId, streams });
});

// --- Setup & Go Live ---

apiRouter.post('/streams/:id/setup', async (req: Request, res: Response) => {
  try {
    const { setupStream } = await import('../stream/manager.js');
    const result = await setupStream(param(req, 'id'));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

apiRouter.post('/streams/:id/setup/:platform', async (req: Request, res: Response) => {
  try {
    const { setupSinglePlatform } = await import('../stream/manager.js');
    await setupSinglePlatform(param(req, 'id'), param(req, 'platform') as 'youtube' | 'facebook' | 'twitch');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

apiRouter.post('/series/:seriesId/setup', async (req: Request, res: Response) => {
  try {
    const { setupStream } = await import('../stream/manager.js');
    const db = getDb();
    const seriesId = param(req, 'seriesId');
    const streams = db.prepare('SELECT id FROM streams WHERE series_id = ? ORDER BY scheduled_start ASC').all(seriesId) as unknown as Array<{ id: string }>;
    const results: Record<string, unknown> = {};
    for (const s of streams) {
      results[s.id] = await setupStream(s.id);
    }
    res.json(results);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

apiRouter.post('/streams/:id/go-live', async (req: Request, res: Response) => {
  try {
    const { goLive } = await import('../stream/manager.js');
    await goLive(param(req, 'id'));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

apiRouter.post('/streams/:id/end', async (req: Request, res: Response) => {
  try {
    const { endStream } = await import('../stream/manager.js');
    await endStream(param(req, 'id'));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- Auth status ---

apiRouter.get('/auth/status', (_req: Request, res: Response) => {
  const db = getDb();
  const creds = db.prepare('SELECT platform, access_token FROM credentials').all() as unknown as Array<{ platform: string; access_token: string | null }>;

  const status = {
    youtube: creds.some((c) => c.platform === 'youtube' && c.access_token),
    facebook: creds.some((c) => c.platform === 'facebook' && c.access_token),
    twitch: creds.some((c) => c.platform === 'twitch' && c.access_token),
  };

  res.json(status);
});

// --- Facebook page selection ---

apiRouter.get('/auth/facebook/pages', async (_req: Request, res: Response) => {
  try {
    const { getFacebookPages } = await import('../auth/facebook.js');
    const pages = await getFacebookPages();
    res.json(pages);
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

apiRouter.get('/auth/facebook/selected-page', async (_req: Request, res: Response) => {
  const { getSelectedFacebookPage } = await import('../auth/facebook.js');
  res.json(getSelectedFacebookPage());
});

apiRouter.post('/auth/facebook/page', async (req: Request, res: Response) => {
  try {
    const { page_id, page_name, access_token } = req.body;
    if (!page_id || !access_token) {
      res.status(400).json({ error: 'page_id and access_token required' });
      return;
    }
    const { selectFacebookPage } = await import('../auth/facebook.js');
    selectFacebookPage(page_id, page_name ?? '', access_token);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// --- Disconnect ---

apiRouter.post('/auth/disconnect/:platform', async (req: Request, res: Response) => {
  const platform = param(req, 'platform');
  try {
    if (platform === 'youtube') {
      const { disconnectYouTube } = await import('../auth/youtube.js');
      disconnectYouTube();
    } else if (platform === 'facebook') {
      const { disconnectFacebook } = await import('../auth/facebook.js');
      disconnectFacebook();
    } else if (platform === 'twitch') {
      const { disconnectTwitch } = await import('../auth/twitch.js');
      disconnectTwitch();
    } else {
      res.status(400).json({ error: 'Invalid platform' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// --- FFmpeg info ---

apiRouter.get('/ffmpeg/version', async (_req: Request, res: Response) => {
  try {
    const ffmpegPath = (await import('ffmpeg-static')).default as unknown as string;
    const { execSync } = await import('child_process');
    const version = execSync(`"${ffmpegPath}" -version`, { timeout: 5000 }).toString().split('\n')[0];
    res.json({ version, path: ffmpegPath });
  } catch {
    res.json({ version: null, path: null });
  }
});

// --- SSE & OBS status ---

apiRouter.get('/stream/events', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const { addSSEClient, removeSSEClient } = await import('../fanout/ffmpeg.js');
  addSSEClient(res);

  const heartbeat = setInterval(() => {
    res.write(':\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeSSEClient(res);
  });
});

apiRouter.get('/stream/obs-status', async (_req: Request, res: Response) => {
  const { isObsConnected } = await import('../rtmp/server.js');
  res.json({ connected: isObsConnected() });
});
