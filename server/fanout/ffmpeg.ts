import { spawn, ChildProcess } from 'child_process';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { isRtmpPublishing, onPublisherGone } from '../rtmp/server.js';
import { sendAlert } from '../alerts.js';
import { decideFanoutRetry, MAX_PLATFORM_RETRIES } from './retryPolicy.js';
import { decideLegEncoding, buildLegArgs, describeLegEncoding } from './platformEncoding.js';
import { activeEncoder } from '../studio/ingest.js';
import { ProgressTracker } from '../ffmpegProgress.js';
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
  /** Parsed bitrate/fps/speed for this leg, throttled for logging and readable for the UI. */
  progress: ProgressTracker;
  /** Last few non-progress stderr lines — FFmpeg's actual reason when a leg dies. */
  stderrTail: string[];
  /** Set when WE killed it because the source dropped, so its exit isn't reported as a fault. */
  droppedForSourceLoss: boolean;
}

const STDERR_TAIL_LINES = 12;

/** How often to log a parsed per-leg push-rate summary. */
const LEG_PROGRESS_LOG_MS = 60_000;

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

  // Legs are no longer all stream-copies of one bitrate. The ingest encodes once at
  // STUDIO_VIDEO_BITRATE and each leg is copied through if its platform allows that rate, or
  // re-encoded down to the platform's ceiling if not (Facebook's 4000 kbps). See platformEncoding.
  const ingestKbps = config.studioVideoBitrateKbps;
  const encoding = decideLegEncoding(platformStream.platform, ingestKbps);
  const { encoder, preset } = encoding.mode === 'transcode'
    ? activeEncoder()
    : { encoder: 'libx264' as const, preset: '' }; // unused for a copy

  return buildLegArgs({ input, output, encoding, encoder, preset });
}

