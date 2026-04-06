import { config } from '../config.js';
import { getFacebookPageToken } from '../auth/facebook.js';

const API = `https://graph.facebook.com/${config.fbApiVersion}`;

function getPageAuth(): { accessToken: string; pageId: string } {
  const auth = getFacebookPageToken();
  if (!auth) throw new Error('Facebook not connected or no page selected');
  return auth;
}

/**
 * Create a scheduled live video on a Facebook Page.
 */
export async function createFacebookLiveVideo(
  title: string,
  description: string | null,
  scheduledStart: number | null,
): Promise<{ liveVideoId: string; streamUrl: string }> {
  const { accessToken, pageId } = getPageAuth();

  const body: Record<string, unknown> = {
    title,
    access_token: accessToken,
  };

  if (description) body.description = description;

  if (scheduledStart) {
    body.planned_start_time = scheduledStart;
    body.status = 'SCHEDULED_UNPUBLISHED';
  } else {
    body.status = 'UNPUBLISHED';
  }

  const res = await fetch(`${API}/${pageId}/live_videos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Facebook live video creation failed: ${err.error?.message ?? res.statusText}`);
  }

  const data = await res.json() as { id: string; secure_stream_url?: string; stream_url?: string };

  return {
    liveVideoId: data.id,
    streamUrl: data.secure_stream_url ?? data.stream_url ?? '',
  };
}

/**
 * End a Facebook live video.
 */
export async function endFacebookLiveVideo(liveVideoId: string): Promise<void> {
  const { accessToken } = getPageAuth();

  const res = await fetch(`${API}/${liveVideoId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      end_live_video: true,
      access_token: accessToken,
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Facebook end live failed: ${err.error?.message ?? res.statusText}`);
  }
}

/**
 * Update a Facebook live video's title/description.
 */
export async function updateFacebookLiveVideo(
  liveVideoId: string,
  title?: string,
  description?: string,
): Promise<void> {
  const { accessToken } = getPageAuth();

  const body: Record<string, unknown> = { access_token: accessToken };
  if (title !== undefined) body.title = title;
  if (description !== undefined) body.description = description;

  const res = await fetch(`${API}/${liveVideoId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Facebook update failed: ${err.error?.message ?? res.statusText}`);
  }
}

/**
 * Delete a Facebook live video.
 */
export async function deleteFacebookLiveVideo(liveVideoId: string): Promise<void> {
  const { accessToken } = getPageAuth();

  const res = await fetch(`${API}/${liveVideoId}?access_token=${accessToken}`, {
    method: 'DELETE',
  });

  if (!res.ok) {
    const err = await res.json();
    console.warn(`[facebook] Delete live video failed: ${err.error?.message ?? res.statusText}`);
  }
}
