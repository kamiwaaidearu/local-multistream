import { getDb } from '../db/index.js';
import { isRtmpPublishing } from '../rtmp/server.js';
import { sendAlert, clearAlert } from '../alerts.js';
import { getFacebookIngestHealth } from '../platforms/facebook.js';
import { getYouTubeStreamHealth } from '../platforms/youtube.js';
import { isTwitchLive } from '../platforms/twitch.js';
import { decideHealthAction, type HealthCounters, type HealthSample, type HealthState } from './healthPolicy.js';
import type { Platform, PlatformStream } from '../types.js';

// Per-platform ingest health monitor.
//
// The point of this module: until now the only thing we knew about a live broadcast was whether OUR
// FFmpeg process was still running. That is not the same question as "is the platform receiving
// video", and on 2026-08-05 the two diverged — Facebook's leg pushed for 24 minutes, exited 0, and
// Facebook published a video of 0:00 duration. Nobody found out until after the broadcast.
//
// So while a stream is live we poll each platform's OWN view of the ingest and act on it: Facebook's
// ingest_streams{stream_health}, YouTube's liveStreams status.healthStatus, and (Twitch has no
// ingest-health API) whether the channel is actually live.

/** How often to ask the platforms. Slow enough to be free, fast enough to catch a dead leg in ~1 min. */
const POLL_INTERVAL_MS = 20_000;

/** Facebook's documented recommended maximum video bitrate. Duplicated from platformEncoding to keep
 *  this module free of encoder concerns; both cite the same Live API spec. */
const FACEBOOK_MAX_KBPS = 4000;

/**
 * Headroom before we call Facebook's measured bitrate "too high".
 *
 * The fan-out now transcodes the Facebook leg to exactly FACEBOOK_MAX_KBPS, and stream_health measures
 * the real muxed rate — which sits a little above the video target because of FLV/container overhead
 * and CBR variance. Warning on `> 4000` would therefore fire on every single poll of a correctly
 * configured stream, flapping the state to 'degraded' and crying wolf. 15% is comfortably above normal
 * overhead while still catching a genuinely mis-set bitrate.
 */
const FACEBOOK_BITRATE_WARN_KBPS = Math.round(FACEBOOK_MAX_KBPS * 1.15);

export interface PlatformHealth {
  state: HealthState;
  reason: string;
  /** Platform-reported ingest bitrate, when it tells us (Facebook does; YouTube doesn't). */
  videoKbps: number | null;
  audioKbps: number | null;
  fps: number | null;
  /** What OUR ffmpeg says it's pushing on this leg. Read alongside videoKbps: we're sending but they
   *  aren't receiving is a very different fault from us not sending at all. */
  pushKbps: number | null;
  /** Quality complaints from the platform, e.g. ['videoBitrateLow']. */
  warnings: string[];
  /** True once auto-recovery is exhausted and the operator needs to act. */
  alarm: boolean;
  /**
   * Video is arriving but the platform reports no audio. Tracked separately from `alarm` because
   * restarting a leg cannot fix a muted mic — and because for a prayer broadcast, a silent stream is
   * the worst possible failure while being invisible to every other signal we have.
   */
  audioAlarm: boolean;
  /** What the platform actually returned on the last probe, in words (Facebook only, for now). */
  evidence: string | null;
  checkedAt: number;
}

interface Tracked extends HealthCounters {
  health: PlatformHealth;
  /** The last "no usable reading" cause written to the event log, so it is logged once per change
   *  rather than every 20s. */
  loggedProbeError: string | null;
}

interface Monitor {
  timer: NodeJS.Timeout;
  platforms: Map<Platform, Tracked>;
  /**
   * Guards against overlapping polls. setInterval fires on a fixed schedule regardless of whether the
   * previous run finished, and a poll makes several HTTP calls — so a slow platform can push one run
   * past the interval. Two concurrent runs would each read the same counters, both conclude the
   * restart threshold was crossed, and both restart the same leg: the second kill/respawn would
   * destroy the leg the first had just started, while the restart budget is corrupted by the
   * last-write-wins update.
   */
  polling: boolean;
  /** Consecutive skipped ticks, so a permanently-slow platform gets reported rather than silently
   *  halving the effective poll rate. */
  skipped: number;
}

