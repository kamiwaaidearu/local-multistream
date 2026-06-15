import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config.js';

// Generate a session token from the secret (deterministic hash so we can validate without storing state)
function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

/**
 * Validate a token against the app secret.
 */
export function validateToken(token: string): boolean {
  if (!config.appSecret) return true; // no auth configured
  return token === hashSecret(config.appSecret);
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

/**
 * Login handler: validates the secret and returns a session token.
 */
export function handleLogin(req: Request, res: Response): void {
  const { secret } = req.body;
  if (!secret || typeof secret !== 'string') {
    res.status(400).json({ error: 'Secret is required' });
    return;
  }

  if (secret !== config.appSecret) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  res.json({ token: hashSecret(secret) });
}

/**
 * Check whether auth is required (APP_SECRET is configured).
 */
export function handleAuthCheck(_req: Request, res: Response): void {
  res.json({ required: !!config.appSecret });
}
