CREATE TABLE IF NOT EXISTS credentials (
  platform      TEXT PRIMARY KEY,
  access_token  TEXT,
  refresh_token TEXT,
  token_expiry  INTEGER,
  extra_json    TEXT
);

CREATE TABLE IF NOT EXISTS streams (
  id                TEXT PRIMARY KEY,
  series_id         TEXT,
  name              TEXT NOT NULL,
  description       TEXT,
  thumbnail_path    TEXT,
  scheduled_start   INTEGER,
  status            TEXT NOT NULL DEFAULT 'draft',
  started_at        INTEGER,
  ended_at          INTEGER,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_streams (
  id            TEXT PRIMARY KEY,
  stream_id     TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL,
  broadcast_id  TEXT,
  stream_key    TEXT,
  rtmp_url      TEXT,
  status        TEXT DEFAULT 'pending',
  error_message TEXT,
  extra_json    TEXT
);

CREATE TABLE IF NOT EXISTS event_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id TEXT,
  platform  TEXT,
  event     TEXT NOT NULL,
  detail    TEXT,
  ts        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS studio_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  config_json TEXT NOT NULL,
  is_default  INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);
