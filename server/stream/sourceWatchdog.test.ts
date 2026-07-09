import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSourcePresence } from './sourceWatchdog.js';

const GRACE = 90_000;

test('a present source refreshes lastSeen to now and never ends the stream', () => {
  const d = evaluateSourcePresence(1_000, true, 50_000, GRACE);
  assert.deepEqual(d, { shouldEnd: false, lastSeenAt: 50_000 });
});

test('an absent source within the grace period keeps the stream and preserves lastSeen', () => {
  const lastSeen = 10_000;
  const d = evaluateSourcePresence(lastSeen, false, lastSeen + GRACE - 1, GRACE);
  assert.deepEqual(d, { shouldEnd: false, lastSeenAt: lastSeen });
});

test('an absent source past the grace period ends the stream', () => {
  const lastSeen = 10_000;
  const d = evaluateSourcePresence(lastSeen, false, lastSeen + GRACE, GRACE);
  assert.equal(d.shouldEnd, true);
  assert.equal(d.lastSeenAt, lastSeen); // unchanged — absence doesn't advance the clock
});

test('recovery resets the grace: a source reappearing after a gap refreshes lastSeen', () => {
  // Gone for a while (but not yet ended), then the source returns before the grace elapsed.
  const afterGap = evaluateSourcePresence(10_000, false, 80_000, GRACE);
  assert.equal(afterGap.shouldEnd, false);
  const recovered = evaluateSourcePresence(afterGap.lastSeenAt, true, 85_000, GRACE);
  assert.deepEqual(recovered, { shouldEnd: false, lastSeenAt: 85_000 });
});
