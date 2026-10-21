// Decide what to do when a new Web Studio WebSocket connects. Split out from ingest.ts so the
// takeover-vs-reject logic is unit-testable without real sockets/FFmpeg.

export type ConnectionDecision = 'accept' | 'reject-obs' | 'reject-active' | 'takeover';

export interface ConnectionInput {
  /** Is a studio session already attached? */
  hasActiveSession: boolean;
  /** ms since the active session last sent a media chunk (only meaningful when hasActiveSession). */
  sessionIdleMs: number;
  /** Beyond this idle time the active session is presumed dead and can be taken over. */
  staleMs: number;
  /** Is an external publisher (OBS) on the RTMP key? Only consulted when there's no studio session. */
  obsPublishing: boolean;
  /** Does the newcomer carry the same studio session id as the active session — i.e. is it the same
   *  page reconnecting after its own socket died? */
  sameOperator?: boolean;
}

/**
 * - With an existing studio session: take over at once if the newcomer is the SAME page reconnecting
 *   (its old socket is already dead from the browser's side, even if the server hasn't noticed yet).
 *   Otherwise take over only if the session looks DEAD (no chunks for `staleMs` — a crashed or
 *   closed-but-not-detected tab). A healthy, actively-streaming session is protected so an
 *   accidental second tab can't hijack a live broadcast — reject the newcomer instead.
 * - With no studio session: reject if OBS is publishing (can't run both on one RTMP key); else accept.
 *
 * Why same-operator matters: on 2026-10-14 the browser saw its socket die ~2s before the server did.
 * The page's own reconnect was then rejected as a
 * "second tab" twice, adding ~4s to each outage.
 */
export function decideStudioConnection({ hasActiveSession, sessionIdleMs, staleMs, obsPublishing, sameOperator = false }: ConnectionInput): ConnectionDecision {
  if (hasActiveSession) {
    if (sameOperator) return 'takeover';
    return sessionIdleMs >= staleMs ? 'takeover' : 'reject-active';
  }
  if (obsPublishing) return 'reject-obs';
  return 'accept';
}
