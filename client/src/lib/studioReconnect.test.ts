import { describe, it, expect } from 'vitest';
import { nextReconnectStep, MAX_RECONNECT_ATTEMPTS, RECONNECT_BACKOFF_MS } from './studioReconnect';

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
