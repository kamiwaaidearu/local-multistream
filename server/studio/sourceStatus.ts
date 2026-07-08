// Pure resolution of the active ingest source for /api/studio/status, split out so it can be
// unit-tested without spinning up the RTMP server or the studio WebSocket.

export type SourceKind = 'studio' | 'obs';

export interface SourceStatus {
  connected: boolean;
  source: SourceKind | null;
}

/**
 * Decide which source is publishing. Both a live Web Studio session and OBS end up publishing to
 * the same local RTMP key (Studio via its own ingest FFmpeg), so `rtmpPublishing` alone can't tell
 * them apart. The Web Studio WebSocket (`studioConnected`) is Studio-only, so it's the tiebreaker:
 * if it's up the publisher is Studio; otherwise anything on the RTMP key is OBS.
 */
export function resolveSourceStatus(studioConnected: boolean, rtmpPublishing: boolean): SourceStatus {
  let source: SourceKind | null = null;
  if (studioConnected) source = 'studio';
  else if (rtmpPublishing) source = 'obs';
  return { connected: studioConnected || rtmpPublishing, source };
}
