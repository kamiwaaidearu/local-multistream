// Upload-bandwidth probe for Web Studio. Streams incompressible bytes over a dedicated
// WebSocket (/ws/bandwidth) and measures the rate at which the SERVER confirms receipt — i.e.
// true end-to-end upload throughput from the operator's browser to the origin (operator →
// Cloudflare edge → tunnel → server). That's the one leg that limits Web Studio ingest, so we
// use it to recommend a stream quality the operator's connection can actually sustain.

import { wsUrl } from './ws';
import { getAuthToken } from './authToken';

export type QualityKey = 'low' | 'medium' | 'high';

export interface QualityPreset {
  key: QualityKey;
  label: string;
  videoBps: number;
  description: string;
}

// Leg-1 (browser MediaRecorder) video target bitrates. The composite is always 1080p; the
// server re-encodes to its own fixed target regardless, so these only need to fit the
// operator's uplink — not match the output.
export const QUALITY_PRESETS: Record<QualityKey, QualityPreset> = {
  low: {
    key: 'low',
    label: 'Low — 1080p · 2.5 Mbps',
    videoBps: 2_500_000,
    description: 'For weak or shared connections',
  },
  medium: {
    key: 'medium',
    label: 'Medium — 1080p · 4.5 Mbps',
    videoBps: 4_500_000,
    description: 'Recommended for most connections',
  },
  high: {
    key: 'high',
    label: 'High — 1080p · 6.5 Mbps',
    videoBps: 6_500_000,
    description: 'For strong connections',
  },
};

// The quality preset selected before any bandwidth measurement runs. Low on purpose: a slow or
// unmeasured connection must never over-commit its uplink, and the auto probe raises it to whatever
// the link can actually sustain. Single source of truth for the Studio panel and the stream hook.
export const DEFAULT_QUALITY: QualityKey = 'low';

// Headroom: measured upload must exceed the stream's TOTAL (video+audio) bitrate by this factor.
// Industry guidance for live streaming runs ~1.5x at minimum (Twitch's stated rule) up to ~2x
// ("use no more than half your upload"). We use 1.6x: a remote, tunneled uplink wants margin for
// congestion and wifi dips, but the probe already measures sustained (not peak) throughput, so it
// needn't also absorb a peak-vs-sustained gap. Raise toward 2.0 if operators report buffering.
const HEADROOM = 1.6;
// The studio always sends ~160 kbps of audio alongside the video (see useStudioStream).
const AUDIO_MBPS = 0.16;

/** Below this measured upload, even the lowest preset lacks comfortable headroom. */
export const MIN_VIABLE_MBPS = (QUALITY_PRESETS.low.videoBps / 1_000_000 + AUDIO_MBPS) * HEADROOM;

/**
 * Recommend the highest preset whose total (video + audio) bitrate fits within the measured
 * upload divided by HEADROOM. See HEADROOM for the industry rationale.
 */
export function recommendQuality(mbps: number): QualityKey {
  for (const key of ['high', 'medium', 'low'] as const) {
    const totalMbps = QUALITY_PRESETS[key].videoBps / 1_000_000 + AUDIO_MBPS;
    if (mbps >= totalMbps * HEADROOM) return key;
  }
  return 'low';
}

export interface ProbeSample {
  /** Cumulative bytes the server has confirmed receiving. */
  bytes: number;
  /** Client-side timestamp (performance.now()) when that ack arrived. */
  t: number;
}

/**
 * Steady-state upload throughput in Mbps from a series of server-confirmed-byte acks. Drops
 * samples within `warmupMs` of `startTs` (the TCP slow-start ramp), then takes the byte/time
 * delta across the remaining window. If fewer than two samples survive the warm-up it falls back
 * to the full series. Returns null when there isn't enough to compute a rate (under two samples,
 * or zero elapsed time). Never negative.
 */
export function computeMbps(samples: ProbeSample[], startTs: number, warmupMs: number): number | null {
  const usable = samples.filter((s) => s.t - startTs >= warmupMs);
  const series = usable.length >= 2 ? usable : samples;
  if (series.length < 2) return null;
  const a = series[0];
  const b = series[series.length - 1];
  const seconds = (b.t - a.t) / 1000;
  if (seconds <= 0) return null;
  return Math.max(0, ((b.bytes - a.bytes) * 8) / seconds / 1_000_000);
}

