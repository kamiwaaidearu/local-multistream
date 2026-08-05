// Parser for FFmpeg's periodic progress lines, so the actual encode/push rate is recorded rather
// than merely streamed past in stderr.
//
// This exists because after the 2026-08-05 broadcast the single most useful question — "what bitrate
// were we actually sending?" — was unanswerable. FFmpeg had printed it hundreds of times on stderr
// and every copy was gone. Parsing it lets both the ingest and each fan-out leg log a periodic,
// greppable summary and report a live number to the UI.

export interface FfmpegProgress {
  fps: number | null;
  bitrateKbps: number | null;
  /** Encode speed relative to realtime. Below ~1.0 sustained means we're falling behind. */
  speed: number | null;
}

/**
 * Parse an FFmpeg progress line, e.g.
 *   frame= 1234 fps= 30 q=28.0 size=  12345kB time=00:00:41.00 bitrate=2464.9kbits/s speed=1.01x
 *
 * Returns null for anything that isn't a progress line. Fields absent from the line come back null
 * rather than 0 — "not reported" and "zero" mean very different things when diagnosing a dead stream.
 * `bitrate=N/A` (emitted before the first frames) is likewise null, not zero.
 */
export function parseProgress(line: string): FfmpegProgress | null {
  if (!line.includes('frame=') && !line.includes('bitrate=')) return null;

  const num = (re: RegExp): number | null => {
    const m = re.exec(line);
    if (!m) return null;
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : null;
  };

  const progress: FfmpegProgress = {
    fps: num(/\bfps=\s*([\d.]+)/),
    // Accept kbits/s and mbits/s; normalize to kbps.
    bitrateKbps: (() => {
      const m = /\bbitrate=\s*([\d.]+)\s*(k|m)bits\/s/i.exec(line);
      if (!m) return null;
      const v = Number(m[1]);
      if (!Number.isFinite(v)) return null;
      return m[2].toLowerCase() === 'm' ? Math.round(v * 1000) : Math.round(v);
    })(),
    speed: num(/\bspeed=\s*([\d.]+)x/),
  };

  // A line that matched the shape but yielded nothing useful isn't progress.
  if (progress.fps === null && progress.bitrateKbps === null && progress.speed === null) return null;
  return progress;
}

/**
 * Throttled progress reporter. FFmpeg emits progress several times a second; we want a periodic
 * summary in the log, not a flood — the ingest in particular shares its event loop with the WebSocket
 * feeding webm into FFmpeg, so logging every line would be actively harmful.
 *
 * Tracks the latest reading (for the UI) and tells the caller when it's time to log again.
 */
export class ProgressTracker {
  // null, not 0: the FIRST reading must always log. It's the one that confirms the stream came up at
  // the expected bitrate, so suppressing it for the throttle window would hide the most useful line.
  private lastLoggedAt: number | null = null;
  latest: FfmpegProgress | null = null;

  constructor(private readonly logIntervalMs: number) {}

  /** Feed a stderr line. Returns a summary string when it's time to log, else null. */
  update(line: string, now = Date.now()): string | null {
    const progress = parseProgress(line);
    if (!progress) return null;
    this.latest = progress;

    if (this.lastLoggedAt !== null && now - this.lastLoggedAt < this.logIntervalMs) return null;
    this.lastLoggedAt = now;
    return describeProgress(progress);
  }
}

/** Compact operator-facing summary of a progress reading. */
export function describeProgress(p: FfmpegProgress): string {
  const parts = [
    p.bitrateKbps !== null ? `${p.bitrateKbps} kbps` : 'bitrate n/a',
    p.fps !== null ? `${p.fps} fps` : null,
    p.speed !== null ? `${p.speed}x realtime` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}
