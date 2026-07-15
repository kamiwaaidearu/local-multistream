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
 * (`keepReconnecting`), we must NOT give up at ~38s — the stream stays live for longer (the
 * server's abandoned-stream watchdog only ends it after ~90s), so a 40–90s network dip should
 * self-heal rather than stranding a recoverable stream behind a manual reconnect. In that mode we
 * keep retrying at the capped (last) backoff indefinitely.
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
