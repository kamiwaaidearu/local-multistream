// Timeouts for outbound platform HTTP calls.
//
// Node's fetch has NO default timeout: a server that accepts the connection and then never responds
// leaves the promise pending indefinitely. That is not a theoretical concern here — these calls now sit
// on the critical path of a live broadcast. An untimed probe can:
//   - stall the Facebook LIVE_NOW publish, so the broadcast never becomes visible at all;
//   - stall goLive's auth pre-flight while goLiveInFlight stays set, so every retry reports
//     "a go-live is already in progress" and the operator cannot get on air;
//   - overrun the health monitor's poll interval and let two polls run concurrently.
//
// A hung platform must degrade to "we don't know" quickly, never to "we're stuck".

/** Ceiling for a platform API call. Generous for a slow API, far below any interval that depends on it. */
export const PLATFORM_HTTP_TIMEOUT_MS = 10_000;

/**
 * An AbortSignal that fires after `ms`. Pass as `signal` to fetch; on expiry fetch rejects with a
 * TimeoutError, which every caller here already funnels into an indeterminate/errored result rather
 * than treating it as an authoritative answer from the platform.
 */
export function httpTimeout(ms: number = PLATFORM_HTTP_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}
