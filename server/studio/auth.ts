import { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { hashSecret, safeEqual } from './authCrypto.js';
import { LoginRateLimiter } from './loginRateLimiter.js';
import { resolveClientIp } from './clientIp.js';

/**
 * Validate a token against the app secret.
 */
export function validateToken(token: string): boolean {
  if (!config.appSecret) return true; // no auth configured
  return safeEqual(token, hashSecret(config.appSecret));
}

/**
 * Express middleware that gates all routes behind APP_SECRET.
 * Skips auth if APP_SECRET is not set.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!config.appSecret) {
    next();
    return;
  }

  // Allow the login endpoint through
  if (req.path === '/auth/login') {
    next();
    return;
  }

  // SSE: EventSource cannot send an Authorization header, so the live-events stream
  // authenticates via a query-param token instead (same token the WebSocket uses).
  if (req.path === '/stream/events') {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (validateToken(token)) {
      next();
    } else {
      res.status(401).json({ error: 'Authentication required' });
    }
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const token = authHeader.slice(7);
  if (!validateToken(token)) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  next();
}

// --- Login rate limiting ---------------------------------------------------
// The shared password is the only credential, so an unthrottled POST /api/auth/login is
// brute-forceable. This per-IP limiter (see loginRateLimiter.ts) throttles failed attempts.
//
// CRITICAL CARVE-OUT: it's disabled while a stream is live (see isStreamLive). During a broadcast
// the operator must always be able to (re)authenticate — e.g. after a refreshed tab, on a second
// device, or to reach "End Stream" — so we never lock them out of an in-progress stream. (Ongoing
// in-stream requests use validateToken, which is never rate-limited, and the stateless token never
// expires — so a session already in flight is unaffected regardless; this only guards re-login.)
// Trade-off: brute-force is unthrottled for the duration of a live stream — an accepted cost of the
// hard "never lock out mid-broadcast" requirement, since we can't distinguish operator from attacker.
const loginLimiter = new LoginRateLimiter();

function clientIp(req: Request): string {
  // Behind a Cloudflare Tunnel (the default deployment), every request reaches Express from
  // localhost, so we must read the forwarded client IP — but only when TRUST_PROXY is set, or a
  // client could spoof it. resolveClientIp prefers Cloudflare's CF-Connecting-IP, then req.ip.
  const cf = req.headers['cf-connecting-ip'];
  return resolveClientIp({
    trustProxy: config.trustProxy !== null,
    cfConnectingIp: typeof cf === 'string' ? cf : undefined,
    forwardedIp: req.ip,
    socketIp: req.socket.remoteAddress,
  });
}

// Is a stream currently live? Same source of truth as goLive's concurrent-stream guard. Cheap
// synchronous lookup; treated as "not live" if the DB is somehow unavailable, so the limiter still
// applies by default rather than silently switching off.
function isStreamLive(): boolean {
  try {
    return !!getDb().prepare("SELECT 1 FROM streams WHERE status = 'live' LIMIT 1").get();
  } catch {
    return false;
  }
}

/**
 * Login handler: validates the secret and returns a session token.
 */
export function handleLogin(req: Request, res: Response): void {
  // The limiter is off in no-auth mode (APP_SECRET empty) and while a stream is live, so an
  // in-progress broadcast can never lock the operator out of re-authenticating. We check
  // liveness once, up front, so the gate is consistent across this request.
  const limiterActive = !!config.appSecret && !isStreamLive();
  const ip = clientIp(req);

  if (limiterActive) {
    const retryAfterMs = loginLimiter.retryAfterMs(ip);
    if (retryAfterMs > 0) {
      res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000));
      res.status(429).json({ error: 'Too many login attempts. Try again later.' });
      return;
    }
  }

  const { secret } = req.body;
  if (!secret || typeof secret !== 'string') {
    res.status(400).json({ error: 'Secret is required' });
    return;
  }

  if (!safeEqual(secret, config.appSecret)) {
    if (limiterActive) loginLimiter.recordFailure(ip);
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  loginLimiter.clear(ip); // successful login clears the counter
  res.json({ token: hashSecret(secret) });
}

/**
 * Check whether auth is required (APP_SECRET is configured).
 */
export function handleAuthCheck(_req: Request, res: Response): void {
  res.json({ required: !!config.appSecret });
}
