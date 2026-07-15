import { spawn, ChildProcess } from 'child_process';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { isRtmpPublishing } from '../rtmp/server.js';
import { decideFanoutRetry, MAX_PLATFORM_RETRIES } from './retryPolicy.js';
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

    // If the stream is no longer live, this is normal teardown — don't restart.
    const db = getDb();
    const stream = db.prepare('SELECT status FROM streams WHERE id = ?').get(streamId) as { status: string } | undefined;
    if (stream?.status !== 'live') {
      console.log(`[ffmpeg] ${ps.platform} exited (code ${code}); stream not live — not restarting`);
      return;
    }

    // Stream is still live but FFmpeg exited. Either it crashed, OR — commonly — the local
    // RTMP input ended because the source (Studio/OBS) dropped. FFmpeg exits 0 on a clean
    // input EOF, so code 0 is NOT "all done" here.
    const ranMs = Date.now() - proc.startedAt;
    console.warn(`[ffmpeg] ${ps.platform} exited (code ${code}) while stream is live — reconnecting`);
    // Only persist a disconnect for a leg that had actually been streaming — not the rapid
    // reconnect probes during an outage (each runs only seconds and would otherwise flood the log).
    if (ranMs > 15000) logEvent(streamId, ps.platform, 'ffmpeg_disconnected', `Exit code: ${code}`);

    // Two failure modes (see retryPolicy): if the local source is gone, the operator's ingest
    // dropped and every leg lost its input — keep retrying so all resume when it returns (the
    // stream watchdog bounds this). If the source is present but this leg keeps dying, it's a
    // per-platform fault — give up and surface an error after a few tries.
    const sourcePresent = isRtmpPublishing();
    const decision = decideFanoutRetry({ sourcePresent, retryCount, ranMs });

    if (decision.giveUp) {
      db.prepare("UPDATE platform_streams SET status = 'error', error_message = ? WHERE id = ?").run(
        `FFmpeg failed ${MAX_PLATFORM_RETRIES} times while the source was live — gave up`, ps.id,
      );
      logEvent(streamId, ps.platform, 'ffmpeg_gave_up');
      pushSSEEvent({ type: 'ffmpeg_gave_up', platform: ps.platform });
      return;
    }

    const delay = decision.delayMs;
    db.prepare("UPDATE platform_streams SET status = 'reconnecting' WHERE id = ?").run(ps.id);
    pushSSEEvent({ type: 'ffmpeg_crash', platform: ps.platform, retryIn: delay / 1000 });

    console.log(`[ffmpeg] Retrying ${ps.platform} in ${delay / 1000}s${sourcePresent ? '' : ' (waiting for the source to return)'}`);

    setTimeout(() => {
      // Double-check stream is still live before retrying — when the watchdog ends an abandoned
      // stream, status flips to 'ended' and this retry becomes a no-op, bounding the loop.
      const check = db.prepare('SELECT status FROM streams WHERE id = ?').get(streamId) as { status: string } | undefined;
      if (check?.status === 'live') {
        spawnFfmpeg(streamId, ps, decision.nextRetryCount);
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
 * Ensure a single platform's fan-out leg is running, restarting it if it has died or given up.
 * No-op if the leg is already active. Used by mid-stream recovery to bring one platform's video
 * pipe back without disturbing the others.
 */
export function ensurePlatformLeg(streamId: string, ps: PlatformStream): void {
  const key = `${streamId}:${ps.platform}`;
  if (activeProcesses.has(key)) return;
  if (ps.rtmp_url || ps.stream_key) spawnFfmpeg(streamId, ps, 0);
}

/** True if this platform's fan-out leg is currently running. */
export function isLegActive(streamId: string, platform: string): boolean {
  return activeProcesses.has(`${streamId}:${platform}`);
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
