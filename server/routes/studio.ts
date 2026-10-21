import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { isStudioConnected } from '../studio/ingest.js';
import { isRtmpPublishing } from '../rtmp/server.js';
import { resolveSourceStatus } from '../studio/sourceStatus.js';
import { getDb, DEFAULT_GRID_TEMPLATE } from '../db/index.js';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const overlayUpload = multer({
  dest: path.join(__dirname, '..', '..', 'uploads', 'overlays'),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB for overlay images
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
    }
  },
});

export const studioRouter = Router();

// --- Studio status ---

studioRouter.get('/status', (_req: Request, res: Response) => {
  // isRtmpPublishing() is true for BOTH sources (Studio's ingest publishes to the same RTMP key),
  // so the Studio WebSocket is the tiebreaker — see resolveSourceStatus.
  res.json(resolveSourceStatus(isStudioConnected(), isRtmpPublishing()));
});

// RTMP ingest details for the OBS panel — sourced from server config (RTMP_PORT / LOCAL_STREAM_KEY)
// so the UI always shows the real key/port and never drifts if the operator changes the stream key.
studioRouter.get('/ingest-info', (_req: Request, res: Response) => {
  res.json({ port: config.rtmpPort, streamKey: config.localStreamKey });
});

// --- Template CRUD (v1: single template) ---

studioRouter.get('/template', (_req: Request, res: Response) => {
  const db = getDb();
  const template = db.prepare('SELECT * FROM studio_templates WHERE is_default = 1').get() as Record<string, unknown> | undefined;
  if (!template) {
    res.status(404).json({ error: 'No template found' });
    return;
  }
  res.json({ ...template, config_json: JSON.parse(template.config_json as string) });
});

studioRouter.patch('/template/:id', (req: Request, res: Response) => {
  const db = getDb();
  const { name, config_json } = req.body;

  const id = req.params.id as string;
  const existing = db.prepare('SELECT * FROM studio_templates WHERE id = ?').get(id);
  if (!existing) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }

  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (name !== undefined) { updates.push('name = ?'); values.push(name as string); }
  if (config_json !== undefined) { updates.push('config_json = ?'); values.push(JSON.stringify(config_json)); }

  if (updates.length > 0) {
    values.push(id);
    db.prepare(`UPDATE studio_templates SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  const updated = db.prepare('SELECT * FROM studio_templates WHERE id = ?').get(id) as Record<string, unknown>;
  res.json({ ...updated, config_json: JSON.parse(updated.config_json as string) });
});

// --- Reset template to default ---

studioRouter.post('/template/reset', (_req: Request, res: Response) => {
  const db = getDb();
  db.prepare('UPDATE studio_templates SET config_json = ? WHERE id = ?')
    .run(JSON.stringify(DEFAULT_GRID_TEMPLATE), 'default');
  const updated = db.prepare('SELECT * FROM studio_templates WHERE id = ?').get('default') as Record<string, unknown>;
  res.json({ ...updated, config_json: JSON.parse(updated.config_json as string) });
});

// --- Overlay image upload ---

studioRouter.post('/overlay', overlayUpload.single('image'), (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No image uploaded' });
    return;
  }
  const url = `/uploads/overlays/${req.file.filename}`;
  res.json({ url, filename: req.file.filename });
});

// --- Leg-1 quality telemetry ---

/**
 * Record the browser-side (leg-1) encode settings the operator is actually using, plus the measured
 * upload bandwidth behind them.
 *
 * This exists because leg-1 quality lived ONLY in browser state. When the 2026-08-05 stream came out
 * low-bitrate, there was no way to answer "what was the browser encoding at, and what did the probe
 * measure?" — the numbers had never left the tab. Now they're in the log and the event log, so a
 * quality post-mortem is possible after the fact.
 */
studioRouter.post('/quality', (req: Request, res: Response) => {
  const { quality, videoBps, probeMbps, probeFailed } = (req.body ?? {}) as {
    quality?: string; videoBps?: number; probeMbps?: number | null; probeFailed?: boolean;
  };

  const measured = typeof probeMbps === 'number'
    ? `${probeMbps.toFixed(1)} Mbps measured`
    : probeFailed ? 'bandwidth probe FAILED — quality left at its default' : 'bandwidth not measured';
  const detail = `Leg-1 encode: ${quality ?? 'unknown'} (${videoBps ? Math.round(videoBps / 1000) : '?'} kbps) · ${measured}`;

  console.log(`[studio] ${detail}`);
  getDb().prepare('INSERT INTO event_log (stream_id, platform, event, detail, ts) VALUES (?, ?, ?, ?, ?)')
    .run(null, null, 'studio_quality', detail, Date.now());

  res.json({ ok: true });
});

// --- Studio-side problem reports ---

/**
 * Report a problem the BROWSER can see but the server cannot: a congested uplink, or a camera/mic
 * track that has ended or gone silent.
 *
 * These conditions were previously visible only as a banner in the operator's tab — and the operator is
 * the person praying on camera, so nobody saw them. Routing them here puts them in the log and, via
 * the alert webhook, in front of somebody who isn't presenting.
 */
const STUDIO_ALERT_KINDS = {
  uplink_congested: 'uplink_congested',
  track_ended: 'track_ended',
  // The browser's view of a studio socket drop (close code, queued bytes) and of its recovery.
  studio_dropped: 'studio_dropped',
} as const;

studioRouter.post('/alert', async (req: Request, res: Response) => {
  const { kind, subject, message, resolved } = (req.body ?? {}) as {
    kind?: string; subject?: string; message?: string; resolved?: boolean;
  };

  // Allow-list the kinds: this endpoint is authenticated but it drives an outbound webhook, so it must
  // not become a way to post arbitrary text wherever that webhook points.
  if (!kind || !(kind in STUDIO_ALERT_KINDS)) {
    res.status(400).json({ error: 'Unknown alert kind' });
    return;
  }
  const label = String(subject ?? 'studio').slice(0, 60);
  const detail = String(message ?? '').slice(0, 500);

  getDb().prepare('INSERT INTO event_log (stream_id, platform, event, detail, ts) VALUES (?, ?, ?, ?, ?)')
    .run(null, null, resolved ? `${kind}_resolved` : kind, detail || label, Date.now());

  const { sendAlert, clearAlert } = await import('../alerts.js');
  if (resolved) {
    console.log(`[studio] ${kind} resolved: ${label}`);
    // Recovered — let a later recurrence alert again rather than being suppressed.
    clearAlert(kind as 'uplink_congested', label);
  } else {
    console.warn(`[studio] ${kind}: ${label} — ${detail}`);
    sendAlert(kind as 'uplink_congested', label, detail || label);
  }

  res.json({ ok: true });
});
