import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { isStudioConnected } from '../studio/ingest.js';
import { isObsConnected } from '../rtmp/server.js';
import { getDb, DEFAULT_GRID_TEMPLATE } from '../db/index.js';

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
  const studio = isStudioConnected();
  const obs = isObsConnected();

  let source: 'studio' | 'obs' | null = null;
  if (studio) source = 'studio';
  else if (obs) source = 'obs';

  res.json({ connected: studio || obs, source });
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
