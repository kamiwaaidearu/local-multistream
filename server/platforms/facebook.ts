import { config } from '../config.js';
import { getFacebookPageToken } from '../auth/facebook.js';

const API = `https://graph.facebook.com/${config.fbApiVersion}`;

function getPageAuth(): { accessToken: string; pageId: string } {
  const auth = getFacebookPageToken();
  if (!auth) throw new Error('Facebook not connected or no page selected');
  return auth;
}

/** Safely extract an error message — FB error bodies are usually JSON, but not always. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? res.statusText;
  } catch {
    return res.statusText;
  }
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
    throw new Error(`Facebook live video creation failed: ${await errorMessage(res)}`);
  }

  const data = await res.json() as { id: string; secure_stream_url?: string; stream_url?: string };

  return {
    liveVideoId: data.id,
    streamUrl: data.secure_stream_url ?? data.stream_url ?? '',
  };
}

/**
 * Take a Facebook live video live. Per the Live Video API, an UNPUBLISHED /
 * SCHEDULED_UNPUBLISHED video is "not visible to other users" until it's transitioned to
 * LIVE_NOW via POST /{live-video-id}. The transition only succeeds once the stream URL is
 * already receiving data — so this must be called *after* the fan-out has started pushing.
 * Ref: https://developers.facebook.com/docs/live-video-api (status=LIVE_NOW).
 */
export async function publishFacebookLiveVideo(liveVideoId: string): Promise<void> {
  const { accessToken } = getPageAuth();

  const res = await fetch(`${API}/${liveVideoId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'LIVE_NOW', access_token: accessToken }),
  });

  if (!res.ok) {
    throw new Error(`Facebook publish failed: ${await errorMessage(res)}`);
  }
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
    throw new Error(`Facebook end live failed: ${await errorMessage(res)}`);
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
    throw new Error(`Facebook update failed: ${await errorMessage(res)}`);
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
    console.warn(`[facebook] Delete live video failed: ${await errorMessage(res)}`);
  }
}
