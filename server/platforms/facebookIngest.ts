// Pure interpretation of Facebook's live-video ingest response, split from facebook.ts so it can be
// unit-tested without the DB, config, or network.
//
// Why this exists: from 2026-10-21 on, every go-live ended in "Facebook never confirmed it was
// receiving video" and the announcement post was suppressed, yet Facebook recorded full-length VODs
// (10-28: 1888 s for a 31.7 min broadcast; 11-04: 1531 s for 25.7 min). The probe was returning
// something we could not use, and we never recorded WHAT. `evidence` fixes that: every probe now
// says, in plain words, exactly what Facebook sent back, and that text reaches the event log.

/** Facebook's own measurement of what it is receiving on the ingest stream. */
export interface FacebookIngestHealth {
  /** FB's live-video status (LIVE, LIVE_STOPPED, UNPUBLISHED, VOD, …), or null if not reported. */
  status: string | null;
  /** True when FB reports an ingest stream carrying a non-zero video bitrate. The authoritative
   *  "is Facebook actually getting our video" signal — see getFacebookIngestHealth. */
  receiving: boolean;
  videoKbps: number | null;
  audioKbps: number | null;
  fps: number | null;
  /** Keyframe interval in milliseconds, as FB measures it. Must stay <= 2000. */
  gopMs: number | null;
  width: number | null;
  height: number | null;
  /** Set when health is unknown: the probe failed, or FB answered without a usable reading. */
  error: string | null;
  /** What Facebook actually returned, in words, for the event log. Always set. */
  evidence: string;
  /** The ingest stream's DASH preview manifest URL, when FB gives one. Used only for diagnostics. */
  dashPreviewUrl: string | null;
}

export interface RawIngestStream {
  id?: string;
  is_master?: boolean;
  stream_health?: Record<string, unknown> | null;
  dash_preview_url?: string;
  [key: string]: unknown;
}

export interface RawLiveVideoIngest {
  status?: string;
  ingest_streams?: RawIngestStream[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const kbps = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n / 1000);
};

/** Turn a 200 response from `GET /{live-video-id}?fields=status,ingest_streams{…}` into a health reading. */
export function interpretFacebookIngest(data: RawLiveVideoIngest): FacebookIngestHealth {
  const status = data.status ?? null;
  const streams = Array.isArray(data.ingest_streams) ? data.ingest_streams : [];
  // Prefer the stream FB has designated master; with no backup stream configured there's just one.
  const stream = streams.find((s) => s.is_master) ?? streams[0];
  const health = stream?.stream_health ?? null;
  const dashPreviewUrl = typeof stream?.dash_preview_url === 'string' ? stream.dash_preview_url : null;

  const base = {
    status, videoKbps: null, audioKbps: null, fps: null, gopMs: null, width: null, height: null, dashPreviewUrl,
  };

  if (!stream) {
    // No ingest stream at all: Facebook positively has nothing to measure. Still counts as bad.
    return { ...base, receiving: false, error: null, evidence: `status ${status ?? 'unreported'}; no ingest_streams` };
  }

  if (!health || typeof health !== 'object') {
    // An ingest stream with no reading is UNKNOWN, not "receiving nothing": on 2026-10-21 reading it as
    // "not receiving" triggered a leg restart that ended the Facebook broadcast. Name the fields FB did
    // send, so the next occurrence tells us what changed instead of just "never confirmed".
    const fields = Object.keys(stream).filter((k) => k !== 'id').sort().join(',') || 'none';
    return {
      ...base,
      receiving: false,
      error: 'Facebook returned an ingest stream without stream_health',
      evidence: `status ${status ?? 'unreported'}; ${streams.length} ingest stream(s), no stream_health (fields: ${fields})`,
    };
  }

  const videoKbps = kbps(health.video_bitrate);
  const keys = Object.keys(health).sort().join(',') || 'none';
  return {
    ...base,
    receiving: videoKbps !== null && videoKbps > 0,
    videoKbps,
    audioKbps: kbps(health.audio_bitrate),
    fps: num(health.video_framerate),
    gopMs: num(health.video_gop_size),
    width: num(health.video_width),
    height: num(health.video_height),
    error: null,
    evidence: videoKbps !== null
      ? `status ${status ?? 'unreported'}; stream_health video ${videoKbps} kbps`
      : `status ${status ?? 'unreported'}; stream_health without video_bitrate (keys: ${keys})`,
  };
}

/** A probe that could not get a usable answer at all (HTTP error, network, permissions). */
export function unknownFacebookIngest(error: string): FacebookIngestHealth {
  return {
    status: null, receiving: false, videoKbps: null, audioKbps: null, fps: null, gopMs: null,
    width: null, height: null, error, evidence: `probe failed: ${error}`, dashPreviewUrl: null,
  };
}

/**
 * Describe a fetch of the ingest stream's DASH preview manifest, for the diagnostic log.
 *
 * This is NOT a confirmation signal. It is recorded so the next broadcast shows whether the manifest
 * carries segments while live (a playable artifact on Facebook's side), which would make it a candidate
 * fallback for when stream_health is missing. It has not been measured on a live broadcast yet, and the
 * 2026-08-05 lesson (a 200 from Facebook is not proof of video) means it must be before anything acts on it.
 */
export function describeDashManifest(httpStatus: number, body: string): string {
  if (httpStatus !== 200) return `DASH preview HTTP ${httpStatus}`;
  const segments = (body.match(/<S\b/g) ?? []).length;
  const reps = (body.match(/<Representation\b/g) ?? []).length;
  const type = body.match(/\btype="(\w+)"/)?.[1] ?? 'unknown';
  return `DASH preview HTTP 200, type ${type}, ${reps} representation(s), ${segments} segment timeline entr${segments === 1 ? 'y' : 'ies'}`;
}
