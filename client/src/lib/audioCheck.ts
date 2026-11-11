// Pure logic behind the studio's "Test audio" check and its live silence watch.
//
// Why this exists: on 2026-10-14 a remote presenter went live from the Web Studio and YouTube carried
// no audio. The studio only captures a microphone when the presenter clicks "Add mic", and nothing
// stopped go-live without one. With no sources the mix bus still emits a (silent) track — the keepalive
// that keeps MediaRecorder producing chunks — so every platform received a valid AAC stream of silence.
// That passes the server's platform-side audio_missing alarm too: Facebook reports a nonzero
// audio bitrate and YouTube raises no noAudioStream issue for a track that exists but is silent.
// The only place silence is observable is the browser, before encoding, so that is where we check.
//
// Levels here are RMS of float samples in [-1, 1], read from an AnalyserNode on the mix bus.

/** RMS above this counts as "sound" for the test (~ -36 dBFS: quiet speech on a laptop mic clears it). */
export const SPEECH_RMS = 0.016;

/** How much sound the test must hear, in total, to count as a pass. Speech is bursty; this is cumulative. */
export const MIN_SOUND_MS = 600;

/** Length of the test recording. */
export const TEST_DURATION_MS = 5000;

/**
 * Below this the mix is effectively digital silence (~ -60 dBFS). A real microphone's room noise sits
 * above it even with the browser's noise suppression on; the silent keepalive sits at exactly zero.
 */
export const SILENCE_RMS = 0.001;

/** Continuous silence while live before we warn. A spoken rosary has no minute-long gaps. */
export const LIVE_SILENCE_ALERT_MS = 60_000;

export interface AudioCheckResult {
  /** True when enough sound was heard to be confident a live microphone is in the mix. */
  heard: boolean;
  /** Total time the level was at or above SPEECH_RMS. */
  soundMs: number;
  /** Loudest RMS reading seen. */
  peak: number;
}

/** Judge a test recording from level readings taken every `intervalMs`. */
export function evaluateAudioCheck(levels: readonly number[], intervalMs: number): AudioCheckResult {
  let soundMs = 0;
  let peak = 0;
  for (const level of levels) {
    if (level > peak) peak = level;
    if (level >= SPEECH_RMS) soundMs += intervalMs;
  }
  return { heard: soundMs >= MIN_SOUND_MS, soundMs, peak };
}

/**
 * Which sources a test actually heard, from per-source level readings.
 *
 * Confirmation must attach to the sources that produced sound, not to everything that happened to be in
 * the mix: otherwise a dead mic sitting next to a working one inherits the pass, and muting the working
 * one would leave go-live open on silence. When no single source cleared the bar (the presenter
 * overrode a failed meter, or sound was split thinly across sources), fall back to every source that
 * was audible during the test — the human listened and vouched for that mix.
 */
export function sourcesHeard(
  perSource: ReadonlyMap<string, readonly number[]>,
  intervalMs: number,
): Set<string> {
  const heard = new Set<string>();
  for (const [id, levels] of perSource) {
    if (evaluateAudioCheck(levels, intervalMs).heard) heard.add(id);
  }
  return heard.size > 0 ? heard : new Set(perSource.keys());
}

export interface MixSourceState {
  id: string;
  muted: boolean;
  gain: number;
}

/**
 * Whether a passed audio test still describes what will go to air.
 *
 * The test confirms specific sources. It stays valid while at least one of them is still in the mix and
 * audible; removing, muting or zeroing every tested source puts the presenter back to "untested".
 * Adding a new source does not invalidate it — the tested mic is still there.
 */
export function isAudioStillConfirmed(confirmedIds: ReadonlySet<string>, sources: readonly MixSourceState[]): boolean {
  return sources.some((s) => confirmedIds.has(s.id) && !s.muted && s.gain > 0);
}

/**
 * Tracks how long the live mix has been silent. Feed it one level per reading; it returns the current
 * silent duration, so the caller can compare against LIVE_SILENCE_ALERT_MS.
 */
export function createSilenceTracker() {
  let silentSince: number | null = null;
  return {
    update(level: number, now: number): number {
      if (level >= SILENCE_RMS) {
        silentSince = null;
        return 0;
      }
      if (silentSince === null) silentSince = now;
      return now - silentSince;
    },
    reset() {
      silentSince = null;
    },
  };
}
