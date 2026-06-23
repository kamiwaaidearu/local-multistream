import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashSecret, safeEqual } from './authCrypto.js';

test('hashSecret is deterministic and 64 hex chars (sha256)', () => {
  assert.equal(hashSecret('hunter2'), hashSecret('hunter2'));
  assert.match(hashSecret('hunter2'), /^[0-9a-f]{64}$/);
  assert.notEqual(hashSecret('hunter2'), hashSecret('hunter3'));
});

test('safeEqual is true only for identical strings', () => {
  assert.equal(safeEqual('correct horse', 'correct horse'), true);
  assert.equal(safeEqual('correct horse', 'correct horsf'), false);
});

test('safeEqual handles differing lengths without throwing', () => {
  // The whole point of hashing both sides: timingSafeEqual would throw on unequal-length raw
  // buffers, but here both are 32-byte digests, so this just returns false.
  assert.equal(safeEqual('short', 'a much longer candidate string'), false);
  assert.equal(safeEqual('', 'nonempty'), false);
  assert.equal(safeEqual('', ''), true);
});

test('safeEqual matches a token against its expected hash (validateToken path)', () => {
  const secret = 'app-secret';
  const token = hashSecret(secret);
  assert.equal(safeEqual(token, hashSecret(secret)), true);
  assert.equal(safeEqual('forged-token', hashSecret(secret)), false);
});
