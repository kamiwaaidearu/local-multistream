import { createContext, useContext } from 'react';

export interface StudioLiveValue {
  /**
   * The id of the stream THIS browser tab is live-sourcing via the Web Studio, or null when
   * nothing is live here. Navigating away unmounts the capture/WebSocket and would interrupt the
   * broadcast, so the app shell guards navigation while this is set — and uses the id to end the
   * stream cleanly before leaving. OBS-sourced streams stay null (OBS publishes independently of
   * this tab, so leaving the page doesn't interrupt them).
   */
  liveStreamId: string | null;
  setLiveStreamId: (id: string | null) => void;
}

export const StudioLiveContext = createContext<StudioLiveValue>({
  liveStreamId: null,
  setLiveStreamId: () => {},
});

export function useStudioLive(): StudioLiveValue {
  return useContext(StudioLiveContext);
}

// Synchronous flag (deliberately not React state — beforeunload fires in the same tick as the
// logout redirect, before any re-render) that lets an intentional logout skip StreamPage's
// beforeunload guard. Without it, logging out while live double-prompts: once via the logout
// modal, then again via the browser's native "Leave?" dialog.
let intentionalExit = false;
export function markIntentionalExit(): void {
  intentionalExit = true;
}
export function isIntentionalExit(): boolean {
  return intentionalExit;
}
