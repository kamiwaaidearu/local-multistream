import { spawn, ChildProcess } from 'child_process';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import type { PlatformStream } from '../types.js';

// Get ffmpeg binary path
let ffmpegPath: string;
try {
  ffmpegPath = (await import('ffmpeg-static')).default as unknown as string;
} catch {
  ffmpegPath = 'ffmpeg'; // fallback to system
}

interface ActiveProcess {
  child: ChildProcess;
  platform: string;
  streamId: string;
  platformStreamId: string;
  rtmpUrl: string;
  retryCount: number;
  startedAt: number;
  stopping: boolean; // set when we intentionally stop it, so 'close' doesn't trigger a retry
}

const activeProcesses = new Map<string, ActiveProcess>();

// SSE clients
const sseClients = new Set<{ write: (data: string) => boolean }>();

export function addSSEClient(client: { write: (data: string) => boolean }): void {
  sseClients.add(client);
}

export function removeSSEClient(client: { write: (data: string) => boolean }): void {
  sseClients.delete(client);
}

function pushSSEEvent(event: Record<string, unknown>): void {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try { client.write(data); } catch { sseClients.delete(client); }
  }
}

function logEvent(streamId: string, platform: string | null, event: string, detail?: string): void {
  const db = getDb();
  db.prepare('INSERT INTO event_log (stream_id, platform, event, detail, ts) VALUES (?, ?, ?, ?, ?)').run(
    streamId, platform, event, detail ?? null, Date.now(),
  );
}

function buildFfmpegArgs(platformStream: PlatformStream): string[] {
  const input = `rtmp://127.0.0.1:${config.rtmpPort}/live/${config.localStreamKey}`;

  let output: string;
  if (platformStream.platform === 'twitch') {
    output = `${platformStream.rtmp_url}/${platformStream.stream_key}`;
  } else if (platformStream.platform === 'facebook') {
    // Facebook: stream URL already contains the key
    output = platformStream.rtmp_url ?? '';
  } else {
    // YouTube
    output = `${platformStream.rtmp_url}/${platformStream.stream_key}`;
  }

  return [
    '-rw_timeout', '10000000',   // 10s I/O timeout (microseconds) — prevents instant crash on brief RTMP hiccups
    '-i', input,
    '-c', 'copy',
    '-flvflags', 'no_duration_filesize',
    '-f', 'flv',
    output,
  ];
}

