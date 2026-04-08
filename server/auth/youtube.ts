import { google } from 'googleapis';
import { config } from '../config.js';
import { getDb } from '../db/index.js';

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

export function getYouTubeAuthUrl(): string {
  const oauth2Client = createOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
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

export function disconnectYouTube(): void {
  const db = getDb();
  db.prepare('DELETE FROM credentials WHERE platform = ?').run('youtube');
}
