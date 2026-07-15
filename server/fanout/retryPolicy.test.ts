import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideFanoutRetry,
  FANOUT_BACKOFF_MS,
  FANOUT_SOURCE_ABSENT_RETRY_MS,
  MAX_PLATFORM_RETRIES,
} from './retryPolicy.js';

test('source gone: retries steadily forever and never charges the per-platform budget', () => {
  // Even after many prior failures, a missing source is not this leg's fault — keep retrying.
  for (const retryCount of [0, 3, 10]) {
    const d = decideFanoutRetry({ sourcePresent: false, retryCount, ranMs: 500 });
    assert.equal(d.giveUp, false);
    assert.equal(d.delayMs, FANOUT_SOURCE_ABSENT_RETRY_MS);
    assert.equal(d.nextRetryCount, 0); // budget reset, so recovery can't be misread as a fault
  }
});

test('source present, early failures: escalating backoff, counting toward give-up', () => {
  const first = decideFanoutRetry({ sourcePresent: true, retryCount: 0, ranMs: 500 });
  assert.deepEqual(first, { giveUp: false, delayMs: FANOUT_BACKOFF_MS[0], nextRetryCount: 1 });

  const second = decideFanoutRetry({ sourcePresent: true, retryCount: 1, ranMs: 500 });
  assert.deepEqual(second, { giveUp: false, delayMs: FANOUT_BACKOFF_MS[1], nextRetryCount: 2 });
});

test('source present, repeated fast failures: gives up at the cap (per-platform fault)', () => {
  const d = decideFanoutRetry({ sourcePresent: true, retryCount: MAX_PLATFORM_RETRIES, ranMs: 500 });
  assert.equal(d.giveUp, true);
});

test('source present, a leg that ran a long time is transient: budget resets, no give-up', () => {
  // retryCount is high, but it ran well past the reset window → treat the death as a fresh blip.
  const d = decideFanoutRetry({ sourcePresent: true, retryCount: 9, ranMs: 120_000 });
  assert.equal(d.giveUp, false);
  assert.equal(d.delayMs, FANOUT_BACKOFF_MS[0]);
  assert.equal(d.nextRetryCount, 1);
});
