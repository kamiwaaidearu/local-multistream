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
}

/**
 * - With an existing studio session: take over only if it looks DEAD (no chunks for `staleMs` — a
 *   crashed/closed-but-not-detected tab). A healthy, actively-streaming session is protected so an
 *   accidental second tab can't hijack a live broadcast — reject the newcomer instead.
 * - With no studio session: reject if OBS is publishing (can't run both on one RTMP key); else accept.
 */
export function decideStudioConnection({ hasActiveSession, sessionIdleMs, staleMs, obsPublishing }: ConnectionInput): ConnectionDecision {
  if (hasActiveSession) {
    return sessionIdleMs >= staleMs ? 'takeover' : 'reject-active';
  }
  if (obsPublishing) return 'reject-obs';
  return 'accept';
}
