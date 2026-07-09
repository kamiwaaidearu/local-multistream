// Small polling helper: wait until a predicate is true or a timeout elapses. Split out so the
// go-live "wait for the ingest to actually publish" logic is unit-testable without real timers —
// `sleep` and `now` are injectable.

export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Poll `predicate` until it returns true or `timeoutMs` elapses (measured from the first check).
 * Checks immediately, then every `intervalMs`. Resolves true as soon as the predicate passes,
 * false if the timeout is reached first.
 */
export async function waitForCondition(predicate: () => boolean, opts: WaitOptions): Promise<boolean> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;

  const start = now();
  if (predicate()) return true;
  while (now() - start < opts.timeoutMs) {
    await sleep(opts.intervalMs);
    if (predicate()) return true;
  }
  return false;
}
