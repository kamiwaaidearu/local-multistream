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
  backgroundColor: '#1a3a5c',
  columns: [
    { unit: 'fr', value: 4 },
    { unit: 'fr', value: 1 },
  ],
  rows: [
    { unit: 'fr', value: 1 },
    { unit: 'px', value: 200 },
  ],
  gap: 0,
  cells: [
    {
      id: 'screen',
      row: 0, col: 0, rowSpan: 1, colSpan: 1,
      content: { type: 'screenShare' },
    },
    {
      id: 'camera',
      row: 1, col: 1, rowSpan: 1, colSpan: 1,
      content: { type: 'webcam' },
      backgroundColor: '#0d2137',
    },
    {
      id: 'footer',
      row: 1, col: 0, rowSpan: 1, colSpan: 1,
      content: { type: 'image', src: '/uploads/overlays/rm-logo.png', objectFit: 'contain' },
      backgroundColor: '#0d2137',
      padding: 10,
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
