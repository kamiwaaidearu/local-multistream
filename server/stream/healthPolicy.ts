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
  /**
   * The platform reports video arriving but NO audio. null when it doesn't tell us either way.
   *
   * Tracked separately from `receiving` because for a prayer broadcast this is the worst failure there
   * is — a perfect-looking picture with no prayer on it — and because it is invisible to every other
   * signal we have: a muted microphone still produces a full-bitrate, full-framerate video stream.
   */
  audioMissing: boolean | null;
}

/** Per-platform counters the monitor carries between polls. */
export interface HealthCounters {
  consecutiveBad: number;
  restarts: number;
  consecutiveNoAudio: number;
}

export interface HealthDecision extends HealthCounters {
  state: HealthState;
  action: HealthAction;
  /** Operator-facing explanation, for the event log and the UI. */
  reason: string;
  /**
   * Audio has been absent long enough to be real rather than a slow first reading.
   *
   * Deliberately independent of `action`: restarting the fan-out leg cannot fix a muted mic or a dead
   * audio device, so this must alarm WITHOUT consuming the restart budget or interfering with the
   * video escalation ladder.
   */
  audioAlarm: boolean;
}

/** A freshly (re)started leg needs time to connect AND for the platform to measure it. Facebook's
 *  stream_health in particular reports nothing for the first several seconds. */
export const DEFAULT_GRACE_MS = 25_000;
/** Consecutive confirmed-bad polls before we touch anything. At a 20s interval that's ~40s of
 *  genuine silence — long enough not to react to a single stale reading. */
export const DEFAULT_BAD_POLLS_BEFORE_RESTART = 2;
/** How many automatic leg restarts to attempt before escalating to the operator. */
export const DEFAULT_MAX_RESTARTS = 2;
/** Consecutive polls with video-but-no-audio before alarming. Two (~40s) rules out a slow first
 *  audio reading without letting a genuinely silent broadcast run on. */
export const DEFAULT_NO_AUDIO_POLLS_BEFORE_ALARM = 2;

export interface DecideInput {
  sample: HealthSample;
  /** Counters as of BEFORE this sample. */
  counters: HealthCounters;
  /** Age of the current leg process, used for the warm-up grace period. */
  legAgeMs: number;
  graceMs?: number;
  badPollsBeforeRestart?: number;
  maxRestarts?: number;
  noAudioPollsBeforeAlarm?: number;
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
  const noAudioPolls = input.noAudioPollsBeforeAlarm ?? DEFAULT_NO_AUDIO_POLLS_BEFORE_ALARM;
  const { sample, counters } = input;

  // Audio is folded in first and kept orthogonal to everything below: it only counts while video is
  // actually arriving (no audio on a stream that isn't being received at all is not news), it never
  // touches the restart counters, and it never suppresses a video decision.
  const audioMissing = sample.receiving && !sample.probeFailed && sample.audioMissing === true;
  const consecutiveNoAudio = audioMissing ? counters.consecutiveNoAudio + 1 : 0;
  const audioAlarm = consecutiveNoAudio >= noAudioPolls;
  const audioNote = audioAlarm ? ' — NO AUDIO' : '';

  if (sample.probeFailed) {
    return {
      ...counters,
      consecutiveNoAudio,
      audioAlarm,
      state: 'unknown',
      action: 'none',
      reason: 'Health probe failed — treating as unknown rather than acting on it',
    };
  }

  if (sample.receiving) {
    const degraded = sample.warnings.length > 0 || audioAlarm;
    const notes = [...sample.warnings];
    if (audioAlarm) notes.unshift('no audio');
    return {
      consecutiveBad: 0,
      restarts: 0,
      consecutiveNoAudio,
      audioAlarm,
      state: degraded ? 'degraded' : 'healthy',
      reason: degraded ? `Receiving, with warnings: ${notes.join(', ')}` : 'Receiving',
      action: 'none',
    };
  }

  // Confirmed not receiving. Ignore it while the leg is still warming up.
  if (input.legAgeMs < graceMs) {
    return {
      ...counters,
      consecutiveNoAudio,
      audioAlarm,
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
      consecutiveNoAudio,
      audioAlarm,
      state: 'not_receiving',
      action: 'none',
      reason: `Not receiving (${consecutiveBad}/${badPollsBeforeRestart} before restarting the leg)${audioNote}`,
    };
  }

  if (counters.restarts < maxRestarts) {
    return {
      consecutiveBad: 0,
      restarts: counters.restarts + 1,
      consecutiveNoAudio,
      audioAlarm,
      state: 'not_receiving',
      action: 'restart_leg',
      reason: `Not receiving — restarting the leg (attempt ${counters.restarts + 1}/${maxRestarts})${audioNote}`,
    };
  }

  return {
    consecutiveBad,
    restarts: counters.restarts,
    consecutiveNoAudio,
    audioAlarm,
    state: 'not_receiving',
    action: 'alarm',
    reason: `Still not receiving after ${maxRestarts} leg restarts — operator action needed${audioNote}`,
  };
}
