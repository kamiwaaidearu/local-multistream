import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForCondition } from './waitForCondition.js';

// A controllable fake clock: sleep() advances virtual time (and counts calls) so we can test the
// polling loop deterministically, without real timers.
function fakeClock(startMs = 0) {
  let t = startMs;
  let sleeps = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; sleeps += 1; },
    get sleeps() { return sleeps; },
  };
}

test('returns true immediately when the predicate is already satisfied (no sleeps)', async () => {
  const clock = fakeClock();
  const ok = await waitForCondition(() => true, { timeoutMs: 1000, intervalMs: 100, sleep: clock.sleep, now: clock.now });
  assert.equal(ok, true);
  assert.equal(clock.sleeps, 0);
});

test('resolves true once the predicate flips partway through', async () => {
  const clock = fakeClock();
  let flips = 3; // false for the first 3 checks, then true
  const ok = await waitForCondition(
    () => (flips-- <= 0),
    { timeoutMs: 10000, intervalMs: 500, sleep: clock.sleep, now: clock.now },
  );
  assert.equal(ok, true);
  // Checked at t=0 (false), then slept/checked until it flipped — 3 sleeps to get past the counter.
  assert.equal(clock.sleeps, 3);
});

test('resolves false when the predicate never passes before the timeout', async () => {
  const clock = fakeClock();
  const ok = await waitForCondition(
    () => false,
    { timeoutMs: 2000, intervalMs: 500, sleep: clock.sleep, now: clock.now },
  );
  assert.equal(ok, false);
  // t advances 0→500→1000→1500→2000; the loop stops once now()-start >= timeoutMs.
  assert.equal(clock.sleeps, 4);
});
