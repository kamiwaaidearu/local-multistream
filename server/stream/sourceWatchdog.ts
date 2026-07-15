// Watchdog for abandoned live streams. If a Web Studio tab is closed (or the operator's machine
// drops off) mid-broadcast and never comes back, the stream stays 'live' with the platform
// broadcasts open — nothing on the server ends them. This periodically checks whether a video
// source is still present for each live stream and, once one has been gone longer than a grace
// period, ends it cleanly so YouTube/Facebook/Twitch aren't left dangling.
//
// The client auto-reconnects a reloaded studio within a second or two and the fan-out retries for
// ~35s, so the grace period is deliberately generous — it should only fire for a genuinely
// abandoned broadcast, never a brief blip the client is already recovering from.

import { getDb } from '../db/index.js';

export interface WatchdogDecision {
  shouldEnd: boolean;
  lastSeenAt: number;
}

/**
 * Pure per-stream step. A present source always refreshes `lastSeenAt` to `now`; an absent source
 * leaves it unchanged and asks to end the stream once the gap since the last sighting reaches
 * `graceMs`. Kept separate from the timer/DB glue so the timing logic is unit-testable.
 */
export function evaluateSourcePresence(
  lastSeenAt: number,
  sourcePresent: boolean,
  now: number,
  graceMs: number,
): WatchdogDecision {
  if (sourcePresent) return { shouldEnd: false, lastSeenAt: now };
  return { shouldEnd: now - lastSeenAt >= graceMs, lastSeenAt };
}

// End an abandoned broadcast 5 minutes after its source disappears. Deliberately generous: it must
// never end a *recoverable* stream, so it has to outlast (a) a router/modem reboot (~1-3 min) the
// operator is waiting out, (b) a network drop with the tab still open, and (c) a deliberate
// tab-reopen where they re-share slides + camera before reconnecting. We intentionally do NOT cap
// this to Facebook's few-minute live-video ceiling: FB may be lost past that, but YouTube (with
// autoStop off + a reusable key) and Twitch can still resume from a longer outage, and killing the
// whole broadcast to match the one platform we've already lost would be backwards. The only cost of
// going long is that a genuinely abandoned stream lingers a few extra minutes (endable manually from
// any device) before auto-cleanup. Tune here if that balance needs adjusting.
const GRACE_MS = 300_000;
const TICK_MS = 15_000;

const lastSeen = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic watchdog. Idempotent. */
export function startSourceWatchdog(): void {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, TICK_MS);
  timer.unref?.(); // don't keep the event loop alive just for the watchdog
}

/** Stop the watchdog and clear its bookkeeping. */
export function stopSourceWatchdog(): void {
  if (timer) { clearInterval(timer); timer = null; }
  lastSeen.clear();
}

async function tick(): Promise<void> {
  // Wrap the whole body: this runs from setInterval, so an unhandled throw here would surface as an
  // unhandled promise rejection (which can terminate the process on modern Node). Never let the
  // watchdog take the server down.
  try {
    await runTick();
  } catch (err) {
    console.error('[watchdog] tick failed:', err);
  }
}

async function runTick(): Promise<void> {
  const db = getDb();
  const live = db.prepare("SELECT id FROM streams WHERE status = 'live'").all() as Array<{ id: string }>;
  const liveIds = new Set(live.map((s) => s.id));

  // Forget streams that are no longer live (ended normally, reconciled, etc.).
  for (const id of [...lastSeen.keys()]) if (!liveIds.has(id)) lastSeen.delete(id);
  if (live.length === 0) return;

  // Source presence is a process-wide signal (the app allows only one live stream at a time, so it
  // maps to that stream). Both signals: OBS/warmed-Studio publishing RTMP, or a Studio WebSocket.
  const { isRtmpPublishing } = await import('../rtmp/server.js');
  const { isStudioConnected } = await import('../studio/ingest.js');
  const present = isRtmpPublishing() || isStudioConnected();
  const now = Date.now();

  for (const { id } of live) {
    const seen = lastSeen.get(id) ?? now; // seed on first sighting so the grace starts now
    const { shouldEnd, lastSeenAt } = evaluateSourcePresence(seen, present, now, GRACE_MS);
    lastSeen.set(id, lastSeenAt);
    if (!shouldEnd) continue;

    lastSeen.delete(id);
    console.warn(`[watchdog] Stream ${id} has had no video source for ${GRACE_MS / 1000}s — ending it to close platform broadcasts.`);
    try {
      const { endStream } = await import('./manager.js');
      await endStream(id);
    } catch (err) {
      // e.g. the operator ended it between the SELECT and here — harmless.
      console.error('[watchdog] Failed to auto-end abandoned stream:', err);
    }
  }
}
