import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  planSwap,
  swapRefusalReason,
  isSwappable,
  SWAPPED_FIELDS,
  type SwappableStream,
} from './swapPolicy.js';

function stream(over: Partial<SwappableStream> = {}): SwappableStream {
  return {
    id: 'a',
    name: 'Joyful Mysteries',
    description: 'Monday night rosary',
    thumbnail_path: '/uploads/joyful.png',
    status: 'ready',
    ...over,
  };
}

describe('swapRefusalReason', () => {
  it('allows two editable events', () => {
    assert.equal(swapRefusalReason(stream({ id: 'a' }), stream({ id: 'b' })), null);
    assert.equal(swapRefusalReason(stream({ id: 'a', status: 'draft' }), stream({ id: 'b', status: 'ready' })), null);
  });

  it('refuses swapping an event with itself', () => {
    const only = stream({ id: 'a' });
    assert.match(swapRefusalReason(only, only) ?? '', /two different events/);
  });

  it('refuses when either side is past editing', () => {
    // A live or ended broadcast's title is already in front of people; re-pointing it mid-flight
    // would rename what viewers are watching.
    for (const status of ['live', 'ended', 'error']) {
      assert.equal(isSwappable(status), false);
      const bad = stream({ id: 'b', name: 'Sorrowful Mysteries', status });
      assert.match(swapRefusalReason(stream({ id: 'a' }), bad) ?? '', /Sorrowful Mysteries/, `b ${status}`);
      assert.match(swapRefusalReason(bad, stream({ id: 'a' })) ?? '', /Sorrowful Mysteries/, `a ${status}`);
    }
  });
});

describe('planSwap', () => {
  const a = stream({ id: 'a', name: 'A', description: 'desc A', thumbnail_path: '/uploads/a.png' });
  const b = stream({ id: 'b', name: 'B', description: null, thumbnail_path: null });

  it('exchanges every swapped field, including nulls', () => {
    const [newA, newB] = planSwap(a, b);
    assert.deepEqual(newA, { id: 'a', name: 'B', description: null, thumbnail_path: null });
    assert.deepEqual(newB, { id: 'b', name: 'A', description: 'desc A', thumbnail_path: '/uploads/a.png' });
  });

  it('never carries a date or any field outside SWAPPED_FIELDS', () => {
    // The whole promise of the feature: the dates stay where they are. An assignment that grew a
    // `scheduled_start` would silently move the events instead.
    const [newA] = planSwap(a, b);
    assert.deepEqual(Object.keys(newA).sort(), ['id', ...SWAPPED_FIELDS].sort());
  });

  it('round-trips — swapping twice restores the original content', () => {
    const [onceA, onceB] = planSwap(a, b);
    const [twiceA, twiceB] = planSwap({ ...a, ...onceA }, { ...b, ...onceB });
    assert.deepEqual(twiceA, { id: 'a', name: 'A', description: 'desc A', thumbnail_path: '/uploads/a.png' });
    assert.deepEqual(twiceB, { id: 'b', name: 'B', description: null, thumbnail_path: null });
  });
});
