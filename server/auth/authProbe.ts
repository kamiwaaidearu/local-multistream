// The result of asking a platform whether our credentials still work.
//
// The `determinate` flag is the whole point of this type. Go-live is BLOCKED when a platform's login
// is dead, and that block is deliberately not overridable — a silently broken YouTube grant is what
// cost the 2026-08-05 broadcast. But "the platform told us the grant is revoked" and "we couldn't
// reach the platform to ask" are completely different facts, and collapsing them into one boolean
// would mean a DNS hiccup on the origin could stop a broadcast entirely.
//
// So: !ok && determinate  → the login really is dead. Block, and don't offer an override.
//     !ok && !determinate → we don't know. Warn, and let the operator proceed.

export interface AuthProbe {
  ok: boolean;
  /**
   * True when the platform gave an authoritative answer about the credentials — including an
   * authoritative "no". False only when we could not obtain an answer at all (network failure, DNS,
   * a 5xx from the provider), where treating it as "dead" would be a guess.
   */
  determinate: boolean;
  /** Operator-facing reason, ideally the platform's own wording. */
  error?: string;
}

/** A probe that failed because we couldn't reach the provider — never grounds for blocking. */
export function indeterminate(error: string): AuthProbe {
  return { ok: false, determinate: false, error };
}

/** A probe where the provider authoritatively rejected the credentials. */
export function rejected(error: string): AuthProbe {
  return { ok: false, determinate: true, error };
}

export const VALID: AuthProbe = { ok: true, determinate: true };

/**
 * Should an HTTP status from an auth/token endpoint be treated as an authoritative rejection?
 * 4xx means the provider looked at our credentials and said no. 5xx (and 429) means the provider is
 * having trouble, which says nothing about our grant.
 */
export function statusIsAuthoritative(status: number): boolean {
  if (status === 429) return false;
  return status >= 400 && status < 500;
}
