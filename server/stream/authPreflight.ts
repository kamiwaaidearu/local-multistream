// Pure go-live auth pre-flight decision, split from manager.ts so the rules can be unit-tested.
//
// This gate is the direct answer to the 2026-08-05 failure: a connected YouTube account whose grant
// had been revoked, which the UI showed as green and which went "live" without broadcasting anything.
// It's therefore deliberately strict — but strictness has a failure mode of its own (refusing to let
// the operator on air), so the two tiers below matter a great deal.

export interface PreflightHealth {
  connected: boolean;
  ok: boolean;
  error?: string | null;
  /** False only when we could not reach the platform to ask. See auth/authProbe.ts. */
  determinate?: boolean;
}

export interface PreflightDecision {
  /**
   * - proceed: nothing is wrong, or the operator has acknowledged an unverifiable platform.
   * - block:   a platform authoritatively reports a dead login. NOT overridable by force.
   * - confirm: we couldn't verify a platform. Overridable — the operator may proceed.
   */
  action: 'proceed' | 'block' | 'confirm';
  platforms: string[];
  detail?: string;
}

/**
 * Decide whether a go-live may proceed.
 *
 * Only CONNECTED platforms are considered: one that was never connected simply isn't part of the
 * stream, so it can't block anything.
 *
 * `determinate !== false` is the deliberate default. If a probe doesn't report determinacy at all, we
 * treat its failure as authoritative and block. Erring toward blocking on an ambiguous *rejection* is
 * safe; erring toward blocking on an *unreachable platform* is not, and that case is explicitly
 * flagged by the probe rather than inferred here.
 */
export function decidePreflight(
  health: Record<string, PreflightHealth>,
  force: boolean,
): PreflightDecision {
  const bad = Object.entries(health).filter(([, v]) => v.connected && !v.ok);
  if (bad.length === 0) return { action: 'proceed', platforms: [] };

  const dead = bad.filter(([, v]) => v.determinate !== false);
  if (dead.length > 0) {
    return {
      action: 'block',
      platforms: dead.map(([p]) => p),
      detail: dead[0][1].error ?? undefined,
    };
  }

  // Everything remaining is indeterminate — we couldn't reach these platforms to check.
  if (force) return { action: 'proceed', platforms: bad.map(([p]) => p) };
  return {
    action: 'confirm',
    platforms: bad.map(([p]) => p),
    detail: bad[0][1].error ?? undefined,
  };
}
