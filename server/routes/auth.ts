import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getYouTubeAuthUrl, handleYouTubeCallback } from '../auth/youtube.js';
import { getFacebookAuthUrl, handleFacebookCallback } from '../auth/facebook.js';
import { getTwitchAuthUrl, handleTwitchCallback } from '../auth/twitch.js';
import { authMiddleware } from '../studio/auth.js';
import { config } from '../config.js';

export const authRouter = Router();

// --- OAuth CSRF protection ---
//
// Each connect flow is tied to a one-time, short-lived `state` nonce. The nonce is minted only
// at /start, which sits behind authMiddleware, so only a caller holding APP_SECRET can obtain
// one. The provider echoes it back to the (necessarily public) /callback, where we require and
// consume it. This blocks OAuth login-CSRF — an unauthenticated attacker can no longer trick
// an operator into a callback that grafts the attacker's YouTube/Facebook/Twitch account onto
// this instance. The store is in-process (one Express app serves both the HTTP and HTTPS
// listeners), so it works even though the callback origins differ across platforms.
const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map<string, number>(); // state -> expiry (epoch ms)

function issueState(): string {
  const state = crypto.randomBytes(32).toString('hex');
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  return state;
}

function consumeState(state: unknown): boolean {
  if (typeof state !== 'string') return false;
  const expiry = pendingStates.get(state);
  if (expiry === undefined) return false;
  pendingStates.delete(state); // one-time use
  return expiry > Date.now();
}

// Drop abandoned (never-completed) flows so the map can't grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [state, expiry] of pendingStates) {
    if (expiry <= now) pendingStates.delete(state);
  }
}, STATE_TTL_MS).unref();

// --- YouTube OAuth ---

authRouter.get('/youtube/start', authMiddleware, (_req: Request, res: Response) => {
  if (!config.youtube.clientId) {
    res.status(400).json({ error: 'YouTube credentials not configured in .env' });
    return;
  }
  res.json({ url: getYouTubeAuthUrl(issueState()) });
});

authRouter.get('/youtube/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  if (!code) {
    res.status(400).json({ error: 'Missing authorization code' });
    return;
  }
  if (!consumeState(req.query.state)) {
    res.redirect('/settings?error=youtube');
    return;
  }
  try {
    await handleYouTubeCallback(code);
    res.redirect('/settings?connected=youtube');
  } catch (err) {
    console.error('[auth/youtube] Callback error:', err);
    res.redirect('/settings?error=youtube');
  }
});

// --- Facebook OAuth ---

authRouter.get('/facebook/start', authMiddleware, (_req: Request, res: Response) => {
  if (!config.facebook.appId) {
    res.status(400).json({ error: 'Facebook credentials not configured in .env' });
    return;
  }
  res.json({ url: getFacebookAuthUrl(issueState()) });
});

authRouter.get('/facebook/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  if (!code) {
    res.status(400).json({ error: 'Missing authorization code' });
    return;
  }
  if (!consumeState(req.query.state)) {
    res.redirect('/settings?error=facebook');
    return;
  }
  try {
    await handleFacebookCallback(code);
    // Redirect to settings where user will pick a page
    res.redirect('/settings?connected=facebook&pick_page=true');
  } catch (err) {
    console.error('[auth/facebook] Callback error:', err);
    res.redirect('/settings?error=facebook');
  }
});

// --- Twitch OAuth ---

authRouter.get('/twitch/start', authMiddleware, (_req: Request, res: Response) => {
  if (!config.twitch.clientId) {
    res.status(400).json({ error: 'Twitch credentials not configured in .env' });
    return;
  }
  res.json({ url: getTwitchAuthUrl(issueState()) });
});

authRouter.get('/twitch/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  if (!code) {
    res.status(400).json({ error: 'Missing authorization code' });
    return;
  }
  if (!consumeState(req.query.state)) {
    res.redirect('/settings?error=twitch');
    return;
  }
  try {
    await handleTwitchCallback(code);
    res.redirect('/settings?connected=twitch');
  } catch (err) {
    console.error('[auth/twitch] Callback error:', err);
    res.redirect('/settings?error=twitch');
  }
});
