// Pure decision logic for the per-platform ingest health monitor, split from healthMonitor.ts so
// the escalation rules can be unit-tested without network calls, timers, or a live stream.
//
// Background: our only previous health signal was "did the fan-out FFmpeg process die". That misses
// the failure mode that actually took Facebook down on 2026-08-05 — FFmpeg pushed happily for 24
// minutes while Facebook produced a 0:00 video. So the monitor asks each platform what IT is
// receiving, and this module decides what to do about the answer.

export type HealthState =
  /** No usable reading — probe failed, or the leg is still inside its warm-up window. */
  | 'unknown'
  /** Platform confirms it's receiving video, no complaints. */
  | 'healthy'
  /** Receiving, but the platform is complaining (e.g. YouTube videoBitrateLow). */
  | 'degraded'
  /** Platform confirms it is NOT receiving video. */
  | 'not_receiving';

export type HealthAction =
  | 'none'
  /** Respawn this platform's fan-out leg — same ingest URL, invisible to viewers. */
  | 'restart_leg'
  /** Restarts are exhausted; escalate to the operator. */
  | 'alarm';

export interface HealthSample {
  /** The platform says it is receiving video right now. */
  receiving: boolean;
  /** The probe itself failed (network, permissions, dead token) — health is UNKNOWN, not bad. */
  probeFailed: boolean;
  /** Non-fatal quality complaints from the platform, e.g. ['videoBitrateLow']. */
  warnings: string[];
}

/** Per-platform counters the monitor carries between polls. */
export interface HealthCounters {
  consecutiveBad: number;
  restarts: number;
}

export interface HealthDecision extends HealthCounters {
  state: HealthState;
  action: HealthAction;
  /** Operator-facing explanation, for the event log and the UI. */
  reason: string;
}

/** A freshly (re)started leg needs time to connect AND for the platform to measure it. Facebook's
 *  stream_health in particular reports nothing for the first several seconds. */
export const DEFAULT_GRACE_MS = 25_000;
/** Consecutive confirmed-bad polls before we touch anything. At a 20s interval that's ~40s of
 *  genuine silence — long enough not to react to a single stale reading. */
export const DEFAULT_BAD_POLLS_BEFORE_RESTART = 2;
/** How many automatic leg restarts to attempt before escalating to the operator. */
export const DEFAULT_MAX_RESTARTS = 2;

export interface DecideInput {
  sample: HealthSample;
  /** Counters as of BEFORE this sample. */
  counters: HealthCounters;
  /** Age of the current leg process, used for the warm-up grace period. */
  legAgeMs: number;
  graceMs?: number;
  badPollsBeforeRestart?: number;
  maxRestarts?: number;
}

/**
 * Fold one health sample into the per-platform counters and decide what to do. A pure reducer:
 * returns the next counters alongside the decision.
 *
 * Deliberate choices:
 * - A failed probe never escalates. We must not restart a working Facebook leg because OUR network
 *   hiccuped or a token expired — that would turn a monitoring blip into a real outage.
 * - Recovery resets the restart budget, so a fresh problem an hour later gets fresh attempts.
 * - Warnings never escalate. A low bitrate is worth telling the operator about, not worth killing a
 *   working broadcast over.
 */
export function decideHealthAction(input: DecideInput): HealthDecision {
  const graceMs = input.graceMs ?? DEFAULT_GRACE_MS;
  const badPollsBeforeRestart = input.badPollsBeforeRestart ?? DEFAULT_BAD_POLLS_BEFORE_RESTART;
  const maxRestarts = input.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  const { sample, counters } = input;

  if (sample.probeFailed) {
    return {
      ...counters,
      state: 'unknown',
      action: 'none',
      reason: 'Health probe failed — treating as unknown rather than acting on it',
    };
  }

  if (sample.receiving) {
    const degraded = sample.warnings.length > 0;
    return {
      consecutiveBad: 0,
      restarts: 0,
      state: degraded ? 'degraded' : 'healthy',
      reason: degraded ? `Receiving, with warnings: ${sample.warnings.join(', ')}` : 'Receiving',
      action: 'none',
    };
  }

  // Confirmed not receiving. Ignore it while the leg is still warming up.
  if (input.legAgeMs < graceMs) {
    return {
      ...counters,
      state: 'unknown',
      action: 'none',
      reason: 'Not receiving yet, still inside the leg warm-up window',
    };
  }

  const consecutiveBad = counters.consecutiveBad + 1;
  if (consecutiveBad < badPollsBeforeRestart) {
    return {
      consecutiveBad,
      restarts: counters.restarts,
      state: 'not_receiving',
      action: 'none',
      reason: `Not receiving (${consecutiveBad}/${badPollsBeforeRestart} before restarting the leg)`,
    };
  }

  if (counters.restarts < maxRestarts) {
    return {
      consecutiveBad: 0,
      restarts: counters.restarts + 1,
      state: 'not_receiving',
      action: 'restart_leg',
      reason: `Not receiving — restarting the leg (attempt ${counters.restarts + 1}/${maxRestarts})`,
    };
  }

  return {
    consecutiveBad,
    restarts: counters.restarts,
    state: 'not_receiving',
    action: 'alarm',
    reason: `Still not receiving after ${maxRestarts} leg restarts — operator action needed`,
  };
}
