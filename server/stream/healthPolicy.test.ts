import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideHealthAction,
  DEFAULT_GRACE_MS,
  type HealthCounters,
  type HealthSample,
} from './healthPolicy.js';

const fresh: HealthCounters = { consecutiveBad: 0, restarts: 0 };
const ok: HealthSample = { receiving: true, probeFailed: false, warnings: [] };
const bad: HealthSample = { receiving: false, probeFailed: false, warnings: [] };
const failed: HealthSample = { receiving: false, probeFailed: true, warnings: [] };

// Well past the warm-up window, so grace never interferes.
const OLD = DEFAULT_GRACE_MS * 10;

describe('decideHealthAction — receiving', () => {
  it('reports healthy and takes no action', () => {
    const d = decideHealthAction({ sample: ok, counters: fresh, legAgeMs: OLD });
    assert.equal(d.state, 'healthy');
    assert.equal(d.action, 'none');
  });

  it('reports degraded (not an action) when the platform warns', () => {
    const sample: HealthSample = { receiving: true, probeFailed: false, warnings: ['videoBitrateLow'] };
    const d = decideHealthAction({ sample, counters: fresh, legAgeMs: OLD });
    assert.equal(d.state, 'degraded');
    assert.equal(d.action, 'none');
    assert.match(d.reason, /videoBitrateLow/);
  });

  it('recovery clears the bad streak AND refunds the restart budget', () => {
    const d = decideHealthAction({
      sample: ok,
      counters: { consecutiveBad: 5, restarts: 2 },
      legAgeMs: OLD,
    });
    assert.deepEqual({ consecutiveBad: d.consecutiveBad, restarts: d.restarts }, { consecutiveBad: 0, restarts: 0 });
  });
});

describe('decideHealthAction — probe failure', () => {
  it('never escalates on a failed probe, even with a long bad streak', () => {
    const d = decideHealthAction({
      sample: failed,
      counters: { consecutiveBad: 9, restarts: 0 },
      legAgeMs: OLD,
    });
    assert.equal(d.state, 'unknown');
    assert.equal(d.action, 'none');
  });

  it('leaves counters untouched so a blip neither punishes nor forgives', () => {
    const counters = { consecutiveBad: 1, restarts: 1 };
    const d = decideHealthAction({ sample: failed, counters, legAgeMs: OLD });
    assert.deepEqual({ consecutiveBad: d.consecutiveBad, restarts: d.restarts }, counters);
  });
});

describe('decideHealthAction — warm-up grace', () => {
  it('ignores "not receiving" while the leg is still starting up', () => {
    const d = decideHealthAction({ sample: bad, counters: fresh, legAgeMs: DEFAULT_GRACE_MS - 1 });
    assert.equal(d.state, 'unknown');
    assert.equal(d.action, 'none');
    assert.equal(d.consecutiveBad, 0);
  });

  it('starts counting once the grace window has passed', () => {
    const d = decideHealthAction({ sample: bad, counters: fresh, legAgeMs: DEFAULT_GRACE_MS });
    assert.equal(d.state, 'not_receiving');
    assert.equal(d.consecutiveBad, 1);
  });
});

describe('decideHealthAction — escalation', () => {
  it('waits for the configured number of bad polls before restarting', () => {
    const first = decideHealthAction({ sample: bad, counters: fresh, legAgeMs: OLD });
    assert.equal(first.action, 'none');
    assert.equal(first.consecutiveBad, 1);

    const second = decideHealthAction({ sample: bad, counters: first, legAgeMs: OLD });
    assert.equal(second.action, 'restart_leg');
    assert.equal(second.restarts, 1);
    // Streak resets so the restarted leg gets a clean slate.
    assert.equal(second.consecutiveBad, 0);
  });

  it('escalates to alarm only after the restart budget is spent', () => {
    let counters: HealthCounters = fresh;
    const actions: string[] = [];
    // Two bad polls per restart, 2 restarts allowed, then alarm.
    for (let i = 0; i < 6; i++) {
      const d = decideHealthAction({ sample: bad, counters, legAgeMs: OLD });
      counters = { consecutiveBad: d.consecutiveBad, restarts: d.restarts };
      actions.push(d.action);
    }
    assert.deepEqual(actions, ['none', 'restart_leg', 'none', 'restart_leg', 'none', 'alarm']);
  });

  it('keeps alarming rather than restarting once exhausted', () => {
    const d = decideHealthAction({
      sample: bad,
      counters: { consecutiveBad: 2, restarts: 2 },
      legAgeMs: OLD,
    });
    assert.equal(d.action, 'alarm');
    assert.equal(d.restarts, 2);
  });

  it('honors custom thresholds', () => {
    const d = decideHealthAction({
      sample: bad,
      counters: fresh,
      legAgeMs: OLD,
      badPollsBeforeRestart: 1,
      maxRestarts: 0,
    });
    // No restarts permitted, so the first confirmed-bad poll goes straight to alarm.
    assert.equal(d.action, 'alarm');
  });
});
