// Recovery logic for a Web Studio broadcast whose source tab was closed/reloaded mid-stream.

export type StudioConnStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type SourceMode = 'obs' | 'studio';

/**
 * Whether to surface the "Reconnect Studio" prompt. Only when the stream is live via Web Studio in
 * this tab AND the Studio transport is not currently up — i.e. the tab was closed/reloaded
 * mid-broadcast and the panel remounted disconnected, leaving no other way back in (the "Go Live"
 * button that normally wires up connect only exists in the pre-live "ready" phase).
 *
 * 'connecting' counts as up: a (re)connect is already in flight, so we don't nag during it. Both
 * 'disconnected' and 'error' should show it — from either, the operator needs a way to re-establish.
 */
export function shouldShowStudioReconnect(
  streamStatus: string,
  mode: SourceMode,
  studioStatus: StudioConnStatus,
): boolean {
  return streamStatus === 'live'
    && mode === 'studio'
    && studioStatus !== 'connected'
    && studioStatus !== 'connecting';
}
