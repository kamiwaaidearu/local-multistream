// Pure logic behind the studio's required video check — the video counterpart of audioCheck.ts.
//
// The platforms cannot tell an empty studio from a real one: the compositor always paints the template
// background, so with no camera and no slides the encoder still sends a full-bitrate 30 fps stream and
// every platform reports a healthy ingest. A closed privacy shutter looks the same. So, like silence,
// "no video" is only observable in the browser, before encoding, and that is where go-live checks it.

export type VideoSourceState =
  /** Not turned on. */
  | 'off'
  /** Turned on, but its frames are not in the layout, so viewers would not see it. */
  | 'not_in_layout'
  /** Turned on, no frames yet (just started, or the device is not delivering). */
  | 'waiting'
  /** Delivering frames, but they are black — a privacy shutter, lens cap, or a blank share. */
  | 'black'
  | 'ok';

/** Brightest sampled pixel below this (0..255 luma) means the whole frame is black. Any slide text or a
 *  camera in a dim room clears it; a closed shutter or covered lens does not. */
export const BLACK_MAX_LUMA = 24;

/** While live, how long video must be missing before we warn. */
export const LIVE_VIDEO_ALERT_MS = 15_000;

export interface VideoSample {
  enabled: boolean;
  inLayout: boolean;
  /** HTMLMediaElement.readyState of the element the compositor draws from. */
  readyState: number;
  videoWidth: number;
  /** Brightest pixel in a downscaled sample frame, or null if not sampled. */
  maxLuma: number | null;
}

export function classifyVideoSource(s: VideoSample): VideoSourceState {
  if (!s.enabled) return 'off';
  if (!s.inLayout) return 'not_in_layout';
  if (s.readyState < 2 || s.videoWidth === 0 || s.maxLuma === null) return 'waiting';
  if (s.maxLuma < BLACK_MAX_LUMA) return 'black';
  return 'ok';
}

/** Every source go-live requires. Both, by the operator's rule: a rosary broadcast is the presenter on
 *  camera plus the prayer slides, and missing either is not a broadcast to go live with. */
export const REQUIRED_VIDEO_SOURCES = ['camera', 'slides'] as const;
export type VideoSourceName = (typeof REQUIRED_VIDEO_SOURCES)[number];

/** Go-live needs every required source showing a real picture in the layout. */
export function isVideoReady(states: Readonly<Record<VideoSourceName, VideoSourceState>>): boolean {
  return REQUIRED_VIDEO_SOURCES.every((name) => states[name] === 'ok');
}

/** Max luma (Rec. 601) over RGBA pixel data. */
export function maxLumaOf(rgba: ArrayLike<number>): number {
  let max = 0;
  for (let i = 0; i + 2 < rgba.length; i += 4) {
    const y = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    if (y > max) max = y;
  }
  return max;
}

/** Operator-facing explanation for a source that is not ok. */
export function describeVideoState(label: string, state: VideoSourceState): string | null {
  switch (state) {
    case 'not_in_layout': return `${label} is on but isn’t in the layout, so viewers won’t see it.`;
    case 'waiting': return `${label} is on but no picture has arrived yet.`;
    case 'black': return `${label} is showing a black picture — check the privacy shutter or lens cover.`;
    default: return null;
  }
}
