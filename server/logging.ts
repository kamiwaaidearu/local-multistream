import fs from 'fs';
import path from 'path';
import { format } from 'util';
import { logFileName, shouldRotate, filesToPrune } from './logRotation.js';

// Persistent server logs. Everything the server logs goes to stdout as before AND is appended to a
// daily file under LOG_DIR, because stdout is not captured anywhere: when a broadcast goes wrong the
// terminal scrollback is the only copy, and it dies with the window. The DB event_log records
// milestones but carries no ffmpeg/bitrate detail, which is exactly what post-mortems need.
//
// Writes go through a WriteStream (async, internally buffered) rather than fs.appendFileSync: the
// ingest WebSocket handler feeds webm into FFmpeg on this same event loop, and a synchronous disk
// write per log line would stall it — the hazard already called out in studio/ingest.ts.

type Level = 'log' | 'info' | 'warn' | 'error' | 'debug';

interface State {
  dir: string;
  retentionDays: number;
  stream: fs.WriteStream | null;
  openedAt: Date;
  // Set while we're handling a stream error so writing the failure can't recurse back into the
  // patched console and into this same broken stream.
  failing: boolean;
}

let state: State | null = null;

const original: Record<Level, (...args: unknown[]) => void> = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

function openStream(s: State, at: Date): void {
  s.stream?.end();
  s.openedAt = at;
  s.stream = fs.createWriteStream(path.join(s.dir, logFileName(at)), { flags: 'a' });
  s.stream.on('error', (err) => {
    if (s.failing) return;
    s.failing = true;
    // Never throw out of a log call — degrade to stdout-only and say so once.
    original.error(`[logging] Log file write failed, continuing without file logging: ${err.message}`);
    s.stream = null;
    s.failing = false;
  });
}

function prune(s: State, at: Date): void {
  try {
    const stale = filesToPrune(fs.readdirSync(s.dir), at, s.retentionDays);
    for (const name of stale) {
      try { fs.unlinkSync(path.join(s.dir, name)); } catch { /* best-effort */ }
    }
  } catch { /* directory unreadable — not worth failing startup over */ }
}

function write(s: State, level: Level, args: unknown[]): void {
  const at = new Date();
  if (s.stream && shouldRotate(s.openedAt, at)) {
    openStream(s, at);
    prune(s, at);
  }
  if (!s.stream) return;

  const stamp = at.toISOString();
  const tag = level === 'log' ? '' : ` ${level.toUpperCase()}`;
  // Prefix EVERY line, including stack-trace continuations, so a grep for a time window returns
  // whole errors rather than just their first line.
  const body = format(...args);
  const text = body.split('\n').map((line) => `${stamp}${tag} ${line}`).join('\n');
  try { s.stream.write(`${text}\n`); } catch { /* the 'error' handler above reports it */ }
}

/**
 * Start mirroring console output to a daily log file. Safe to call once at startup, before anything
 * else logs. Returns the active log file path, or null when file logging is disabled or unavailable.
 */
export function initFileLogging(opts: { dir: string; retentionDays: number }): string | null {
  if (state) return path.join(state.dir, logFileName(state.openedAt));
  if (!opts.dir) return null;

  try {
    fs.mkdirSync(opts.dir, { recursive: true });
  } catch (err) {
    original.error(`[logging] Could not create log directory ${opts.dir}: ${(err as Error).message}`);
    return null;
  }

  const at = new Date();
  const s: State = { dir: opts.dir, retentionDays: opts.retentionDays, stream: null, openedAt: at, failing: false };
  openStream(s, at);
  prune(s, at);
  state = s;

  for (const level of Object.keys(original) as Level[]) {
    console[level] = (...args: unknown[]) => {
      original[level](...args);
      write(s, level, args);
    };
  }

  // A crash is the single most valuable thing to have on disk, and by default Node prints it to
  // stderr without going through console.* at all.
  process.on('uncaughtException', (err) => {
    write(s, 'error', [`[fatal] Uncaught exception: ${err?.stack ?? err}`]);
    original.error(err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    write(s, 'error', [`[fatal] Unhandled rejection: ${(reason as Error)?.stack ?? reason}`]);
  });

  return path.join(s.dir, logFileName(at));
}

/** Flush and close the log file — called on graceful shutdown so the last lines aren't lost. */
export async function closeFileLogging(): Promise<void> {
  const s = state;
  if (!s?.stream) return;
  const stream = s.stream;
  s.stream = null;
  await new Promise<void>((resolve) => {
    stream.end(() => resolve());
    setTimeout(resolve, 1000).unref?.();
  });
}
