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
