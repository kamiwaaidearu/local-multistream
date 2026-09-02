import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', '..', 'data', 'multistream.db');

// Canonical default studio template — the single source of truth. Seeds the DB
// on first run, backs the migration path, and is what "Reset to Default" restores.
// The client only carries a blank FALLBACK_TEMPLATE for pre-load/offline state.
export const DEFAULT_GRID_TEMPLATE = {
  width: 1920,
  height: 1080,
  backgroundColor: '#094d8a',
  columns: [
    { unit: 'fr', value: 4 },
    { unit: 'fr', value: 1 },
  ],
  rows: [
    { unit: 'fr', value: 1 },
    { unit: 'px', value: 216 },
  ],
  gap: 0,
  cells: [
    {
      id: 'screen',
      row: 0, col: 0, rowSpan: 1, colSpan: 1,
      content: { type: 'screenShare', objectFit: 'cover' },
      backgroundColor: '#094d8a',
    },
    {
      id: 'camera',
      row: 1, col: 1, rowSpan: 1, colSpan: 1,
      content: { type: 'webcam', objectFit: 'cover' },
      backgroundColor: '#094d8a',
    },
    {
      id: 'footer',
      row: 1, col: 0, rowSpan: 1, colSpan: 1,
      content: { type: 'image', src: '/uploads/overlays/rm-logo.png', objectFit: 'contain' },
      backgroundColor: '#094d8a',
    },
    {
      id: 'branding',
      row: 0, col: 1, rowSpan: 1, colSpan: 1,
      content: {
        type: 'text',
        content: 'Join us at\nRosaryMen.com',
        fontSize: 36,
        fontFamily: 'sans-serif',
        fontWeight: 'bold',
        color: '#f0b429',
        align: 'center',
        verticalAlign: 'top',
      },
      backgroundColor: '#094d8a',
      padding: 15,
    },
  ],
};

// Canonical seed thumbnail templates. Like DEFAULT_GRID_TEMPLATE above, these live server-side so
// there is exactly one source of truth; the client only carries types.
//
// The geometry is the Figma design's own numbers, not an approximation. Figma's frame is 1280x720
// (the plate exports at 2560x1440, i.e. 2x), and its CSS for the two text layers is:
//
//   Main Title:  top 490px, width 1020px, Source Sans Pro 700, 88px/111px, centred, #FFFFFF
//   Sub Text:    top 606px, width 1020px, Source Sans Pro 700, 70px/88px,  centred, #FFFFFF
//
// Stored normalised (0..1 of the render box) so the same template renders identically at 1280x720
// for the upload and at 1920x1080 if a larger asset is ever wanted. Figma's per-layer horizontal
// nudges (+1px and +14px off centre) are box rounding artifacts, not design intent — both layers
// read as centred in the exports, so both are centred here.
const PLATE_RECOMMIT = '/uploads/thumbnails/recommit-to-christ.jpg';

/** Figma "Main Title": the big line, filled per week. */
const MAIN_TITLE = {
  id: 'main',
  label: 'Main title',
  text: '{{title}}',
  editable: true,
  x: 0.5,
  y: 490 / 720,
  maxWidth: 1020 / 1280,
  // The Figma box holds exactly one line, so an over-long title shrinks to fit rather than wrapping
  // down into the sub text. The editor flags anything that had to shrink.
  maxLines: 1,
  align: 'center' as const,
  vAlign: 'top' as const,
  fontSize: 88 / 720,
  fontWeight: 700,
  italic: false,
  uppercase: false,
  color: '#ffffff',
  lineHeight: 111 / 88,
  letterSpacing: 0,
  scaleWith: null as string | null,
};

/** Figma "Sub Text": the smaller line beneath it. */
const SUB_TEXT = {
  ...MAIN_TITLE,
  id: 'sub',
  label: 'Sub text',
  text: '{{date}}',
  y: 606 / 720,
  fontSize: 70 / 720,
  lineHeight: 88 / 70,
  // Follows the title down when a long title has to shrink, so the date never ends up with more
  // prominence than the title it sits under.
  scaleWith: 'main' as string | null,
};