const monitors = new Map<string, Monitor>();

function logEvent(streamId: string, platform: string | null, event: string, detail?: string): void {
  getDb().prepare('INSERT INTO event_log (stream_id, platform, event, detail, ts) VALUES (?, ?, ?, ?, ?)')
    .run(streamId, platform, event, detail ?? null, Date.now());
}

/** Ask one platform what it's receiving. Never throws — a failed probe is reported as such so the
 *  policy can treat it as unknown rather than as a fault. */
async function sample(ps: PlatformStream): Promise<{
  sample: HealthSample;
  detail: Partial<PlatformHealth>;
  /** Why there was no usable reading, when the platform says. */
  probeError?: string | null;
}> {
  if (ps.platform === 'facebook') {
    if (!ps.broadcast_id) {
      return { sample: { receiving: false, probeFailed: true, warnings: [], audioMissing: null }, detail: {} };
    }
    const h = await getFacebookIngestHealth(ps.broadcast_id);
    // Facebook reports audio_bitrate alongside video, so a silent broadcast is directly observable:
    // video arriving with zero/absent audio. Only meaningful while video IS arriving.
    const audioMissing = h.receiving ? (h.audioKbps === null || h.audioKbps <= 0) : null;
    const warnings: string[] = [];
    // Facebook's documented ceilings; exceeding them is a real risk of it refusing to produce video.
    if (h.videoKbps !== null && h.videoKbps > FACEBOOK_BITRATE_WARN_KBPS) {
      warnings.push(`videoBitrateHigh (${h.videoKbps} kbps — Facebook's limit is ${FACEBOOK_MAX_KBPS})`);
    }
    if (h.gopMs !== null && h.gopMs > 2000) warnings.push(`keyframeIntervalTooLong (${h.gopMs} ms > 2000)`);
    return {
      sample: { receiving: h.receiving, probeFailed: h.error !== null, warnings, audioMissing },
      detail: { videoKbps: h.videoKbps, audioKbps: h.audioKbps, fps: h.fps, warnings, evidence: h.evidence },
      probeError: h.error,
    };
  }

  if (ps.platform === 'youtube') {
    const streamId = ps.extra_json ? (JSON.parse(ps.extra_json) as { stream_id?: string }).stream_id : undefined;
    if (!streamId) {
      return { sample: { receiving: false, probeFailed: true, warnings: [], audioMissing: null }, detail: {} };
    }
    const h = await getYouTubeStreamHealth(streamId);
    const warnings = h.issues.map((i) => i.type || i.reason);
    // YouTube names this condition itself, so we don't have to infer it from a bitrate.
    const audioMissing = h.receiving ? h.issues.some((i) => i.type === 'noAudioStream') : null;
    return {
      sample: { receiving: h.receiving, probeFailed: h.error !== null, warnings, audioMissing },
      detail: { warnings },
    };
  }

  // Twitch exposes no ingest health, so "is the channel live" is the best available signal.
  try {
    const live = await isTwitchLive();
    // Twitch exposes no audio information, so audio state stays unknown for this platform.
    return { sample: { receiving: live, probeFailed: false, warnings: [], audioMissing: null }, detail: {} };
  } catch {
    return { sample: { receiving: false, probeFailed: true, warnings: [], audioMissing: null }, detail: {} };
  }
}

