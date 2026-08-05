// Per-destination encoding decisions for the fan-out legs. Pure, so the copy-vs-transcode choice and
// the exact ffmpeg arguments are unit-testable without spawning anything.
//
// Why this exists: the fan-out used to be `-c copy` to every platform, which meant ONE bitrate for
// all of them — 4500 kbps. That was simultaneously over Facebook's documented 4000 kbps maximum and
// below what YouTube wants, and on 2026-08-05 Facebook produced a 0:00-duration video. Now the ingest
// encodes once at the highest useful rate and only legs whose platform caps lower get re-encoded.

import { buildVideoArgs, type VideoEncoder } from '../studio/encoderConfig.js';

/**
 * Documented per-platform video-bitrate ceilings, in kbps.
 *
 * - facebook: 4000 is Facebook's stated recommended maximum for Live. Going over it is the one cap
 *   here that has actually bitten us, so this is the value that forces a transcode.
 * - twitch: 6000 is Twitch's ceiling for non-partnered channels.
 * - youtube: 9000 is the top of YouTube's recommended 1080p range. We're deliberately NOT capping
 *   YouTube near its 1080p30 sweet spot (6000) — it accepts more happily, and a needless transcode
 *   would cost a generation of quality for nothing.
 */
export const PLATFORM_MAX_KBPS: Record<string, number> = {
  youtube: 9000,
  facebook: 4000,
  twitch: 6000,
};

export type LegEncoding =
  /** Pass the ingest through untouched — no second encode, no generation loss. */
  | { mode: 'copy' }
  /** Re-encode video down to `videoKbps`; audio is still copied. */
  | { mode: 'transcode'; videoKbps: number };

/**
 * How should this platform's leg be fed? Copy whenever the ingest already fits under the platform's
 * ceiling, transcode down to that ceiling when it doesn't. An unknown platform is copied rather than
 * guessed at — a missing entry must never silently degrade a working leg.
 */
export function decideLegEncoding(platform: string, ingestKbps: number): LegEncoding {
  const cap = PLATFORM_MAX_KBPS[platform];
  if (cap === undefined || ingestKbps <= cap) return { mode: 'copy' };
  return { mode: 'transcode', videoKbps: cap };
}

export interface LegArgsInput {
  input: string;
  output: string;
  encoding: LegEncoding;
  /** Only consulted for a transcode. */
  encoder: VideoEncoder;
  preset: string;
}

/**
 * The full ffmpeg argument list for one fan-out leg.
 *
 * A transcoding leg re-encodes VIDEO only and copies audio: the ingest's AAC is already 160 kbps
 * 48 kHz stereo, inside every platform's audio limits, so re-encoding it would add a generation of
 * loss and another chance to reintroduce the timestamp drift that aresample fixed at ingest.
 */
export function buildLegArgs(input: LegArgsInput): string[] {
  const head = [
    // 10s I/O timeout (microseconds) — prevents an instant crash on brief RTMP hiccups.
    '-rw_timeout', '10000000',
    '-i', input.input,
  ];
  const tail = ['-flvflags', 'no_duration_filesize', '-f', 'flv', input.output];

  if (input.encoding.mode === 'copy') {
    return [...head, '-c', 'copy', ...tail];
  }

  return [
    ...head,
    // Same CBR + 2s-keyframe discipline as the ingest encode, just at the platform's ceiling.
    ...buildVideoArgs(input.encoder, input.preset, input.encoding.videoKbps),
    '-c:a', 'copy',
    ...tail,
  ];
}

/** One-line operator-facing summary of a leg's encoding, for the startup log. */
export function describeLegEncoding(platform: string, encoding: LegEncoding, ingestKbps: number): string {
  return encoding.mode === 'copy'
    ? `${platform}: copy (${ingestKbps} kbps passthrough)`
    : `${platform}: transcode to ${encoding.videoKbps} kbps (platform cap; ingest is ${ingestKbps})`;
}
