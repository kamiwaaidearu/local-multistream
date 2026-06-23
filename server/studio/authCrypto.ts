import crypto from 'crypto';

// Pure crypto helpers for the APP_SECRET auth, split out from auth.ts so they can be unit-tested
// without pulling in Express, config, or the database.

/** Deterministic session token from the secret (so we can validate statelessly). */
export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

/**
 * Constant-time string equality. Both inputs are hashed to fixed-length (32-byte) SHA-256
 * digests before comparison, so the work done never depends on the inputs' length or content —
 * closing the timing side-channel that a raw `===` on the secret would leak. (timingSafeEqual
 * throws on a length mismatch; hashing makes both buffers the same length, and the explicit
 * length check is a defensive backstop.)
 */
export function safeEqual(a: string, b: string): boolean {
  const ah = crypto.createHash('sha256').update(a).digest();
  const bh = crypto.createHash('sha256').update(b).digest();
  return ah.length === bh.length && crypto.timingSafeEqual(ah, bh);
}
