import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseProgress, ProgressTracker, describeProgress } from './ffmpegProgress.js';

const REAL_LINE =
  'frame= 1234 fps= 30 q=28.0 size=   12345kB time=00:00:41.00 bitrate=2464.9kbits/s speed=1.01x';

describe('parseProgress', () => {
  it('parses a real progress line', () => {
    assert.deepEqual(parseProgress(REAL_LINE), { fps: 30, bitrateKbps: 2465, speed: 1.01 });
  });

  it('handles the padded spacing ffmpeg actually emits', () => {
    const p = parseProgress('frame=  102 fps=9.8 q=31.0 size=     256kB time=00:00:03.4 bitrate= 616.1kbits/s speed=0.33x');
    assert.equal(p?.bitrateKbps, 616);
    assert.equal(p?.fps, 9.8);
    assert.equal(p?.speed, 0.33);
  });

  it('normalizes mbits/s to kbps', () => {
    assert.equal(parseProgress('frame=1 fps=30 bitrate=6.0mbits/s speed=1x')?.bitrateKbps, 6000);
  });

  it('reports an unavailable bitrate as null, not zero', () => {
    const p = parseProgress('frame=    1 fps=0.0 q=0.0 size=       0kB time=00:00:00.00 bitrate=N/A speed=   0x');
    assert.equal(p?.bitrateKbps, null);
    // Zero would read as "we are sending nothing", which is a different and misleading claim.
    assert.notEqual(p?.bitrateKbps, 0);
  });

  it('returns null for non-progress output', () => {
    assert.equal(parseProgress('[flv @ 0x55] Failed to update header with correct duration'), null);
    assert.equal(parseProgress(''), null);
    assert.equal(parseProgress('Press [q] to stop, [?] for help'), null);
  });

  it('returns null for a line that looks like progress but has no usable numbers', () => {
    assert.equal(parseProgress('frame= bitrate='), null);
  });
});

describe('ProgressTracker', () => {
  it('logs the first reading immediately, then throttles', () => {
    const t = new ProgressTracker(30_000);
    assert.ok(t.update(REAL_LINE, 1_000), 'first reading should log');
    assert.equal(t.update(REAL_LINE, 5_000), null, 'within the window it should stay quiet');
    assert.ok(t.update(REAL_LINE, 31_000), 'past the window it should log again');
  });

  it('keeps tracking the latest reading even while throttled', () => {
    const t = new ProgressTracker(30_000);
    t.update(REAL_LINE, 1_000);
    t.update('frame=2000 fps=30 bitrate=999.0kbits/s speed=1x', 2_000);
    assert.equal(t.latest?.bitrateKbps, 999, 'latest must reflect the newest line, not the logged one');
  });

  it('ignores non-progress lines entirely', () => {
    const t = new ProgressTracker(0);
    assert.equal(t.update('some random ffmpeg warning', 1_000), null);
    assert.equal(t.latest, null);
  });
});

describe('describeProgress', () => {
  it('summarizes a full reading', () => {
    assert.equal(
      describeProgress({ bitrateKbps: 5900, fps: 30, speed: 1.0 }),
      '5900 kbps · 30 fps · 1x realtime',
    );
  });

  it('says so when the bitrate is unavailable', () => {
    assert.match(describeProgress({ bitrateKbps: null, fps: 0, speed: null }), /bitrate n\/a/);
  });
});
