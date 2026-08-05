import { google } from 'googleapis';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { type AuthProbe, indeterminate, rejected, statusIsAuthoritative, VALID } from './authProbe.js';
import { httpTimeout } from '../httpTimeout.js';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/youtube.upload',
];

function createOAuth2Client() {
  return new google.auth.OAuth2(
    config.youtube.clientId,
    config.youtube.clientSecret,
    config.youtube.redirectUri,
  );
}

export function getYouTubeAuthUrl(state: string): string {
  const oauth2Client = createOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
  });
}

export async function handleYouTubeCallback(code: string): Promise<void> {
  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);

  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO credentials (platform, access_token, refresh_token, token_expiry, extra_json)
    VALUES ('youtube', ?, ?, ?, ?)
  `).run(
    tokens.access_token ?? null,
    tokens.refresh_token ?? null,
    tokens.expiry_date ?? null,
    null,
  );
}

export function getYouTubeAuth(): ReturnType<typeof createOAuth2Client> | null {
  const db = getDb();
  const cred = db.prepare('SELECT * FROM credentials WHERE platform = ?').get('youtube') as {
    access_token: string | null;
    refresh_token: string | null;
    token_expiry: number | null;
    extra_json: string | null;
  } | undefined;

  if (!cred?.access_token) return null;

  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({
    access_token: cred.access_token,
    refresh_token: cred.refresh_token,
    expiry_date: cred.token_expiry,
  });

  // Persist refreshed tokens
  oauth2Client.on('tokens', (tokens) => {
    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (tokens.access_token) {
      updates.push('access_token = ?');
      values.push(tokens.access_token);
    }
    if (tokens.refresh_token) {
      updates.push('refresh_token = ?');
      values.push(tokens.refresh_token);
    }
    if (tokens.expiry_date) {
      updates.push('token_expiry = ?');
      values.push(tokens.expiry_date);
    }

    if (updates.length > 0) {
      values.push('youtube');
      db.prepare(`UPDATE credentials SET ${updates.join(', ')} WHERE platform = ?`).run(...values);
    }
  });

  return oauth2Client;
}

/**
 * Exchange the stored refresh token for a fresh access token, and persist it.
 *
 * This exists because `oauth2Client.getAccessToken()` is NOT a test of the refresh token: it returns
 * the cached access token untouched whenever that token hasn't expired yet. That is precisely how the
 * 2026-08-05 broadcast failed — setup at 12:54Z succeeded on a cached access token valid until
 * 13:05Z, while the underlying refresh token had already been revoked. The failure only surfaced at
 * 16:31Z go-live, when a refresh was finally attempted for the first time.
 *
 * Hitting the token endpoint directly is unambiguous about what's being tested, and persisting the
 * result means routine checks also keep the access token warm — so go-live isn't the first thing in
 * hours to depend on the grant still being valid.
 */
export async function refreshYouTubeAccessToken(): Promise<AuthProbe> {
  const db = getDb();
  const cred = db.prepare('SELECT refresh_token FROM credentials WHERE platform = ?').get('youtube') as
    { refresh_token: string | null } | undefined;

  // No stored grant at all is an authoritative "unusable" — nothing to reach out and check.
  if (!cred?.refresh_token) return rejected('No YouTube account is connected');

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      // Without this, a hung token endpoint stalls goLive's auth pre-flight forever while
      // goLiveInFlight stays set — the operator then cannot start the broadcast at all.
      signal: httpTimeout(),
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.youtube.clientId,
        client_secret: config.youtube.clientSecret,
        refresh_token: cred.refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    const data = (await res.json()) as {
      access_token?: string; expires_in?: number; error?: string; error_description?: string;
    };

    if (!res.ok || !data.access_token) {
      // invalid_grant here means the grant is dead and NO amount of retrying will fix it — the
      // operator must reconnect YouTube. Surface Google's own wording; it distinguishes "expired or
      // revoked" from other failures. A 5xx from Google, by contrast, tells us nothing about our
      // grant, so it must not be allowed to block a broadcast.
      const message = data.error_description ?? data.error ?? res.statusText;
      return statusIsAuthoritative(res.status)
        ? rejected(message)
        : indeterminate(`Google could not answer right now (${res.status}): ${message}`);
    }

    db.prepare('UPDATE credentials SET access_token = ?, token_expiry = ? WHERE platform = ?').run(
      data.access_token,
      Date.now() + (data.expires_in ?? 3600) * 1000,
      'youtube',
    );
    return VALID;
  } catch (err) {
    // A network blip is NOT a dead grant — say so, so callers don't tell the operator to reconnect
    // and, more importantly, so this can never hard-block a go-live.
    return indeterminate(`Could not reach Google: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Cache the last real probe briefly. getPlatformAuthHealth backs both the UI's pre-go-live check and
// the watchdog; without this, a future caller adding a poll would hammer Google's token endpoint.
let lastProbe: { at: number; probe: AuthProbe } | null = null;
const PROBE_CACHE_MS = 60_000;

/** The most recent probe result, for surfacing WHY auth is broken without re-probing. */
export function lastYouTubeAuthError(): string | null {
  return lastProbe && !lastProbe.probe.ok ? lastProbe.probe.error ?? 'Unknown error' : null;
}

/**
 * Verify YouTube auth is genuinely usable, by exercising the refresh token rather than trusting a
 * cached access token. See AuthProbe for why the result distinguishes "revoked" from "unreachable".
 */
export async function probeYouTubeAuth(opts: { force?: boolean } = {}): Promise<AuthProbe> {
  if (!getYouTubeAuth()) return rejected('No YouTube account is connected');

  if (!opts.force && lastProbe && Date.now() - lastProbe.at < PROBE_CACHE_MS) {
    return lastProbe.probe;
  }

  const probe = await refreshYouTubeAccessToken();
  lastProbe = { at: Date.now(), probe };
  return probe;
}

/** Boolean convenience wrapper, for callers that only care whether it works. */
export async function validateYouTubeAuth(opts: { force?: boolean } = {}): Promise<boolean> {
  return (await probeYouTubeAuth(opts)).ok;
}

export function disconnectYouTube(): void {
  const db = getDb();
  db.prepare('DELETE FROM credentials WHERE platform = ?').run('youtube');
}