async function pollOnce(streamId: string, monitor: Monitor): Promise<void> {
  const db = getDb();
  const stream = db.prepare('SELECT status FROM streams WHERE id = ?').get(streamId) as { status: string } | undefined;
  if (stream?.status !== 'live') {
    stopHealthMonitor(streamId);
    return;
  }

  // When the operator's own source is gone, EVERY platform will report nothing — restarting legs
  // would be pointless and would burn the restart budget on something we can't fix from here. The
  // fan-out's own source-absent retry and the source watchdog own that case.
  const sourcePresent = isRtmpPublishing();

  const rows = db.prepare("SELECT * FROM platform_streams WHERE stream_id = ? AND status IN ('live','reconnecting')")
    .all(streamId) as unknown as PlatformStream[];

  const { legStartedAt, restartPlatformLeg, legPushKbps } = await import('../fanout/ffmpeg.js');

  for (const ps of rows) {
    const platform = ps.platform as Platform;
    const tracked = monitor.platforms.get(platform) ?? {
      consecutiveBad: 0,
      restarts: 0,
      consecutiveNoAudio: 0,
      loggedProbeError: null,
      health: { state: 'unknown', reason: 'Not yet checked', videoKbps: null, audioKbps: null, fps: null, pushKbps: null, warnings: [], alarm: false, audioAlarm: false, evidence: null, checkedAt: 0 },
    };

    const { sample: s, detail, probeError = null } = await sample(ps);

    // An unusable reading used to leave no trace at all: on 10-28 and 11-04 the Facebook health line
    // simply never appeared, so nobody could say what Facebook had answered. Record the cause, once
    // per change, with the full evidence.
    let loggedProbeError = tracked.loggedProbeError;
    if (probeError && probeError !== loggedProbeError) {
      logEvent(streamId, platform, 'health_probe_unusable', detail.evidence ?? probeError);
      console.warn(`[health] ${platform}: no usable reading — ${detail.evidence ?? probeError}`);
      loggedProbeError = probeError;
    } else if (!probeError && loggedProbeError && s.receiving) {
      logEvent(streamId, platform, 'health_probe_usable', detail.evidence ?? 'reading available again');
      loggedProbeError = null;
    }
    const startedAt = legStartedAt(streamId, platform);
    // No running leg = treat as freshly started so we don't escalate against a leg the fan-out is
    // already in the middle of reconnecting.
    const legAgeMs = startedAt === null ? 0 : Date.now() - startedAt;

    const decision = decideHealthAction({
      sample: sourcePresent ? s : { ...s, probeFailed: true },
      counters: {
        consecutiveBad: tracked.consecutiveBad,
        restarts: tracked.restarts,
        consecutiveNoAudio: tracked.consecutiveNoAudio,
      },
      legAgeMs,
    });

    const previous = tracked.health.state;
    const audioAlarmWasSet = tracked.health.audioAlarm;
    const health: PlatformHealth = {
      state: decision.state,
      reason: sourcePresent ? decision.reason : 'Local video source is absent — platform health not meaningful',
      videoKbps: detail.videoKbps ?? null,
      audioKbps: detail.audioKbps ?? null,
      fps: detail.fps ?? null,
      pushKbps: legPushKbps(streamId, platform),
      warnings: detail.warnings ?? [],
      alarm: decision.action === 'alarm' || (tracked.health.alarm && decision.state === 'not_receiving'),
      audioAlarm: decision.audioAlarm,
      evidence: detail.evidence ?? null,
      checkedAt: Date.now(),
    };

    monitor.platforms.set(platform, {
      consecutiveBad: decision.consecutiveBad,
      restarts: decision.restarts,
      consecutiveNoAudio: decision.consecutiveNoAudio,
      loggedProbeError,
      health,
    });

    // Silent audio: for a prayer broadcast this is the worst outcome there is, and it is invisible to
    // every other signal — a muted mic still produces a full-bitrate, full-framerate picture. Alert on
    // the transition, and clear the suppression on recovery so a later recurrence alerts again.
    if (decision.audioAlarm && !audioAlarmWasSet) {
      const detailText = `${platform} is receiving video but NO AUDIO — check the microphone and the studio mixer`;
      logEvent(streamId, platform, 'audio_missing', detailText);
      console.error(`[health] ALARM ${detailText}`);
      sendAlert('audio_missing', platform, detailText);
    } else if (!decision.audioAlarm && audioAlarmWasSet) {
      logEvent(streamId, platform, 'audio_recovered', `${platform} audio is present again`);
      console.log(`[health] ${platform} audio is present again`);
      clearAlert('audio_missing', platform);
    }

    // Only log genuine transitions — a 20s poll would otherwise write thousands of rows per stream.
    if (decision.state !== previous && decision.state !== 'unknown') {
      // Our own push rate alongside theirs: "they see nothing, we send 4000 kbps" is a different
      // fault from "they see nothing, we send nothing".
      const pushing = health.pushKbps !== null ? `; we're sending ${health.pushKbps} kbps` : '';
      const bitrate = health.videoKbps !== null || pushing
        ? ` (${health.videoKbps !== null ? `${health.videoKbps} kbps` : 'no reading'}${pushing})`
        : '';
      logEvent(streamId, platform, `health_${decision.state}`, `${decision.reason}${bitrate}`);
      console.warn(`[health] ${platform}: ${decision.state} — ${decision.reason}${bitrate}`);
    }

    if (decision.action === 'restart_leg') {
      console.warn(`[health] ${platform} is not receiving — restarting its fan-out leg`);
      restartPlatformLeg(streamId, ps);
    } else if (decision.action === 'alarm') {
      logEvent(streamId, platform, 'health_alarm', decision.reason);
      console.error(`[health] ALARM ${platform}: ${decision.reason}`);
      const pushing = health.pushKbps !== null ? ` We are sending ${health.pushKbps} kbps.` : '';
      sendAlert('health_alarm', platform, `${decision.reason}.${pushing}`);
    } else if (decision.state === 'healthy' && previous === 'not_receiving') {
      // Recovered — allow a future outage on this platform to alert again.
      clearAlert('health_alarm', platform);
    }
  }
}

