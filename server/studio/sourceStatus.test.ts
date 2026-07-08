import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSourceStatus } from './sourceStatus.js';

test('reports Studio when the Studio WebSocket is up (even though its ingest also publishes RTMP)', () => {
  // A live Studio session has BOTH signals true — the WebSocket must win so we don't mislabel it OBS.
  assert.deepEqual(resolveSourceStatus(true, true), { connected: true, source: 'studio' });
  // WebSocket up but ingest FFmpeg hasn't published to RTMP yet (the go-live warm-up window).
  assert.deepEqual(resolveSourceStatus(true, false), { connected: true, source: 'studio' });
});

test('reports OBS when something publishes to RTMP without a Studio WebSocket', () => {
  assert.deepEqual(resolveSourceStatus(false, true), { connected: true, source: 'obs' });
});

test('reports nothing connected when neither source is present', () => {
  assert.deepEqual(resolveSourceStatus(false, false), { connected: false, source: null });
});
