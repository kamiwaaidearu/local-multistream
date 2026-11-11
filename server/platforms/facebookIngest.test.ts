import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { interpretFacebookIngest, unknownFacebookIngest, describeDashManifest } from './facebookIngest.js';

describe('interpretFacebookIngest', () => {
  it('confirms receiving from a stream_health video bitrate (bits/s → kbps)', () => {
    const h = interpretFacebookIngest({
      status: 'LIVE',
      ingest_streams: [{ id: '1', is_master: true, stream_health: { video_bitrate: 3_902_000, audio_bitrate: 128_000, video_framerate: 30 } }],
    });
    assert.equal(h.receiving, true);
    assert.equal(h.videoKbps, 3902);
    assert.equal(h.audioKbps, 128);
    assert.equal(h.error, null);
    assert.match(h.evidence, /stream_health video 3902 kbps/);
  });

  it('prefers the master ingest stream', () => {
    const h = interpretFacebookIngest({
      ingest_streams: [
        { id: 'backup', is_master: false, stream_health: { video_bitrate: 0 } },
        { id: 'main', is_master: true, stream_health: { video_bitrate: 4_000_000 } },
      ],
    });
    assert.equal(h.videoKbps, 4000);
  });

  // The 10-21 / 10-28 / 11-04 shape: an ingest stream, no reading. Unknown — never "not receiving" —
  // and the evidence names what Facebook did send.
  it('treats an ingest stream without stream_health as unknown and says what FB sent', () => {
    const h = interpretFacebookIngest({
      status: 'LIVE',
      ingest_streams: [{ id: '1579857727521395', is_master: true, dash_preview_url: 'https://x/y.mpd' }],
    });
    assert.equal(h.receiving, false);
    assert.notEqual(h.error, null);
    assert.equal(h.dashPreviewUrl, 'https://x/y.mpd');
    assert.equal(h.evidence, 'status LIVE; 1 ingest stream(s), no stream_health (fields: dash_preview_url,is_master)');
  });

  it('treats a null stream_health the same as a missing one', () => {
    const h = interpretFacebookIngest({ ingest_streams: [{ id: '1', stream_health: null }] });
    assert.notEqual(h.error, null);
    assert.equal(h.receiving, false);
  });

  it('counts no ingest stream at all as a confirmed bad reading, not unknown', () => {
    const h = interpretFacebookIngest({ status: 'LIVE' });
    assert.equal(h.receiving, false);
    assert.equal(h.error, null);
    assert.equal(h.evidence, 'status LIVE; no ingest_streams');
  });

  it('counts a zero bitrate as not receiving', () => {
    const h = interpretFacebookIngest({ ingest_streams: [{ id: '1', stream_health: { video_bitrate: 0 } }] });
    assert.equal(h.receiving, false);
    assert.equal(h.error, null);
  });

  it('reports stream_health that lacks video_bitrate by its keys', () => {
    const h = interpretFacebookIngest({ status: 'LIVE', ingest_streams: [{ id: '1', stream_health: { audio_bitrate: 1 } }] });
    assert.equal(h.receiving, false);
    assert.match(h.evidence, /without video_bitrate \(keys: audio_bitrate\)/);
  });
});

describe('unknownFacebookIngest', () => {
  it('carries the failure into the evidence', () => {
    const h = unknownFacebookIngest('HTTP 400: (#100) bad field');
    assert.equal(h.receiving, false);
    assert.equal(h.evidence, 'probe failed: HTTP 400: (#100) bad field');
  });
});

describe('describeDashManifest', () => {
  it('reports a non-200 status alone', () => {
    // What the 11-04 manifest returns now that the video is VOD.
    assert.equal(describeDashManifest(410, ''), 'DASH preview HTTP 410');
  });

  it('counts representations and segment timeline entries', () => {
    const mpd = '<MPD type="dynamic"><Period><AdaptationSet><Representation id="v"/><Representation id="a"/>' +
      '<SegmentTimeline><S t="0" d="2000"/><S d="2000"/></SegmentTimeline></AdaptationSet></Period></MPD>';
    assert.equal(describeDashManifest(200, mpd), 'DASH preview HTTP 200, type dynamic, 2 representation(s), 2 segment timeline entries');
  });
});
