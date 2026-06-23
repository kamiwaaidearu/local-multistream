import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoginRateLimiter } from './loginRateLimiter.js';

test('allows attempts below the failure cap', () => {
  const rl = new LoginRateLimiter(3, 1000);
  assert.equal(rl.retryAfterMs('ip', 0), 0);
  rl.recordFailure('ip', 0);
  rl.recordFailure('ip', 0);
  assert.equal(rl.retryAfterMs('ip', 0), 0); // 2 < 3 → still allowed
});

test('locks out once the cap is hit and reports remaining time', () => {
  const rl = new LoginRateLimiter(3, 1000);
  rl.recordFailure('ip', 0);
  rl.recordFailure('ip', 0);
  rl.recordFailure('ip', 0); // 3rd failure → locked, resetAt = 1000
  assert.equal(rl.retryAfterMs('ip', 0), 1000);
  assert.equal(rl.retryAfterMs('ip', 400), 600);
});

test('unlocks once the window elapses', () => {
  const rl = new LoginRateLimiter(2, 1000);
  rl.recordFailure('ip', 0);
  rl.recordFailure('ip', 0); // locked, resetAt = 1000
  assert.equal(rl.retryAfterMs('ip', 1000), 0); // resetAt <= now → expired
  assert.equal(rl.retryAfterMs('ip', 1001), 0);
});

test('each failure refreshes the rolling window', () => {
  const rl = new LoginRateLimiter(2, 1000);
  rl.recordFailure('ip', 0);   // resetAt = 1000
  rl.recordFailure('ip', 900); // 2nd → locked, resetAt = 1900
  assert.equal(rl.retryAfterMs('ip', 1500), 400); // still locked (1900 - 1500)
});

test('a fresh failure after expiry starts a new window', () => {
  const rl = new LoginRateLimiter(1, 1000);
  rl.recordFailure('ip', 0);   // locked, resetAt = 1000
  rl.recordFailure('ip', 2000); // window had expired → count resets to 1, resetAt = 3000
  assert.equal(rl.retryAfterMs('ip', 2500), 500);
});

test('clear() resets a key (successful login)', () => {
  const rl = new LoginRateLimiter(1, 1000);
  rl.recordFailure('ip', 0); // locked
  assert.ok(rl.retryAfterMs('ip', 0) > 0);
  rl.clear('ip');
  assert.equal(rl.retryAfterMs('ip', 0), 0);
});

test('keys are tracked independently', () => {
  const rl = new LoginRateLimiter(1, 1000);
  rl.recordFailure('a', 0); // a locked
  assert.ok(rl.retryAfterMs('a', 0) > 0);
  assert.equal(rl.retryAfterMs('b', 0), 0); // b unaffected
});
