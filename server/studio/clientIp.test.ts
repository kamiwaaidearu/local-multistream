import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveClientIp } from './clientIp.js';

test('ignores forwarding headers when not behind a proxy (anti-spoof)', () => {
  // With no proxy, Express req.ip is the socket address; a spoofed CF-Connecting-IP must be ignored.
  assert.equal(
    resolveClientIp({ trustProxy: false, cfConnectingIp: '1.2.3.4', forwardedIp: '127.0.0.1', socketIp: '127.0.0.1' }),
    '127.0.0.1',
  );
});

test('prefers CF-Connecting-IP when behind a trusted proxy', () => {
  assert.equal(
    resolveClientIp({ trustProxy: true, cfConnectingIp: '1.2.3.4', forwardedIp: '5.6.7.8', socketIp: '127.0.0.1' }),
    '1.2.3.4',
  );
});

test('falls back to req.ip (X-Forwarded-For) behind a proxy without a CF header', () => {
  assert.equal(
    resolveClientIp({ trustProxy: true, forwardedIp: '5.6.7.8', socketIp: '127.0.0.1' }),
    '5.6.7.8',
  );
});

test('falls back to the socket address, then to "unknown"', () => {
  assert.equal(resolveClientIp({ trustProxy: true, socketIp: '127.0.0.1' }), '127.0.0.1');
  assert.equal(resolveClientIp({ trustProxy: false }), 'unknown');
});
