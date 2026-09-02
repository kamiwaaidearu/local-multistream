import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import { getDb, DEFAULT_THUMBNAIL_TEMPLATES } from '../db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATES_DIR = path.join(__dirname, '..', '..', 'uploads', 'thumbnails');

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

// Unlike the other uploads in this app, plates keep a real file extension. They are listed back to
// the client and rendered as <img>, and an extensionless file is served as octet-stream — which
// browsers only render by content sniffing. Naming them properly removes that dependency.
const plateUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(PLATES_DIR, { recursive: true });
      cb(null, PLATES_DIR);
    },
    filename: (_req, file, cb) => cb(null, `${nanoid()}${EXT_BY_MIME[file.mimetype] ?? '.png'}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024 }, // Plates are full-bleed photographs, so larger than a thumbnail.
  fileFilter: (_req, file, cb) => {
    if (EXT_BY_MIME[file.mimetype]) cb(null, true);
    else cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
  },
});

export const thumbnailRouter = Router();

function param(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

interface TemplateRow {
  id: string;
  name: string;
  config_json: string;
  sort_order: number;
}

function serialise(row: TemplateRow) {
  return { id: row.id, name: row.name, sort_order: row.sort_order, config: JSON.parse(row.config_json) };
}

// --- Templates ---

thumbnailRouter.get('/templates', (_req: Request, res: Response) => {
  const rows = getDb()
    .prepare('SELECT id, name, config_json, sort_order FROM thumbnail_templates ORDER BY sort_order ASC, name ASC')
    .all() as unknown as TemplateRow[];
  res.json(rows.map(serialise));
});

thumbnailRouter.post('/templates', (req: Request, res: Response) => {
  const { name, config, sort_order } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim() || typeof config !== 'object' || config === null) {
    res.status(400).json({ error: 'name and config are required' });
    return;
  }
  const db = getDb();
  const id = nanoid();
  const nextOrder =
    typeof sort_order === 'number'
      ? sort_order
      : ((db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM thumbnail_templates').get() as { n: number }).n);

  db.prepare('INSERT INTO thumbnail_templates (id, name, config_json, sort_order) VALUES (?, ?, ?, ?)')
    .run(id, name.trim(), JSON.stringify({ ...config, id, name: name.trim() }), nextOrder);

  const row = db
    .prepare('SELECT id, name, config_json, sort_order FROM thumbnail_templates WHERE id = ?')
    .get(id) as unknown as TemplateRow;
  res.status(201).json(serialise(row));
});

thumbnailRouter.patch('/templates/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = param(req, 'id');
  const existing = db
    .prepare('SELECT id, name, config_json, sort_order FROM thumbnail_templates WHERE id = ?')
    .get(id) as unknown as TemplateRow | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }

  const { name, config, sort_order } = req.body ?? {};
  const nextName = typeof name === 'string' && name.trim() ? name.trim() : existing.name;
  // The config carries its own id/name copy so a template stays self-describing once exported to a
  // client; keep them in step with the row rather than trusting whatever the client sent.
  const nextConfig =
    typeof config === 'object' && config !== null
      ? { ...config, id, name: nextName }
      : { ...JSON.parse(existing.config_json), name: nextName };

  db.prepare('UPDATE thumbnail_templates SET name = ?, config_json = ?, sort_order = ? WHERE id = ?')
    .run(nextName, JSON.stringify(nextConfig), typeof sort_order === 'number' ? sort_order : existing.sort_order, id);

  const row = db
    .prepare('SELECT id, name, config_json, sort_order FROM thumbnail_templates WHERE id = ?')
    .get(id) as unknown as TemplateRow;
  res.json(serialise(row));
});

thumbnailRouter.delete('/templates/:id', (req: Request, res: Response) => {
  const id = param(req, 'id');
  const db = getDb();
  const remaining = (db.prepare('SELECT COUNT(*) AS n FROM thumbnail_templates').get() as { n: number }).n;
  if (remaining <= 1) {
    res.status(409).json({ error: 'Cannot delete the last thumbnail template' });
    return;
  }
  const result = db.prepare('DELETE FROM thumbnail_templates WHERE id = ?').run(id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  res.status(204).end();
});

/** Restores the stock templates to their seeded geometry, keeping whatever plate is selected. */
thumbnailRouter.post('/templates/reset', (_req: Request, res: Response) => {
  const db = getDb();
  for (const tpl of DEFAULT_THUMBNAIL_TEMPLATES) {
    const existing = db.prepare('SELECT config_json FROM thumbnail_templates WHERE id = ?').get(tpl.id) as
      | { config_json: string }
      | undefined;
    // A plate the operator picked is theirs to keep — resetting the layout should not force them to
    // re-pick their background image. Falling back to the seed's own plate (rather than to null)
    // means a reset after clearing the plate restores the stock one instead of leaving flat blue.
    const chosenPlate = existing ? (JSON.parse(existing.config_json).plate as string | null) : null;
    const config = { ...tpl.config, plate: chosenPlate ?? tpl.config.plate };
    db.prepare(
      'INSERT INTO thumbnail_templates (id, name, config_json, sort_order) VALUES (?, ?, ?, ?)' +
        ' ON CONFLICT(id) DO UPDATE SET name = excluded.name, config_json = excluded.config_json, sort_order = excluded.sort_order',
    ).run(tpl.id, tpl.name, JSON.stringify(config), tpl.sort_order);
  }
  const rows = db
    .prepare('SELECT id, name, config_json, sort_order FROM thumbnail_templates ORDER BY sort_order ASC, name ASC')
    .all() as unknown as TemplateRow[];
  res.json(rows.map(serialise));
});

// --- Plates (background images) ---

thumbnailRouter.get('/plates', (_req: Request, res: Response) => {
  let names: string[] = [];
  try {
    names = fs.readdirSync(PLATES_DIR);
  } catch {
    names = []; // No plate has been uploaded yet.
  }
  const plates = names
    .filter((n) => Object.values(EXT_BY_MIME).includes(path.extname(n).toLowerCase()))
    .map((n) => {
      const stat = fs.statSync(path.join(PLATES_DIR, n));
      return { url: `/uploads/thumbnails/${n}`, name: n, size: stat.size, uploadedAt: stat.mtimeMs };
    })
    .sort((a, b) => b.uploadedAt - a.uploadedAt);
  res.json(plates);
});

thumbnailRouter.post('/plates', plateUpload.single('image'), (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No image uploaded' });
    return;
  }
  res.status(201).json({ url: `/uploads/thumbnails/${req.file.filename}`, name: req.file.filename });
});
