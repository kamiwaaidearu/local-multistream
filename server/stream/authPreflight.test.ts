import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decidePreflight, type PreflightHealth } from './authPreflight.js';

const good: PreflightHealth = { connected: true, ok: true, determinate: true };
const revoked: PreflightHealth = { connected: true, ok: false, determinate: true, error: 'Token has been expired or revoked.' };
const unreachable: PreflightHealth = { connected: true, ok: false, determinate: false, error: 'Could not reach Google: ETIMEDOUT' };
const notConnected: PreflightHealth = { connected: false, ok: false, determinate: true, error: 'Not connected' };

describe('decidePreflight — healthy', () => {
  it('proceeds when every connected platform is fine', () => {
    const d = decidePreflight({ youtube: good, facebook: good, twitch: good }, false);
    assert.equal(d.action, 'proceed');
  });

  it('ignores platforms that were never connected', () => {
    const d = decidePreflight({ youtube: good, facebook: notConnected, twitch: notConnected }, false);
    assert.equal(d.action, 'proceed');
  });
});

describe('decidePreflight — revoked login blocks', () => {
  it('blocks on a revoked login', () => {
    const d = decidePreflight({ youtube: revoked, facebook: good, twitch: good }, false);
    assert.equal(d.action, 'block');
    assert.deepEqual(d.platforms, ['youtube']);
    assert.match(d.detail ?? '', /expired or revoked/);
  });

  it('force does NOT bypass a revoked login — this is the 2026-08-05 regression guard', () => {
    const d = decidePreflight({ youtube: revoked, facebook: good, twitch: good }, true);
    assert.equal(d.action, 'block', 'force must never override a definitively dead grant');
  });

  it('blocks when a probe omits determinacy entirely (ambiguous rejection defaults to blocking)', () => {
    const d = decidePreflight({ youtube: { connected: true, ok: false } }, true);
    assert.equal(d.action, 'block');
  });

  it('reports every dead platform, not just the first', () => {
    const d = decidePreflight({ youtube: revoked, facebook: revoked, twitch: good }, false);
    assert.deepEqual(d.platforms.sort(), ['facebook', 'youtube']);
  });

  it('a revoked platform takes precedence over an unreachable one', () => {
    const d = decidePreflight({ youtube: revoked, facebook: unreachable }, false);
    assert.equal(d.action, 'block');
    assert.deepEqual(d.platforms, ['youtube'], 'only the definitively dead one is a hard block');
  });
});

describe('decidePreflight — unreachable platform stays overridable', () => {
  it('asks for confirmation rather than blocking', () => {
    const d = decidePreflight({ youtube: unreachable, facebook: good, twitch: good }, false);
    assert.equal(d.action, 'confirm');
    assert.deepEqual(d.platforms, ['youtube']);
  });

  it('force proceeds — a network blip must never keep the operator off air', () => {
    const d = decidePreflight({ youtube: unreachable, facebook: good, twitch: good }, true);
    assert.equal(d.action, 'proceed');
  });

  it('force proceeds even when every platform is unreachable (total network failure)', () => {
    const d = decidePreflight({ youtube: unreachable, facebook: unreachable, twitch: unreachable }, true);
    assert.equal(d.action, 'proceed');
  });
});
