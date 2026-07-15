import { describe, it, expect } from 'vitest';
import { nextReconnectStep, isFatalCloseCode, MAX_RECONNECT_ATTEMPTS, RECONNECT_BACKOFF_MS } from './studioReconnect';

describe('nextReconnectStep', () => {
  it('follows the backoff schedule for the early attempts', () => {
    expect(nextReconnectStep(0, false)).toEqual({ giveUp: false, delayMs: RECONNECT_BACKOFF_MS[0] });
    expect(nextReconnectStep(2, false)).toEqual({ giveUp: false, delayMs: RECONNECT_BACKOFF_MS[2] });
  });

  it('gives up once past the cap when not live', () => {
    expect(nextReconnectStep(MAX_RECONNECT_ATTEMPTS, false).giveUp).toBe(true);
    expect(nextReconnectStep(MAX_RECONNECT_ATTEMPTS + 5, false).giveUp).toBe(true);
  });

  it('never gives up while the broadcast is live, holding the capped backoff', () => {
    const capped = RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1];
    for (const attempt of [MAX_RECONNECT_ATTEMPTS, MAX_RECONNECT_ATTEMPTS + 1, 100]) {
      const step = nextReconnectStep(attempt, true);
      expect(step.giveUp).toBe(false);
      expect(step.delayMs).toBe(capped); // clamps to the last backoff entry, doesn't grow unbounded
    }
  });

  it('clamps the delay to the last backoff entry for out-of-range attempts', () => {
    const capped = RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1];
    expect(nextReconnectStep(RECONNECT_BACKOFF_MS.length + 3, true).delayMs).toBe(capped);
  });
});

describe('isFatalCloseCode', () => {
  it('always treats OBS-conflict (4001) and takeover (4004) as fatal', () => {
    for (const live of [true, false]) {
      expect(isFatalCloseCode(4001, live)).toBe(true);
      expect(isFatalCloseCode(4004, live)).toBe(true);
    }
  });

  it('treats 4000 as fatal pre-live but retryable while live (may be our own stale socket)', () => {
    expect(isFatalCloseCode(4000, false)).toBe(true);  // pre-live: a real conflict, give up
    expect(isFatalCloseCode(4000, true)).toBe(false);  // live: retry so the takeover can succeed
  });

  it('never treats an ordinary drop or the ingest-restart bounce (4003) as fatal', () => {
    for (const code of [1000, 1006, 4003]) {
      expect(isFatalCloseCode(code, true)).toBe(false);
      expect(isFatalCloseCode(code, false)).toBe(false);
    }
  });
});
