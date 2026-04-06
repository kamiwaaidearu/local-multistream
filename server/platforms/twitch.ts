import { config } from '../config.js';
import { refreshTwitchToken, getTwitchCredentials, fetchTwitchStreamKey } from '../auth/twitch.js';

const HELIX = 'https://api.twitch.tv/helix';

async function getHeaders(): Promise<Record<string, string>> {
  const accessToken = await refreshTwitchToken();
  if (!accessToken) throw new Error('Twitch not connected');
  return {
    'Authorization': `Bearer ${accessToken}`,
    'Client-Id': config.twitch.clientId,
    'Content-Type': 'application/json',
  };
}

/**
 * Update the Twitch channel title (and optionally game/category).
 */
export async function updateTwitchChannel(
  title: string,
  gameId?: string,
): Promise<void> {
  const creds = getTwitchCredentials();
  if (!creds) throw new Error('Twitch not connected');

  const headers = await getHeaders();
  const body: Record<string, string> = { title };
  if (gameId) body.game_id = gameId;

  const res = await fetch(`${HELIX}/channels?broadcaster_id=${creds.broadcasterId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Twitch channel update failed: ${err}`);
  }
}

/**
 * Check if the Twitch channel is currently live.
 */
export async function isTwitchLive(): Promise<boolean> {
  const creds = getTwitchCredentials();
  if (!creds) return false;

  const headers = await getHeaders();
  const res = await fetch(`${HELIX}/streams?user_id=${creds.broadcasterId}`, { headers });

  if (!res.ok) return false;
  const { data } = await res.json() as { data: unknown[] };
  return data.length > 0;
}

/**
 * Get the Twitch stream key (re-fetches to handle dashboard resets).
 */
export async function getTwitchStreamKey(): Promise<string> {
  const key = await fetchTwitchStreamKey();
  if (!key) throw new Error('Could not fetch Twitch stream key');
  return key;
}

/**
 * Fetch the most recent Twitch VOD URL after ending a stream.
 */
export async function getTwitchVodUrl(): Promise<string | null> {
  const creds = getTwitchCredentials();
  if (!creds) return null;

  const headers = await getHeaders();
  const res = await fetch(`${HELIX}/videos?user_id=${creds.broadcasterId}&type=archive&first=1`, { headers });

  if (!res.ok) return null;
  const { data } = await res.json() as { data: Array<{ url: string }> };
  return data[0]?.url ?? null;
}
