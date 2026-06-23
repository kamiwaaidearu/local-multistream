// In-memory, per-key (client IP) login throttle. Kept free of Express/DB so it's unit-testable,
// and the clock is a parameter for the same reason. After `maxFailures` failures within a rolling
// window the key is locked for `windowMs` (each failure refreshes the window). Entries are pruned
// lazily so the Map can't grow without bound. State is per-process and resets on restart.

export const RL_MAX_FAILURES = 5;
export const RL_WINDOW_MS = 5 * 60_000; // rolling window and lockout duration: 5 minutes

interface Attempts {
  failures: number;
  resetAt: number; // epoch ms when this entry expires / unblocks
}

export class LoginRateLimiter {
  private readonly attempts = new Map<string, Attempts>();
  private lastSweep = 0;

  constructor(
    private readonly maxFailures: number = RL_MAX_FAILURES,
    private readonly windowMs: number = RL_WINDOW_MS,
  ) {}

  // Drop expired entries at most once per window so abandoned keys don't accumulate.
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, a] of this.attempts) {
      if (a.resetAt <= now) this.attempts.delete(key);
    }
  }

  /** ms until this key may attempt login again, or 0 if it's currently allowed. */
  retryAfterMs(key: string, now: number = Date.now()): number {
    this.sweep(now);
    const a = this.attempts.get(key);
    if (!a || a.resetAt <= now) return 0;
    return a.failures >= this.maxFailures ? a.resetAt - now : 0;
  }

  recordFailure(key: string, now: number = Date.now()): void {
    const a = this.attempts.get(key);
    if (!a || a.resetAt <= now) {
      this.attempts.set(key, { failures: 1, resetAt: now + this.windowMs });
    } else {
      a.failures += 1;
      a.resetAt = now + this.windowMs; // each failure refreshes the rolling window
    }
  }

  /** Clear a key's failure record (e.g. on a successful login). */
  clear(key: string): void {
    this.attempts.delete(key);
  }
}