export interface ProbeOptions {
  /** Total run time in ms (includes a ~1s warm-up that's discarded). Default 6000. */
  durationMs?: number;
}

/**
 * Measure upload throughput to the server, in Mbps. Resolves with the steady-state rate
 * (warm-up discarded) or rejects if the probe can't run (no socket, auth failure, no data).
 */
export function measureUploadMbps(opts: ProbeOptions = {}): Promise<number> {
  const durationMs = opts.durationMs ?? 6000;
  const WARMUP_MS = 1000;
  const CONNECT_TIMEOUT_MS = 8000; // reject (don't hang) if the socket never finishes its upgrade
  const MIN_SAMPLES = 3; // fewer acks than this means the probe stalled — don't trust the number
  const MAX_BYTES = 80 * 1024 * 1024; // courtesy cap so a fast link doesn't push hundreds of MB
  const CHUNK = 256 * 1024;
  const MAX_BUFFERED = 1024 * 1024; // keep <=1 MB queued in the browser; send at the drain rate

  return new Promise<number>((resolve, reject) => {
    const token = getAuthToken();
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${wsUrl('/ws/bandwidth')}?token=${encodeURIComponent(token)}`);
    } catch (err) {
      reject(err instanceof Error ? err : new Error('Failed to open probe socket'));
      return;
    }
    ws.binaryType = 'arraybuffer';

    // One high-entropy buffer, reused. The server disables permessage-deflate, so this is never
    // compressed in transit and the byte count stays honest. (getRandomValues caps at 64 KB.)
    const buf = new Uint8Array(CHUNK);
    for (let off = 0; off < CHUNK; off += 65536) {
      crypto.getRandomValues(buf.subarray(off, Math.min(off + 65536, CHUNK)));
    }

    const samples: ProbeSample[] = [];
    let startT = 0;
    let pump = 0;
    let durationTimer = 0;
    let connectTimer = 0;
    let opened = false;
    let done = false;

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      window.clearTimeout(connectTimer);
      window.clearTimeout(durationTimer);
      window.clearInterval(pump);
      try { ws.close(); } catch { /* ignore */ }
      if (err) { reject(err); return; }

      // Steady-state rate = Δ(server-confirmed bytes) / Δ(wall clock), warm-up discarded.
      if (samples.length < MIN_SAMPLES) {
        reject(new Error('Bandwidth probe was inconclusive — too little data'));
        return;
      }
      const mbps = computeMbps(samples, startT, WARMUP_MS);
      if (mbps === null) {
        reject(new Error('Bandwidth probe was inconclusive'));
        return;
      }
      resolve(mbps);
    };

    // If the socket never finishes its upgrade (stalled proxy/tunnel, captive portal), bail out
    // instead of leaving the promise — and the UI spinner — hanging forever.
    connectTimer = window.setTimeout(
      () => finish(new Error('Bandwidth probe could not connect')),
      CONNECT_TIMEOUT_MS,
    );

    ws.onopen = () => {
      opened = true;
      window.clearTimeout(connectTimer);
      startT = performance.now();
      // Top the send buffer back up to ~1 MB every tick. When the buffer is full we stop, so we
      // naturally push at exactly the rate the connection drains = the throughput we measure.
      pump = window.setInterval(() => {
        if (done) return;
        while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < MAX_BUFFERED) {
          ws.send(buf);
        }
      }, 20);
      durationTimer = window.setTimeout(() => finish(), durationMs);
    };

    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return; // acks are JSON text; ignore anything else
      try {
        const { bytes } = JSON.parse(e.data) as { bytes?: number };
        if (typeof bytes === 'number') {
          samples.push({ bytes, t: performance.now() });
          if (bytes >= MAX_BYTES) finish();
        }
      } catch { /* ignore malformed ack */ }
    };

    ws.onerror = () => finish(new Error('Bandwidth probe connection error'));
    // A close we didn't initiate (server refused the probe, hit its safety timer, or the network
    // dropped) means the measurement was cut short — reject rather than resolve a misleadingly low
    // number. If we already finished normally, `done` makes this a no-op.
    ws.onclose = (e) =>
      finish(new Error(e.reason || (opened ? 'Bandwidth probe ended early' : 'Bandwidth probe could not connect')));
  });
}
