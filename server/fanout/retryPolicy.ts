// Retry policy for a per-platform fan-out relay that has exited while the stream is still live.
// Split out from ffmpeg.ts so the two-failure-mode decision is unit-testable.
//
// The key distinction (informed by the platforms' own reconnect behavior — Twitch's 90s window,
// Facebook's few-minute grace, YouTube's autoStop=false + reusable key):
//
//  - SOURCE GONE (local RTMP not publishing): the operator's ingest dropped, so every leg loses its
//    input at once. This is not a per-platform fault. Keep retrying at a steady, snappy cadence so
//    all legs resume the instant the source returns (comfortably inside each platform's reconnect
//    window). The stream-level watchdog ends the broadcast if the source never comes back, which
//    bounds this loop — so we never need to "give up" here.
//
//  - SOURCE PRESENT but this leg keeps dying: a genuine per-platform problem (bad key, platform
//    rejected the stream, a Facebook live video already closed, ...). Escalating backoff, then give
//    up and surface an error so the operator can reconnect that one platform — the other legs are
//    unaffected.

export const FANOUT_BACKOFF_MS = [5000, 10000, 20000];
export const FANOUT_RESET_AFTER_MS = 60000; // a leg that ran this long before dying was transient
export const FANOUT_SOURCE_ABSENT_RETRY_MS = 5000; // steady retry while waiting for the source back
export const MAX_PLATFORM_RETRIES = 3;

export interface FanoutRetryDecision {
  giveUp: boolean;
  delayMs: number;
  nextRetryCount: number;
}

export interface FanoutRetryInput {
  /** Is the local RTMP source publishing right now? (i.e. is there anything to relay). */
  sourcePresent: boolean;
  /** Consecutive failures charged to this leg while the source was present. */
  retryCount: number;
  /** How long this attempt ran before it exited. */
  ranMs: number;
  maxPlatformRetries?: number;
  backoffMs?: number[];
  resetAfterMs?: number;
  sourceAbsentRetryMs?: number;
}

export function decideFanoutRetry(input: FanoutRetryInput): FanoutRetryDecision {
  const {
    sourcePresent,
    retryCount,
    ranMs,
    maxPlatformRetries = MAX_PLATFORM_RETRIES,
    backoffMs = FANOUT_BACKOFF_MS,
    resetAfterMs = FANOUT_RESET_AFTER_MS,
    sourceAbsentRetryMs = FANOUT_SOURCE_ABSENT_RETRY_MS,
  } = input;

  // Source-side outage: not this platform's fault. Retry steadily, never give up, and don't charge
  // the per-platform failure budget (reset it) so a long outage can't later be misread as a
  // platform fault the moment the source returns.
  if (!sourcePresent) {
    return { giveUp: false, delayMs: sourceAbsentRetryMs, nextRetryCount: 0 };
  }

  // Source is present but the leg died. A leg that ran a good while before dying was a transient
  // blip, so reset its budget; otherwise it's repeatedly failing → count toward giving up.
  const effective = ranMs > resetAfterMs ? 0 : retryCount;
  if (effective >= maxPlatformRetries) {
    return { giveUp: true, delayMs: 0, nextRetryCount: effective };
  }
  return {
    giveUp: false,
    delayMs: backoffMs[Math.min(effective, backoffMs.length - 1)],
    nextRetryCount: effective + 1,
  };
}
