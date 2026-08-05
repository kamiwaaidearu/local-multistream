import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { logFileName, shouldRotate, filesToPrune } from './logRotation.js';

describe('logFileName', () => {
  it('names the file for the local calendar day, zero-padded', () => {
    assert.equal(logFileName(new Date(2026, 7, 5, 12, 31)), 'server-2026-08-05.log');
    assert.equal(logFileName(new Date(2026, 0, 9, 0, 0)), 'server-2026-01-09.log');
  });
});

describe('shouldRotate', () => {
  it('does not rotate within the same local day', () => {
    const opened = new Date(2026, 7, 5, 0, 0, 1);
    assert.equal(shouldRotate(opened, new Date(2026, 7, 5, 23, 59, 59)), false);
  });

  it('rotates once the local day changes', () => {
    const opened = new Date(2026, 7, 5, 23, 59, 59);
    assert.equal(shouldRotate(opened, new Date(2026, 7, 6, 0, 0, 0)), true);
  });

  it('rotates across a year boundary', () => {
    assert.equal(shouldRotate(new Date(2026, 11, 31, 23, 0), new Date(2027, 0, 1, 1, 0)), true);
  });
});

describe('filesToPrune', () => {
  const today = new Date(2026, 7, 5);

  it('keeps files inside the retention window, including the oldest kept day', () => {
    // retention 3 on Aug 5 keeps Aug 3, 4, 5.
    const names = ['server-2026-08-05.log', 'server-2026-08-04.log', 'server-2026-08-03.log'];
    assert.deepEqual(filesToPrune(names, today, 3), []);
  });

  it('prunes files older than the window', () => {
    const names = ['server-2026-08-05.log', 'server-2026-08-02.log', 'server-2026-07-29.log'];
    assert.deepEqual(filesToPrune(names, today, 3), ['server-2026-08-02.log', 'server-2026-07-29.log']);
  });

  it('never touches files it did not create', () => {
    const names = ['notes.txt', 'server.log', 'server-2026-13-99.log', 'server-2020-01-01.log.bak'];
    assert.deepEqual(filesToPrune(names, today, 1), []);
  });

  it('disables pruning when retention is zero or negative, rather than deleting everything', () => {
    const names = ['server-2020-01-01.log', 'server-2026-08-05.log'];
    assert.deepEqual(filesToPrune(names, today, 0), []);
    assert.deepEqual(filesToPrune(names, today, -5), []);
  });

  it('prunes a stale file across a year boundary', () => {
    assert.deepEqual(
      filesToPrune(['server-2025-12-31.log'], new Date(2026, 0, 5), 3),
      ['server-2025-12-31.log'],
    );
  });
});
