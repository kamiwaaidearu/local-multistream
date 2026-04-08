import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', '..', 'data', 'multistream.db');

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
      const defaultTemplate = {
        width: 1920,
        height: 1080,
        backgroundColor: '#1a3a5c',
        layers: [
          { type: 'screenShare', x: 0, y: 0, width: 1920, height: 880 },
          { type: 'rect', x: 0, y: 880, width: 1920, height: 200, color: '#0d2137' },
          { type: 'image', src: '/uploads/overlays/rm-logo.png', x: 20, y: 890, width: 300, height: 180 },
          { type: 'webcam', x: 1580, y: 780, width: 320, height: 280 },
          { type: 'text', content: 'Join us at RosaryMen.com', x: 1900, y: 50, font: 'bold 36px sans-serif', color: '#f0b429', align: 'right' },
        ],
      };
      db.prepare(
        'INSERT INTO studio_templates (id, name, config_json, is_default) VALUES (?, ?, ?, 1)',
      ).run('default', 'RosaryMen Standard', JSON.stringify(defaultTemplate));
      console.log('[db] Seeded default studio template');
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
