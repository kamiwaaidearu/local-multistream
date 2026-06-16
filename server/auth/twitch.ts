import { config } from '../config.js';
import { getDb } from '../db/index.js';

const SCOPES = ['channel:manage:broadcast', 'channel:read:stream_key'];

export function getTwitchAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    redirect_uri: config.twitch.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
  });
  return `https://id.twitch.tv/oauth2/authorize?${params}`;
}

export async function handleTwitchCallback(code: string): Promise<void> {
  // Exchange code for tokens
  const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.twitch.clientId,
      client_secret: config.twitch.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: config.twitch.redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.json();
    throw new Error(`Twitch token exchange failed: ${err.message ?? tokenRes.statusText}`);
  }

  const tokens = await tokenRes.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  // Fetch broadcaster ID
  const userRes = await fetch('https://api.twitch.tv/helix/users', {
    headers: {
      'Authorization': `Bearer ${tokens.access_token}`,
      'Client-Id': config.twitch.clientId,
    },
  });

  if (!userRes.ok) throw new Error('Failed to fetch Twitch user info');
  const { data: users } = await userRes.json() as { data: Array<{ id: string; login: string; display_name: string }> };
  const user = users[0];

  // Fetch stream key
  const keyRes = await fetch(`https://api.twitch.tv/helix/streams/key?broadcaster_id=${user.id}`, {
    headers: {
      'Authorization': `Bearer ${tokens.access_token}`,
      'Client-Id': config.twitch.clientId,
    },
  });

  let streamKey: string | null = null;
  if (keyRes.ok) {
    const { data: keys } = await keyRes.json() as { data: Array<{ stream_key: string }> };
    streamKey = keys[0]?.stream_key ?? null;
  }

  // Store everything
  const db = getDb();
  const expiry = Date.now() + tokens.expires_in * 1000;
  const extra = {
    broadcaster_id: user.id,
    login: user.login,
    display_name: user.display_name,
    stream_key: streamKey,
  };

  db.prepare(`
    INSERT OR REPLACE INTO credentials (platform, access_token, refresh_token, token_expiry, extra_json)
    VALUES ('twitch', ?, ?, ?, ?)
  `).run(tokens.access_token, tokens.refresh_token, expiry, JSON.stringify(extra));
}

export async function refreshTwitchToken(): Promise<string | null> {
  const db = getDb();
  const cred = db.prepare('SELECT * FROM credentials WHERE platform = ?').get('twitch') as {
    access_token: string | null;
    refresh_token: string | null;
    token_expiry: number | null;
    extra_json: string | null;
  } | undefined;

  if (!cred?.refresh_token) return null;

  // Only refresh if within 5 minutes of expiry
  if (cred.token_expiry && cred.token_expiry > Date.now() + 5 * 60 * 1000) {
    return cred.access_token;
  }

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.twitch.clientId,
      client_secret: config.twitch.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: cred.refresh_token,
    }),
  });

  if (!res.ok) {
    console.error('[twitch] Token refresh failed');
    return null;
  }

  const tokens = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const expiry = Date.now() + tokens.expires_in * 1000;
  db.prepare(`
    UPDATE credentials SET access_token = ?, refresh_token = ?, token_expiry = ? WHERE platform = 'twitch'
  `).run(tokens.access_token, tokens.refresh_token, expiry);

  return tokens.access_token;
}

export async function fetchTwitchStreamKey(): Promise<string | null> {
  const db = getDb();
  const cred = db.prepare('SELECT access_token, extra_json FROM credentials WHERE platform = ?').get('twitch') as {
    access_token: string | null;
    extra_json: string | null;
  } | undefined;

  if (!cred?.access_token || !cred.extra_json) return null;
  const extra = JSON.parse(cred.extra_json);

  const accessToken = await refreshTwitchToken() ?? cred.access_token;

  const res = await fetch(`https://api.twitch.tv/helix/streams/key?broadcaster_id=${extra.broadcaster_id}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Client-Id': config.twitch.clientId,
    },
  });

  if (!res.ok) return extra.stream_key ?? null;

  const { data: keys } = await res.json() as { data: Array<{ stream_key: string }> };
  const newKey = keys[0]?.stream_key ?? null;

  if (newKey && newKey !== extra.stream_key) {
    extra.stream_key = newKey;
    db.prepare('UPDATE credentials SET extra_json = ? WHERE platform = ?').run(JSON.stringify(extra), 'twitch');
  }

  return newKey;
}

export function getTwitchCredentials(): { accessToken: string; broadcasterId: string; streamKey: string } | null {
  const db = getDb();
  const cred = db.prepare('SELECT access_token, extra_json FROM credentials WHERE platform = ?').get('twitch') as {
    access_token: string | null;
    extra_json: string | null;
  } | undefined;

  if (!cred?.access_token || !cred.extra_json) return null;
  const extra = JSON.parse(cred.extra_json);
  if (!extra.broadcaster_id || !extra.stream_key) return null;

  return {
    accessToken: cred.access_token,
    broadcasterId: extra.broadcaster_id,
    streamKey: extra.stream_key,
  };
}

/** The connected Twitch channel (for display in Settings). */
export function getTwitchChannelInfo(): { id: string; login: string; displayName: string } | null {
  const db = getDb();
  const cred = db.prepare('SELECT extra_json FROM credentials WHERE platform = ?').get('twitch') as {
    extra_json: string | null;
  } | undefined;

  if (!cred?.extra_json) return null;
  const extra = JSON.parse(cred.extra_json);
  if (!extra.broadcaster_id) return null;

  return {
    id: extra.broadcaster_id,
    login: extra.login ?? '',
    displayName: extra.display_name ?? extra.login ?? extra.broadcaster_id,
  };
}

export function disconnectTwitch(): void {
  const db = getDb();
  db.prepare('DELETE FROM credentials WHERE platform = ?').run('twitch');
}
