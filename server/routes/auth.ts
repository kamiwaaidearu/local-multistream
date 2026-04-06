import { Router, Request, Response } from 'express';
import { getYouTubeAuthUrl, handleYouTubeCallback } from '../auth/youtube.js';
import { getFacebookAuthUrl, handleFacebookCallback, getFacebookPages, selectFacebookPage } from '../auth/facebook.js';
import { getTwitchAuthUrl, handleTwitchCallback } from '../auth/twitch.js';
import { config } from '../config.js';

export const authRouter = Router();

// --- YouTube OAuth ---

authRouter.get('/youtube/start', (_req: Request, res: Response) => {
  if (!config.youtube.clientId) {
    res.status(400).json({ error: 'YouTube credentials not configured in .env' });
    return;
  }
  res.redirect(getYouTubeAuthUrl());
});

authRouter.get('/youtube/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  if (!code) {
    res.status(400).json({ error: 'Missing authorization code' });
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

authRouter.get('/facebook/start', (_req: Request, res: Response) => {
  if (!config.facebook.appId) {
    res.status(400).json({ error: 'Facebook credentials not configured in .env' });
    return;
  }
  res.redirect(getFacebookAuthUrl());
});

authRouter.get('/facebook/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  if (!code) {
    res.status(400).json({ error: 'Missing authorization code' });
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

authRouter.get('/twitch/start', (_req: Request, res: Response) => {
  if (!config.twitch.clientId) {
    res.status(400).json({ error: 'Twitch credentials not configured in .env' });
    return;
  }
  res.redirect(getTwitchAuthUrl());
});

authRouter.get('/twitch/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  if (!code) {
    res.status(400).json({ error: 'Missing authorization code' });
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
