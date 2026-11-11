import { describe, it, expect } from 'vitest';
import {
  evaluateAudioCheck,
  isAudioStillConfirmed,
  sourcesHeard,
  createSilenceTracker,
  SPEECH_RMS,
  MIN_SOUND_MS,
  LIVE_SILENCE_ALERT_MS,
} from './audioCheck';

describe('evaluateAudioCheck', () => {
  it('fails on the silent keepalive (all zeros) — the 2026-10-14 case', () => {
    const r = evaluateAudioCheck(new Array(50).fill(0), 100);
    expect(r.heard).toBe(false);
    expect(r.soundMs).toBe(0);
    expect(r.peak).toBe(0);
  });

  it('fails on room noise alone', () => {
    const r = evaluateAudioCheck(new Array(50).fill(0.004), 100);
    expect(r.heard).toBe(false);
  });

  it('passes on bursty speech whose total clears the minimum', () => {
    // Speech with pauses: 2 readings on, 3 off, repeated — 400 ms of sound per second, 2 s total.
    const levels = Array.from({ length: 50 }, (_, i) => (i % 5 < 2 ? 0.05 : 0.002));
    const r = evaluateAudioCheck(levels, 100);
    expect(r.heard).toBe(true);
    expect(r.soundMs).toBe(2000);
    expect(r.peak).toBe(0.05);
  });

  it('fails on a single short click', () => {
    const levels = new Array(50).fill(0);
    levels[10] = 0.5;
    levels[11] = 0.5;
    const r = evaluateAudioCheck(levels, 100);
    expect(r.soundMs).toBeLessThan(MIN_SOUND_MS);
    expect(r.heard).toBe(false);
  });

  it('counts a reading exactly at the threshold as sound', () => {
    const r = evaluateAudioCheck(new Array(6).fill(SPEECH_RMS), 100);
    expect(r.soundMs).toBe(600);
    expect(r.heard).toBe(true);
  });
});

describe('sourcesHeard', () => {
  const speech = new Array(20).fill(0.05);
  const silence = new Array(20).fill(0);

  it('confirms only the source that made sound, not a dead mic beside it', () => {
    const heard = sourcesHeard(new Map([['live', speech], ['dead', silence]]), 100);
    expect([...heard]).toEqual(['live']);
  });

  it('falls back to every tested source when none cleared the bar on its own', () => {
    const heard = sourcesHeard(new Map([['a', silence], ['b', silence]]), 100);
    expect([...heard].sort()).toEqual(['a', 'b']);
  });
});

describe('isAudioStillConfirmed', () => {
  const tested = new Set(['mic-1']);

  it('holds while a tested source is present and audible', () => {
    expect(isAudioStillConfirmed(tested, [{ id: 'mic-1', muted: false, gain: 1 }])).toBe(true);
  });

  it('survives adding another source', () => {
    expect(isAudioStillConfirmed(tested, [
      { id: 'mic-1', muted: false, gain: 1 },
      { id: 'desk-1', muted: false, gain: 1 },
    ])).toBe(true);
  });

  it('is lost when the tested source is removed, even if another source remains', () => {
    expect(isAudioStillConfirmed(tested, [{ id: 'desk-1', muted: false, gain: 1 }])).toBe(false);
  });

  it('is lost when the tested source is muted or turned to zero', () => {
    expect(isAudioStillConfirmed(tested, [{ id: 'mic-1', muted: true, gain: 1 }])).toBe(false);
    expect(isAudioStillConfirmed(tested, [{ id: 'mic-1', muted: false, gain: 0 }])).toBe(false);
  });

  it('is false with nothing tested', () => {
    expect(isAudioStillConfirmed(new Set(), [{ id: 'mic-1', muted: false, gain: 1 }])).toBe(false);
  });
});

describe('createSilenceTracker', () => {
  it('measures continuous silence and resets on sound', () => {
    const t = createSilenceTracker();
    expect(t.update(0, 1000)).toBe(0);
    expect(t.update(0, 31_000)).toBe(30_000);
    expect(t.update(0.02, 32_000)).toBe(0);
    expect(t.update(0, 33_000)).toBe(0);
    expect(t.update(0, 33_000 + LIVE_SILENCE_ALERT_MS)).toBe(LIVE_SILENCE_ALERT_MS);
  });

  it('treats quiet room noise as not-silent', () => {
    const t = createSilenceTracker();
    t.update(0.003, 0);
    expect(t.update(0.003, 120_000)).toBe(0);
  });
});
