// Reconnect policy for the Web Studio transport, split out from the hook so the give-up/backoff
// decision is unit-testable.

// Base schedule. The first delay is deliberately not tiny: the server needs a moment to release the
// previous ingest FFmpeg / RTMP publish before a new session can take over.
export const MAX_RECONNECT_ATTEMPTS = 6;
export const RECONNECT_BACKOFF_MS = [2000, 3000, 5000, 8000, 10000, 10000];

export interface ReconnectStep {
  giveUp: boolean;
  delayMs: number;
}

/**
 * Decide the next reconnect step given how many attempts have already been made.
 *
 * Normally we give up after MAX_RECONNECT_ATTEMPTS so a genuinely broken pre-live connection
 * surfaces an error instead of spinning forever. But while the broadcast is live server-side
 * (`keepReconnecting`), we must NOT give up at ~38s — the stream stays live far longer (the
 * server's abandoned-stream watchdog only ends it after 5 min), so a multi-minute network dip
 * should self-heal rather than stranding a recoverable stream behind a manual reconnect. In that
 * mode we keep retrying at the capped (last) backoff indefinitely.
 */
export function nextReconnectStep(
  attempt: number,
  keepReconnecting: boolean,
  opts: { maxAttempts?: number; backoffMs?: number[] } = {},
): ReconnectStep {
  const maxAttempts = opts.maxAttempts ?? MAX_RECONNECT_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? RECONNECT_BACKOFF_MS;
  if (attempt >= maxAttempts && !keepReconnecting) return { giveUp: true, delayMs: 0 };
  const delayMs = backoffMs[Math.min(attempt, backoffMs.length - 1)];
  return { giveUp: false, delayMs };
}

/**
 * Whether a WebSocket close code means "stop trying" vs "retry".
 * - 4001 (OBS is publishing) and 4004 (a newer session took this slot over): always fatal — another
 *   owner holds the slot, so retrying would just fight it.
 * - 4000 ("another session is already active"): fatal PRE-live, but retryable while live — it may be
 *   our OWN stale socket the server hasn't reclaimed yet (a fast reconnect racing the server's
 *   staleness window). Retrying lets the takeover succeed once the old socket goes stale.
 * - Everything else (unexpected network drops, the 4003 ingest-restart bounce, ...): not fatal.
 */
export function isFatalCloseCode(code: number, keepReconnecting: boolean): boolean {
  if (code === 4001 || code === 4004) return true;
  if (code === 4000) return !keepReconnecting;
  return false;
}
