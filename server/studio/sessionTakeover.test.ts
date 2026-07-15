import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideStudioConnection } from './sessionTakeover.js';

const STALE = 8000;

test('accepts a fresh connection when nothing else holds the source', () => {
  assert.equal(
    decideStudioConnection({ hasActiveSession: false, sessionIdleMs: 0, staleMs: STALE, obsPublishing: false }),
    'accept',
  );
});

test('rejects when OBS is publishing and there is no studio session', () => {
  assert.equal(
    decideStudioConnection({ hasActiveSession: false, sessionIdleMs: 0, staleMs: STALE, obsPublishing: true }),
    'reject-obs',
  );
});

test('protects a healthy active session — rejects an accidental second tab', () => {
  assert.equal(
    decideStudioConnection({ hasActiveSession: true, sessionIdleMs: 1000, staleMs: STALE, obsPublishing: false }),
    'reject-active',
  );
});

test('takes over a stale (presumed-dead) session', () => {
  assert.equal(
    decideStudioConnection({ hasActiveSession: true, sessionIdleMs: STALE, staleMs: STALE, obsPublishing: false }),
    'takeover',
  );
  assert.equal(
    decideStudioConnection({ hasActiveSession: true, sessionIdleMs: STALE + 5000, staleMs: STALE, obsPublishing: false }),
    'takeover',
  );
});

test('an active session is judged by liveness, not by OBS — obsPublishing is ignored when a session exists', () => {
  // A live studio session's own ingest publishes RTMP, so obsPublishing would be true; it must not
  // be read as OBS while a session is attached.
  assert.equal(
    decideStudioConnection({ hasActiveSession: true, sessionIdleMs: 1000, staleMs: STALE, obsPublishing: true }),
    'reject-active',
  );
});
