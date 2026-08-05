import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideHealthAction,
  DEFAULT_GRACE_MS,
  type HealthCounters,
  type HealthSample,
} from './healthPolicy.js';

const fresh: HealthCounters = { consecutiveBad: 0, restarts: 0, consecutiveNoAudio: 0 };
const ok: HealthSample = { receiving: true, probeFailed: false, warnings: [], audioMissing: false };
const bad: HealthSample = { receiving: false, probeFailed: false, warnings: [], audioMissing: null };
const failed: HealthSample = { receiving: false, probeFailed: true, warnings: [], audioMissing: null };

// Well past the warm-up window, so grace never interferes.
const OLD = DEFAULT_GRACE_MS * 10;

describe('decideHealthAction — receiving', () => {
  it('reports healthy and takes no action', () => {
    const d = decideHealthAction({ sample: ok, counters: fresh, legAgeMs: OLD });
    assert.equal(d.state, 'healthy');
    assert.equal(d.action, 'none');
  });

  it('reports degraded (not an action) when the platform warns', () => {
    const sample: HealthSample = { receiving: true, probeFailed: false, warnings: ['videoBitrateLow'], audioMissing: false };
    const d = decideHealthAction({ sample, counters: fresh, legAgeMs: OLD });
    assert.equal(d.state, 'degraded');
    assert.equal(d.action, 'none');
    assert.match(d.reason, /videoBitrateLow/);
  });

  it('recovery clears the bad streak AND refunds the restart budget', () => {
    const d = decideHealthAction({
      sample: ok,
      counters: { consecutiveBad: 5, restarts: 2, consecutiveNoAudio: 0 },
      legAgeMs: OLD,
    });
    assert.deepEqual({ consecutiveBad: d.consecutiveBad, restarts: d.restarts }, { consecutiveBad: 0, restarts: 0 });
  });
});

describe('decideHealthAction — probe failure', () => {
  it('never escalates on a failed probe, even with a long bad streak', () => {
    const d = decideHealthAction({
      sample: failed,
      counters: { consecutiveBad: 9, restarts: 0, consecutiveNoAudio: 0 },
      legAgeMs: OLD,
    });
    assert.equal(d.state, 'unknown');
    assert.equal(d.action, 'none');
  });

  it('leaves counters untouched so a blip neither punishes nor forgives', () => {
    const counters: HealthCounters = { consecutiveBad: 1, restarts: 1, consecutiveNoAudio: 0 };
    const d = decideHealthAction({ sample: failed, counters, legAgeMs: OLD });
    assert.deepEqual(
      { consecutiveBad: d.consecutiveBad, restarts: d.restarts, consecutiveNoAudio: d.consecutiveNoAudio },
      counters,
    );
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

describe('decideHealthAction — missing audio', () => {
  const noAudio: HealthSample = { receiving: true, probeFailed: false, warnings: [], audioMissing: true };

  it('does not alarm on the first silent poll (audio readings can lag)', () => {
    const d = decideHealthAction({ sample: noAudio, counters: fresh, legAgeMs: OLD });
    assert.equal(d.audioAlarm, false);
    assert.equal(d.consecutiveNoAudio, 1);
  });

  it('alarms once audio has been absent for two consecutive polls', () => {
    const first = decideHealthAction({ sample: noAudio, counters: fresh, legAgeMs: OLD });
    const second = decideHealthAction({ sample: noAudio, counters: first, legAgeMs: OLD });
    assert.equal(second.audioAlarm, true);
    assert.equal(second.state, 'degraded', 'a silent stream is still receiving video');
    assert.match(second.reason, /no audio/);
  });

  it('never restarts the leg for missing audio — that cannot fix a muted mic', () => {
    let counters: HealthCounters = fresh;
    for (let i = 0; i < 6; i++) {
      const d = decideHealthAction({ sample: noAudio, counters, legAgeMs: OLD });
      assert.equal(d.action, 'none', 'audio loss must never consume the restart budget');
      assert.equal(d.restarts, 0);
      counters = { consecutiveBad: d.consecutiveBad, restarts: d.restarts, consecutiveNoAudio: d.consecutiveNoAudio };
    }
  });

  it('clears the alarm as soon as audio returns', () => {
    const alarmed = decideHealthAction({
      sample: noAudio,
      counters: { consecutiveBad: 0, restarts: 0, consecutiveNoAudio: 5 },
      legAgeMs: OLD,
    });
    assert.equal(alarmed.audioAlarm, true);

    const recovered = decideHealthAction({ sample: ok, counters: alarmed, legAgeMs: OLD });
    assert.equal(recovered.audioAlarm, false);
    assert.equal(recovered.consecutiveNoAudio, 0);
    assert.equal(recovered.state, 'healthy');
  });

  it('ignores missing audio when the platform is not receiving video at all', () => {
    // "No audio" on a stream that isn't arriving is not independent news, and counting it would fire a
    // second alarm about the same underlying outage.
    const sample: HealthSample = { receiving: false, probeFailed: false, warnings: [], audioMissing: true };
    const d = decideHealthAction({ sample, counters: fresh, legAgeMs: OLD });
    assert.equal(d.consecutiveNoAudio, 0);
    assert.equal(d.audioAlarm, false);
  });

  it('treats an unreported audio state as not-missing, never as silence', () => {
    const sample: HealthSample = { receiving: true, probeFailed: false, warnings: [], audioMissing: null };
    const d = decideHealthAction({ sample, counters: { consecutiveBad: 0, restarts: 0, consecutiveNoAudio: 9 }, legAgeMs: OLD });
    assert.equal(d.audioAlarm, false, 'a platform that does not report audio must not trigger an alarm');
    assert.equal(d.consecutiveNoAudio, 0);
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
      counters = { consecutiveBad: d.consecutiveBad, restarts: d.restarts, consecutiveNoAudio: d.consecutiveNoAudio };
      actions.push(d.action);
    }
    assert.deepEqual(actions, ['none', 'restart_leg', 'none', 'restart_leg', 'none', 'alarm']);
  });

  it('keeps alarming rather than restarting once exhausted', () => {
    const d = decideHealthAction({
      sample: bad,
      counters: { consecutiveBad: 2, restarts: 2, consecutiveNoAudio: 0 },
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
