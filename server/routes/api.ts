import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import { getDb, getSetting, setSetting } from '../db/index.js';
import { DEFAULT_REMINDER_SETTINGS, REMINDER_SETTINGS_KEY, type ReminderSettings } from '../stream/reminders.js';
import { planSwap, swapRefusalReason, type SwappableStream } from '../stream/swapPolicy.js';
import type { StreamMetadataChange } from '../stream/manager.js';
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
  // Default Facebook reminders ON; only an explicit 'false'/'0' opts out.
  const fbReminders = req.body.fb_reminders_enabled === 'false' || req.body.fb_reminders_enabled === '0' ? 0 : 1;
  // Test streams are strictly opt-IN — the default must always be a real broadcast, so only an
  // explicit 'true'/'1' makes one private.
  const isTest = req.body.is_test === 'true' || req.body.is_test === '1' ? 1 : 0;

  db.prepare(`
    INSERT INTO streams (id, series_id, name, description, thumbnail_path, scheduled_start, fb_reminders_enabled, is_test, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
  `).run(id, series_id ?? null, name, description ?? null, thumbnail_path, scheduled_start ? parseInt(scheduled_start) : null, fbReminders, isTest, Date.now());

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
  if (req.body.fb_reminders_enabled !== undefined) {
    updates.push('fb_reminders_enabled = ?');
    values.push(req.body.fb_reminders_enabled === 'false' || req.body.fb_reminders_enabled === '0' ? 0 : 1);
  }

  if (updates.length > 0) {
    values.push(id);
    db.prepare(`UPDATE streams SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  // Sync changes out to the destinations that already exist for this stream, and re-sync the
  // scheduled Facebook announcement posts when the details that feed them change (or the reminders
  // toggle flips). Already-published posts are left as-is.
  const updated = db.prepare('SELECT * FROM streams WHERE id = ?').get(id) as unknown as Stream;

  const { syncStreamMetadata } = await import('../stream/manager.js');
  const change: StreamMetadataChange = {
    resyncReminders: name !== undefined || description !== undefined
      || scheduled_start !== undefined || req.body.fb_reminders_enabled !== undefined,
  };
  if (name !== undefined) change.name = name as string;
  if (description !== undefined) change.description = description as string;
  if (scheduled_start !== undefined) change.scheduledStart = scheduled_start ? parseInt(scheduled_start as string) : null;
  if (thumbnail_path !== undefined) change.thumbnailPath = thumbnail_path;

  const syncWarnings = await syncStreamMetadata(id, change);

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
      } else if (ps.platform === 'facebook') {
        const { deleteFacebookLiveVideo, deletePagePost } = await import('../platforms/facebook.js');
        if (ps.broadcast_id) await deleteFacebookLiveVideo(ps.broadcast_id);
        // Also remove any announcement posts created at setup (the event is being cancelled, so
        // pull them whether or not they've published yet).
        const posts = ps.extra_json ? (JSON.parse(ps.extra_json) as { announcement_posts?: Array<{ id: string }> }).announcement_posts : undefined;
        for (const post of posts ?? []) await deletePagePost(post.id);
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

  // Map each uploaded thumbnail to its entry. The client sends only real images plus a parallel
  // `thumbnail_indices` array (append order → entry index). Falls back to positional mapping if the
  // index array is absent, e.g. a client that uploads one file per entry.
  let thumbnailIndices: number[] = [];
  if (typeof req.body.thumbnail_indices === 'string') {
    try { thumbnailIndices = JSON.parse(req.body.thumbnail_indices); } catch { /* leave empty */ }
  }
  const thumbnailByEntry = new Map<number, string>();
  files.forEach((file, i) => {
    const entryIdx = thumbnailIndices.length ? thumbnailIndices[i] : i;
    if (typeof entryIdx === 'number') thumbnailByEntry.set(entryIdx, `/uploads/${file.filename}`);
  });

  const insertStmt = db.prepare(`
    INSERT INTO streams (id, series_id, name, description, thumbnail_path, scheduled_start, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)
  `);

  const created: Stream[] = [];
  const now = Date.now();

  // node:sqlite's DatabaseSync has no better-sqlite3-style transaction() helper, so drive the
  // transaction manually — all-or-nothing so a mid-batch failure doesn't leave a partial series.
  db.exec('BEGIN');
  try {
    streamEntries.forEach((entry, i) => {
      const id = nanoid();
      const thumbnail = thumbnailByEntry.get(i) ?? null;
      insertStmt.run(id, seriesId, entry.name, entry.description ?? null, thumbnail, entry.scheduled_start ?? null, now);
      created.push(db.prepare('SELECT * FROM streams WHERE id = ?').get(id) as unknown as Stream);
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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

/**
 * Swap the CONTENT of two events, leaving their dates where they are.
 *
 * Name, description and thumbnail trade places; the schedule, the series, the per-event Facebook
 * reminder toggle and the platform destinations all stay put. The existing YouTube broadcast and
 * Facebook live video are re-titled in place (they keep their ids and their scheduled times), and
 * each event's still-pending Facebook announcement posts are recreated from its new details.
 *
 * Typically used within a series when the running order of topics changes, but it deliberately
 * doesn't require the two events to share a series — any two editable events will swap.
 */
apiRouter.post('/streams/:id/swap', async (req: Request, res: Response) => {
  const db = getDb();
  const id = param(req, 'id');
  const otherId = typeof req.body?.other_id === 'string' ? req.body.other_id : '';
  if (!otherId) {
    res.status(400).json({ error: 'other_id is required' });
    return;
  }

  const get = (streamId: string) =>
    db.prepare('SELECT * FROM streams WHERE id = ?').get(streamId) as unknown as Stream | undefined;
  const a = get(id);
  const b = get(otherId);
  if (!a || !b) {
    res.status(404).json({ error: 'Stream not found' });
    return;
  }

  const refusal = swapRefusalReason(a as SwappableStream, b as SwappableStream);
  if (refusal) {
    res.status(400).json({ error: refusal });
    return;
  }

  const assignments = planSwap(a as SwappableStream, b as SwappableStream);

  // All-or-nothing: a half-applied swap would leave two events sharing one title.
  const updateStmt = db.prepare('UPDATE streams SET name = ?, description = ?, thumbnail_path = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const next of assignments) {
      updateStmt.run(next.name, next.description, next.thumbnail_path, next.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  const logStmt = db.prepare('INSERT INTO event_log (stream_id, platform, event, detail, ts) VALUES (?, ?, ?, ?, ?)');
  const { syncStreamMetadata } = await import('../stream/manager.js');
  const syncWarnings: string[] = [];

  for (const next of assignments) {
    const before = next.id === a.id ? a : b;
    logStmt.run(next.id, null, 'content_swapped', `"${before.name}" → "${next.name}" (with ${next.id === a.id ? b.id : a.id})`, Date.now());

    const warnings = await syncStreamMetadata(next.id, {
      name: next.name,
      description: next.description,
      thumbnailPath: next.thumbnail_path,
      resyncReminders: true,
    });

    // YouTube's API can set a custom thumbnail but not remove one, so an event that swaps in a
    // blank thumbnail keeps the old image on YouTube. Say so rather than let it go unnoticed.
    if (before.thumbnail_path && !next.thumbnail_path) {
      const hasYouTube = db
        .prepare("SELECT 1 FROM platform_streams WHERE stream_id = ? AND platform = 'youtube' AND status = 'created'")
        .get(next.id);
      if (hasYouTube) {
        warnings.push('youtube: the other event has no thumbnail, and YouTube cannot remove a custom thumbnail — the previous image is still on the broadcast');
      }
    }

    syncWarnings.push(...warnings.map((w) => `${next.name}: ${w}`));
  }

  const streams = assignments.map((next) => get(next.id));
  const response: Record<string, unknown> = { streams };
  if (syncWarnings.length > 0) response.sync_warnings = syncWarnings;
  res.json(response);
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

// --- Settings: Facebook reminder schedule ---

apiRouter.get('/settings/reminders', (_req: Request, res: Response) => {
  res.json(getSetting<ReminderSettings>(REMINDER_SETTINGS_KEY) ?? DEFAULT_REMINDER_SETTINGS);
});

apiRouter.put('/settings/reminders', (req: Request, res: Response) => {
  const body = req.body as ReminderSettings;
  if (typeof body?.enabled !== 'boolean' || typeof body?.timezone !== 'string'
    || typeof body?.site !== 'string' || !Array.isArray(body?.rules)) {
    res.status(400).json({ error: 'Invalid reminder settings' });
    return;
  }
  setSetting(REMINDER_SETTINGS_KEY, body);
  res.json(body);
});

// Per-platform auth health — go-live pre-check and the live "reconnect" controls both read this.
apiRouter.get('/auth/health', async (_req: Request, res: Response) => {
  const { getPlatformAuthHealth } = await import('../stream/manager.js');
  res.json(await getPlatformAuthHealth());
});

// Per-platform INGEST health while live — what each platform says it is actually receiving, which
// is a different question from whether our FFmpeg process is alive. Empty when not monitoring.
apiRouter.get('/streams/:id/health', async (req: Request, res: Response) => {
  const { getStreamHealth } = await import('../stream/healthMonitor.js');
  res.json(getStreamHealth(param(req, 'id')));
});

// Retry a single platform mid-broadcast (after reconnecting its auth). Leaves the stream live and
// the other platforms' legs untouched.
apiRouter.post('/streams/:id/live/:platform/retry', async (req: Request, res: Response) => {
  try {
    const { retryPlatformLive } = await import('../stream/manager.js');
    await retryPlatformLive(param(req, 'id'), param(req, 'platform') as 'youtube' | 'facebook' | 'twitch');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

apiRouter.post('/streams/:id/go-live', async (req: Request, res: Response) => {
  try {
    const { goLive } = await import('../stream/manager.js');
    // `force` acknowledges the auth pre-flight warning and goes live on the healthy platforms.
    await goLive(param(req, 'id'), { force: req.body?.force === true });
    res.json({ ok: true });
  } catch (err) {
    const { AuthPreflightError } = await import('../stream/manager.js');
    if (err instanceof AuthPreflightError) {
      // 409: the request was well-formed but the platform state blocks it. `overridable` tells the UI
      // whether to offer "Go Live Anyway" at all — for a definitively dead login it must not, since
      // force won't bypass it server-side either.
      res.status(409).json({
        error: err.message,
        code: 'auth_preflight',
        platforms: err.platforms,
        overridable: err.overridable,
      });
      return;
    }
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

apiRouter.get('/auth/youtube/channel', async (_req: Request, res: Response) => {
  try {
    const { getYouTubeChannelInfo } = await import('../platforms/youtube.js');
    res.json(await getYouTubeChannelInfo());
  } catch {
    res.json(null);
  }
});

apiRouter.get('/auth/twitch/channel', async (_req: Request, res: Response) => {
  const { getTwitchChannelInfo } = await import('../auth/twitch.js');
  res.json(getTwitchChannelInfo());
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

// --- SSE ---

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

