import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideLegEncoding, buildLegArgs, PLATFORM_MAX_KBPS } from './platformEncoding.js';

describe('decideLegEncoding', () => {
  it('transcodes Facebook down at the default 6000 ingest — the 2026-08-05 regression guard', () => {
    assert.deepEqual(decideLegEncoding('facebook', 6000), { mode: 'transcode', videoKbps: 4000 });
  });

  it('copies YouTube and Twitch at the default 6000 ingest', () => {
    assert.deepEqual(decideLegEncoding('youtube', 6000), { mode: 'copy' });
    assert.deepEqual(decideLegEncoding('twitch', 6000), { mode: 'copy' });
  });

  it('copies when the ingest is exactly at the cap', () => {
    assert.deepEqual(decideLegEncoding('facebook', PLATFORM_MAX_KBPS.facebook), { mode: 'copy' });
    assert.deepEqual(decideLegEncoding('twitch', PLATFORM_MAX_KBPS.twitch), { mode: 'copy' });
  });

  it('copies every leg when the ingest is below all caps', () => {
    for (const platform of ['youtube', 'facebook', 'twitch']) {
      assert.deepEqual(decideLegEncoding(platform, 3000), { mode: 'copy' }, platform);
    }
  });

  it('transcodes Twitch too if the ingest is raised past its ceiling', () => {
    assert.deepEqual(decideLegEncoding('twitch', 8000), { mode: 'transcode', videoKbps: 6000 });
  });

  it('copies an unknown platform rather than guessing a cap', () => {
    assert.deepEqual(decideLegEncoding('kick', 50_000), { mode: 'copy' });
  });
});

describe('buildLegArgs', () => {
  const base = { input: 'rtmp://in/live', output: 'rtmps://out/key', encoder: 'h264_nvenc' as const, preset: 'p5' };

  it('builds a stream-copy leg', () => {
    const args = buildLegArgs({ ...base, encoding: { mode: 'copy' } });
    assert.deepEqual(args, [
      '-rw_timeout', '10000000',
      '-i', 'rtmp://in/live',
      '-c', 'copy',
      '-flvflags', 'no_duration_filesize',
      '-f', 'flv',
      'rtmps://out/key',
    ]);
  });

  it('re-encodes video at the cap but copies audio', () => {
    const args = buildLegArgs({ ...base, encoding: { mode: 'transcode', videoKbps: 4000 } });
    const joined = args.join(' ');
    assert.match(joined, /-c:v h264_nvenc/);
    assert.match(joined, /-b:v 4000k/);
    assert.match(joined, /-maxrate 4000k/);
    // Audio must be copied, never re-encoded.
    assert.match(joined, /-c:a copy/);
    assert.ok(!joined.includes('-c:a aac'), 'audio should not be re-encoded');
    // No blanket '-c copy' that would defeat the video transcode.
    assert.ok(!/-c copy/.test(joined), 'must not stream-copy everything');
  });

  it('keeps the 2s keyframe interval platforms require on a transcoded leg', () => {
    const args = buildLegArgs({ ...base, encoding: { mode: 'transcode', videoKbps: 4000 } });
    // -g counts frames: 2s at 30fps = 60.
    const g = args[args.indexOf('-g') + 1];
    assert.equal(g, '60');
    assert.equal(args[args.indexOf('-r') + 1], '30');
  });

  it('always ends with the flv output, whichever mode', () => {
    for (const encoding of [{ mode: 'copy' as const }, { mode: 'transcode' as const, videoKbps: 4000 }]) {
      const args = buildLegArgs({ ...base, encoding });
      assert.equal(args[args.length - 1], 'rtmps://out/key');
      assert.equal(args[args.length - 2], 'flv');
    }
  });

  it('honors libx264 when NVENC is unavailable', () => {
    const args = buildLegArgs({ ...base, encoder: 'libx264', preset: 'veryfast', encoding: { mode: 'transcode', videoKbps: 4000 } });
    assert.match(args.join(' '), /-c:v libx264 -preset veryfast/);
  });
});