export const DEFAULT_THUMBNAIL_TEMPLATES = [
  {
    id: 'weekly',
    name: 'Weekly',
    sort_order: 0,
    config: {
      id: 'weekly',
      name: 'Weekly',
      backgroundColor: '#0d4d8c',
      plate: PLATE_RECOMMIT,
      elements: [MAIN_TITLE, SUB_TEXT],
    },
  },
  {
    // Same two slots as Weekly — only the copy differs. The plate already carries the "RECOMMIT TO
    // CHRIST" eyebrow, so a special edition is a wording change, not a different layout.
    id: 'latin',
    name: 'Latin special edition',
    sort_order: 1,
    config: {
      id: 'latin',
      name: 'Latin special edition',
      backgroundColor: '#0d4d8c',
      plate: PLATE_RECOMMIT,
      elements: [
        { ...MAIN_TITLE, text: 'SPECIAL EDITION', uppercase: true },
        { ...SUB_TEXT, text: '{{title}}' },
      ],
    },
  },
];

let db: DatabaseSync;

export function getDb(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');

    const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
    db.exec(schema);

    // Seed default studio template if none exists
    const templateCount = db.prepare('SELECT COUNT(*) as count FROM studio_templates').get() as { count: number };
    if (templateCount.count === 0) {
      db.prepare(
        'INSERT INTO studio_templates (id, name, config_json, is_default) VALUES (?, ?, ?, 1)',
      ).run('default', 'RosaryMen Standard', JSON.stringify(DEFAULT_GRID_TEMPLATE));
      console.log('[db] Seeded default studio template');
    }

    // Seed the stock thumbnail templates. Insert-if-absent by id rather than "seed only when the
    // table is empty", so a later release can add a template without wiping the operator's edits to
    // the ones already there.
    const insertThumbTpl = db.prepare(
      'INSERT OR IGNORE INTO thumbnail_templates (id, name, config_json, sort_order) VALUES (?, ?, ?, ?)',
    );
    for (const tpl of DEFAULT_THUMBNAIL_TEMPLATES) {
      const result = insertThumbTpl.run(tpl.id, tpl.name, JSON.stringify(tpl.config), tpl.sort_order);
      if (result.changes > 0) console.log(`[db] Seeded thumbnail template '${tpl.id}'`);
    }

    // Migrate old layer-based template to grid format
    const existing = db.prepare('SELECT config_json FROM studio_templates WHERE id = ?').get('default') as { config_json: string } | undefined;
    if (existing) {
      const config = JSON.parse(existing.config_json);
      if (config.layers && !config.columns) {
        db.prepare('UPDATE studio_templates SET config_json = ? WHERE id = ?')
          .run(JSON.stringify(DEFAULT_GRID_TEMPLATE), 'default');
        console.log('[db] Migrated default template from layer format to grid format');
      }
    }

    // Facebook no longer supports API scheduling, so the old 'pending' state (events parked
    // more than 7 days out for later auto-creation) is obsolete. Promote any leftover rows to
    // 'created' so they're treated as deferred and the live video is created at go-live.
    const migrated = db.prepare(
      "UPDATE platform_streams SET status = 'created', error_message = NULL WHERE platform = 'facebook' AND status = 'pending'",
    ).run();
    if (migrated.changes > 0) {
      console.log(`[db] Migrated ${migrated.changes} pending Facebook event(s) to deferred go-live creation`);
    }

    // Add streams.fb_reminders_enabled to pre-existing databases (CREATE TABLE IF NOT EXISTS
    // won't alter an existing table). Defaults to on.
    const streamCols = db.prepare('PRAGMA table_info(streams)').all() as Array<{ name: string }>;
    if (!streamCols.some((c) => c.name === 'fb_reminders_enabled')) {
      db.exec('ALTER TABLE streams ADD COLUMN fb_reminders_enabled INTEGER NOT NULL DEFAULT 1');
      console.log('[db] Added streams.fb_reminders_enabled column');
    }

    // Test streams: a full dry run of the whole pipeline with nothing visible to the public.
    // Defaults to 0 so every existing stream stays a real broadcast.
    if (!streamCols.some((c) => c.name === 'is_test')) {
      db.exec('ALTER TABLE streams ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0');
      console.log('[db] Added streams.is_test column');
    }

    console.log(`[db] SQLite database opened at ${DB_PATH}`);
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    console.log('[db] Database connection closed');
  }
}

/** Read a JSON settings value by key, or undefined if unset. */
export function getSetting<T>(key: string): T | undefined {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return undefined;
  }
}

/** Write a JSON settings value by key. */
export function setSetting(key: string, value: unknown): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(key, JSON.stringify(value));
}