function spawnFfmpeg(streamId: string, ps: PlatformStream, retryCount: number): void {
  const args = buildFfmpegArgs(ps);
  const key = `${streamId}:${ps.platform}`;

  console.log(`[ffmpeg] ${describeLegEncoding(ps.platform, decideLegEncoding(ps.platform, config.studioVideoBitrateKbps), config.studioVideoBitrateKbps)}`);
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
    progress: new ProgressTracker(LEG_PROGRESS_LOG_MS),
    stderrTail: [],
    droppedForSourceLoss: false,
  };

  activeProcesses.set(key, proc);

  // Parse FFmpeg stderr for status lines
  child.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line.includes('frame=') || line.includes('speed=')) {
      // Periodic parsed summary so each leg's real push rate is in the log, not just streamed past.
      const summary = proc.progress.update(line);
      if (summary) console.log(`[ffmpeg] ${ps.platform} pushing at ${summary}`);
      pushSSEEvent({ type: 'ffmpeg_status', platform: ps.platform, data: line });
    } else if (line) {
      // Keep the rest: when a leg dies, its last words are the only record of why. On 2026-10-14
      // Facebook refused three reconnects and nothing said what it objected to.
      proc.stderrTail.push(...line.split(/\r?\n|\r/).filter(Boolean));
      if (proc.stderrTail.length > STDERR_TAIL_LINES) proc.stderrTail.splice(0, proc.stderrTail.length - STDERR_TAIL_LINES);
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
    const sourcePresent = isRtmpPublishing();
    if (proc.droppedForSourceLoss) {
      console.warn(`[ffmpeg] ${ps.platform} dropped (source lost) — will reconnect when it returns`);
    } else {
      console.warn(`[ffmpeg] ${ps.platform} exited (code ${code}) while stream is live — reconnecting`);
      // Skip the source-absent probes during an outage: their "no input" errors are expected noise.
      if (sourcePresent || ranMs > 15000) {
        for (const l of proc.stderrTail) console.warn(`[ffmpeg] ${ps.platform} stderr: ${l}`);
      }
    }
    // Persist a disconnect for a leg that had actually been streaming (a real drop) OR any failure
    // while the source is present (a per-platform fault worth a paper trail). Suppress only the
    // rapid source-absent reconnect probes during an outage, which would otherwise flood the log.
    if (ranMs > 15000 || sourcePresent) logEvent(streamId, ps.platform, 'ffmpeg_disconnected', `Exit code: ${code}`);

    // Two failure modes (see retryPolicy): if the local source is gone, the operator's ingest
    // dropped and every leg lost its input — keep retrying so all resume when it returns (the
    // stream watchdog bounds this). If the source is present but this leg keeps dying, it's a
    // per-platform fault — give up and surface an error after a few tries.
    const decision = decideFanoutRetry({ sourcePresent, retryCount, ranMs });

    if (decision.giveUp) {
      const lastError = proc.stderrTail.at(-1) ?? 'no error output';
      db.prepare("UPDATE platform_streams SET status = 'error', error_message = ? WHERE id = ?").run(
        `FFmpeg failed ${MAX_PLATFORM_RETRIES} times while the source was live — gave up (${lastError})`, ps.id,
      );
      logEvent(streamId, ps.platform, 'ffmpeg_gave_up', lastError);
      pushSSEEvent({ type: 'ffmpeg_gave_up', platform: ps.platform });
      // Nobody saw Facebook go dark on 2026-10-14 until the broadcast was over.
      sendAlert('health_alarm', ps.platform, `Stopped sending video after ${MAX_PLATFORM_RETRIES} failed reconnects: ${lastError}`);
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
 * The local source just stopped publishing (studio socket dropped, ingest died, or OBS
 * disconnected). Kill every running leg NOW, before it notices.
 *
 * Left alone, each leg reads EOF, exits cleanly, and on the way out sends the platform an explicit
 * RTMP unpublish: "this broadcast is over". Facebook takes that at its word. On 2026-10-14 it restarted
 * the broadcast after the first drop (throwing away the first 12 minutes of the saved video) and
 * closed it for good after the second, refusing every reconnect. A hard kill sends no unpublish, so
 * to the platform it looks like a network blip, which is what its reconnect grace is for. The normal
 * close handler then retries each leg until the source returns.
 *
 * This runs inside node-media-server's donePublish event, which fires before it tells the legs the
 * stream ended, so the kill lands first. An intentional end goes through stopFanOut, which takes the
 * legs out of activeProcesses before the source stops, so it still ends them cleanly.
 */
function dropLegsForSourceLoss(): void {
  for (const proc of activeProcesses.values()) {
    if (proc.stopping || proc.droppedForSourceLoss) continue;
    proc.droppedForSourceLoss = true;
    try { proc.child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

onPublisherGone(dropLegsForSourceLoss);

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

/** When this platform's leg process started, or null if it isn't running. The health monitor uses
 *  this as the warm-up clock — a leg that just (re)started hasn't had time to be measured yet. */
export function legStartedAt(streamId: string, platform: string): number | null {
  return activeProcesses.get(`${streamId}:${platform}`)?.startedAt ?? null;
}

/** What WE are currently pushing on this leg, per FFmpeg. Distinct from the platform's own reading:
 *  comparing the two is what distinguishes "we're not sending" from "they're not receiving". */
export function legPushKbps(streamId: string, platform: string): number | null {
  return activeProcesses.get(`${streamId}:${platform}`)?.progress.latest?.bitrateKbps ?? null;
}

/**
 * Force-restart one platform's fan-out leg against the same ingest URL. Used by the health monitor
 * when the PLATFORM reports it isn't receiving video even though our process looks fine — the
 * failure mode that made Facebook produce an empty video on 2026-08-05.
 *
 * Distinct from ensurePlatformLeg, which is a no-op when the leg is already running: here the
 * running process is precisely the problem. Marked `stopping` first so the normal close handler
 * treats the kill as intentional and doesn't race its own retry against our respawn.
 *
 * Hard kill, never a graceful 'q': a graceful quit sends the platform an RTMP unpublish, and
 * Facebook ends the live video for good on that. On 2026-10-21 a restart did exactly that to a
 * Facebook broadcast that WAS receiving, and every reconnect after it was refused. See
 * dropLegsForSourceLoss.
 */
export function restartPlatformLeg(streamId: string, ps: PlatformStream): void {
  const key = `${streamId}:${ps.platform}`;
  const existing = activeProcesses.get(key);

  if (existing) {
    existing.stopping = true;
    activeProcesses.delete(key);
    try { existing.child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  logEvent(streamId, ps.platform, 'leg_restarted', 'Platform reported it was not receiving video');
  if (ps.rtmp_url || ps.stream_key) spawnFfmpeg(streamId, ps, 0);
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