/** Begin polling platform health for a live stream. Idempotent. */
export function startHealthMonitor(streamId: string): void {
  if (monitors.has(streamId)) return;

  const monitor = { platforms: new Map(), polling: false, skipped: 0 } as Monitor;
  monitor.timer = setInterval(() => {
    // Never run two polls at once — see Monitor.polling.
    if (monitor.polling) {
      monitor.skipped++;
      if (monitor.skipped === 1 || monitor.skipped % 5 === 0) {
        console.warn(`[health] Previous poll still running — skipped ${monitor.skipped} tick(s); a platform API is slow`);
      }
      return;
    }
    monitor.polling = true;
    monitor.skipped = 0;
    void pollOnce(streamId, monitor)
      .catch((err) => {
        console.warn('[health] Poll failed:', err instanceof Error ? err.message : err);
      })
      .finally(() => { monitor.polling = false; });
  }, POLL_INTERVAL_MS);

  monitors.set(streamId, monitor);
  console.log(`[health] Monitoring platform ingest health every ${POLL_INTERVAL_MS / 1000}s`);
}

export function stopHealthMonitor(streamId: string): void {
  const monitor = monitors.get(streamId);
  if (!monitor) return;
  clearInterval(monitor.timer);
  monitors.delete(streamId);
  console.log('[health] Stopped monitoring platform ingest health');
}

/** Current per-platform health for the UI. Empty when the stream isn't being monitored. */
export function getStreamHealth(streamId: string): Record<string, PlatformHealth> {
  const monitor = monitors.get(streamId);
  if (!monitor) return {};
  return Object.fromEntries([...monitor.platforms].map(([platform, t]) => [platform, t.health]));
}

/**
 * Wait until a platform confirms it is receiving video, or give up. Used to gate the Facebook
 * LIVE_NOW publish (and its public announcement) on real ingest instead of a blind timer.
 */
export async function waitForPlatformReceiving(
  ps: PlatformStream,
  opts: { timeoutMs: number; intervalMs?: number },
): Promise<{ receiving: boolean; detail: Partial<PlatformHealth> }> {
  const intervalMs = opts.intervalMs ?? 3000;
  const deadline = Date.now() + opts.timeoutMs;
  let last: Partial<PlatformHealth> = {};

  for (;;) {
    const { sample: s, detail } = await sample(ps);
    last = detail;
    if (s.receiving) return { receiving: true, detail };
    if (Date.now() + intervalMs >= deadline) return { receiving: false, detail: last };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