function spawnFfmpeg(streamId: string, ps: PlatformStream, retryCount: number): void {
  const args = buildFfmpegArgs(ps);
  const key = `${streamId}:${ps.platform}`;

  console.log(`[ffmpeg] Starting ${ps.platform}: ${ffmpegPath} ${args.join(' ').replace(/\/[^/]+$/, '/***')}`);

  const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  const proc: ActiveProcess = {
    child,
    platform: ps.platform,
    streamId,
    platformStreamId: ps.id,
    rtmpUrl: ps.rtmp_url ?? '',
    retryCount,
    startedAt: Date.now(),
    stopping: false,
  };

  activeProcesses.set(key, proc);

  // Parse FFmpeg stderr for status lines
  child.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line.includes('frame=') || line.includes('speed=')) {
      pushSSEEvent({ type: 'ffmpeg_status', platform: ps.platform, data: line });
    }
  });

  child.on('close', (code) => {
    activeProcesses.delete(key);

    // Intentional stop (stopFanOut / killAll) — never treat as a crash, never retry.
    if (proc.stopping) {
      console.log(`[ffmpeg] ${ps.platform} stopped`);
      return;
    }

    if (code === 0) {
      // Clean exit (from 'q' command during end stream)
      console.log(`[ffmpeg] ${ps.platform} exited cleanly`);
      return;
    }

    // Check if stream is still supposed to be live
    const db = getDb();
    const stream = db.prepare('SELECT status FROM streams WHERE id = ?').get(streamId) as { status: string } | undefined;
    if (stream?.status !== 'live') return; // Stream was ended, don't restart

    console.error(`[ffmpeg] ${ps.platform} crashed with exit code ${code}`);
    logEvent(streamId, ps.platform, 'ffmpeg_crash', `Exit code: ${code}`);

    // Circuit breaker: exponential backoff, max 3 retries
    const MAX_RETRIES = 3;
    const BACKOFF = [5000, 10000, 20000];

    // Reset retry count if the process ran for >60s (was transient)
    const runDuration = Date.now() - proc.startedAt;
    const effectiveRetryCount = runDuration > 60000 ? 0 : retryCount;

    if (effectiveRetryCount >= MAX_RETRIES) {
      db.prepare("UPDATE platform_streams SET status = 'error', error_message = ? WHERE id = ?").run(
        `FFmpeg crashed ${MAX_RETRIES} times — gave up`, ps.id,
      );
      logEvent(streamId, ps.platform, 'ffmpeg_gave_up');
      pushSSEEvent({ type: 'ffmpeg_gave_up', platform: ps.platform });
      return;
    }

    const delay = BACKOFF[effectiveRetryCount] ?? 20000;
    db.prepare("UPDATE platform_streams SET status = 'reconnecting' WHERE id = ?").run(ps.id);
    pushSSEEvent({ type: 'ffmpeg_crash', platform: ps.platform, retryIn: delay / 1000 });

    console.log(`[ffmpeg] Retrying ${ps.platform} in ${delay / 1000}s (attempt ${effectiveRetryCount + 1}/${MAX_RETRIES})`);

    setTimeout(() => {
      // Double-check stream is still live before retrying
      const check = db.prepare('SELECT status FROM streams WHERE id = ?').get(streamId) as { status: string } | undefined;
      if (check?.status === 'live') {
        spawnFfmpeg(streamId, ps, effectiveRetryCount + 1);
        pushSSEEvent({ type: 'ffmpeg_reconnecting', platform: ps.platform });
      }
    }, delay);
  });

  // Update platform_stream status
  const db = getDb();
  db.prepare("UPDATE platform_streams SET status = 'live' WHERE id = ?").run(ps.id);
  logEvent(streamId, ps.platform, 'ffmpeg_started');
  pushSSEEvent({ type: 'ffmpeg_started', platform: ps.platform });
}

/**
 * Start FFmpeg fan-out for all created platform streams.
 */
export function startFanOut(streamId: string, platformStreams: PlatformStream[]): void {
  for (const ps of platformStreams) {
    if (ps.status === 'created' && (ps.rtmp_url || ps.stream_key)) {
      spawnFfmpeg(streamId, ps, 0);
    }
  }
}

/**
 * Stop all FFmpeg processes for a stream.
 */
export async function stopFanOut(streamId: string): Promise<void> {
  const toStop: ActiveProcess[] = [];

  for (const [key, proc] of activeProcesses) {
    if (proc.streamId === streamId) {
      toStop.push(proc);
      activeProcesses.delete(key);
    }
  }

  // Stop all platforms in parallel (was sequential — a slow 'q' on one shouldn't delay
  // the others). Each is still bounded by the 5s force-kill.
  await Promise.all(toStop.map((proc) => new Promise<void>((resolve) => {
    proc.stopping = true;

    let settled = false;
    const done = () => {
      if (settled) return; // force-kill timeout + 'close' can both fire
      settled = true;
      logEvent(streamId, proc.platform, 'ffmpeg_stopped');
      pushSSEEvent({ type: 'ffmpeg_stopped', platform: proc.platform });
      resolve();
    };

    const timeout = setTimeout(() => {
      try { proc.child.kill(); } catch { /* ignore */ }
      done();
    }, 5000);

    proc.child.on('close', () => {
      clearTimeout(timeout);
      done();
    });

    // Graceful: send 'q' to FFmpeg stdin
    try { proc.child.stdin?.write('q\n'); } catch { /* ignore */ }
  })));
}

/**
 * Kill all FFmpeg processes (for graceful shutdown).
 */
export async function killAll(): Promise<void> {
  const procs = [...activeProcesses.values()];
  activeProcesses.clear();

  await Promise.all(procs.map((proc) => new Promise<void>((resolve) => {
    proc.stopping = true;
    const timeout = setTimeout(() => {
      try { proc.child.kill(); } catch { /* ignore */ }
      resolve();
    }, 3000);
    proc.child.on('close', () => { clearTimeout(timeout); resolve(); });
    try { proc.child.stdin?.write('q\n'); } catch { /* ignore */ }
  })));
}
