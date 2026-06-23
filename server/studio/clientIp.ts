// Resolves the client IP used to key the login rate limiter. Pure (no Express) so it's unit-testable.
//
// Forwarding headers are trusted ONLY when the app is configured to sit behind a proxy
// (TRUST_PROXY). Otherwise a client could spoof them to dodge or poison the per-IP limiter. When
// trusted: Cloudflare's CF-Connecting-IP is the canonical client IP (the default deployment is
// behind a Cloudflare Tunnel); otherwise fall back to Express's req.ip (X-Forwarded-For-derived).
// With no proxy, req.ip is just the socket address.
export interface ClientIpSources {
  trustProxy: boolean;
  cfConnectingIp?: string; // Cloudflare's CF-Connecting-IP header
  forwardedIp?: string; // Express req.ip
  socketIp?: string; // raw socket remote address
}

export function resolveClientIp({ trustProxy, cfConnectingIp, forwardedIp, socketIp }: ClientIpSources): string {
  if (trustProxy && cfConnectingIp) return cfConnectingIp;
  return forwardedIp || socketIp || 'unknown';
}
