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
 * Create an UNPUBLISHED live video on a Facebook Page, ready to receive RTMP immediately.
 * It stays invisible until transitioned to LIVE_NOW (see publishFacebookLiveVideo), which we
 * do at go-live once data is flowing.
 *
 * NOTE: the API can no longer SCHEDULE live videos — both the old `planned_start_time` and the
 * `SCHEDULED_*` statuses now error ("Scheduled Live has been deprecated"), verified against the
 * live API. So the live video is always created immediately, at go-live. Advance visibility is
 * handled separately by a scheduled announcement post (see createScheduledPagePost).
 */
export async function createFacebookLiveVideo(
  title: string,
  description: string | null,
): Promise<{ liveVideoId: string; streamUrl: string }> {
  const { accessToken, pageId } = getPageAuth();

  const body: Record<string, unknown> = {
    title,
    status: 'UNPUBLISHED',
    access_token: accessToken,
  };

  if (description) body.description = description;

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
 * Resolve the public, shareable URL for a live video. CRITICAL: the id returned by /live_videos
 * (which we store as broadcast_id) is the *live-video* object id — NOT the id used in the public
 * /{page}/videos/{id} permalink, which is the underlying *video* object's id (a different number).
 * Linking to /videos/{live_video_id} yields "This content isn't available right now".
 *
 * So we ask the live-video node for its real link: permalink_url (already a /{page}/videos/{id}/
 * path), falling back to video{id}. Returns an absolute facebook.com URL, or null if it can't be
 * resolved — in which case the caller should fall back to a best-effort URL.
 */
export async function resolveFacebookVideoUrl(liveVideoId: string): Promise<string | null> {
  const { accessToken, pageId } = getPageAuth();

  const params = new URLSearchParams({ fields: 'permalink_url,video{id}', access_token: accessToken });
  const res = await fetch(`${API}/${liveVideoId}?${params}`);
  if (!res.ok) {
    console.warn(`[facebook] Could not resolve video URL for live video ${liveVideoId}: ${await errorMessage(res)}`);
    return null;
  }

  const data = await res.json() as { permalink_url?: string; video?: { id?: string } };

  if (data.permalink_url) {
    // permalink_url is a site-relative path like "/rosarymen/videos/1873954543276237/".
    return data.permalink_url.startsWith('http')
      ? data.permalink_url
      : `https://www.facebook.com${data.permalink_url}`;
  }
  if (data.video?.id) {
    return `https://www.facebook.com/${pageId}/videos/${data.video.id}`;
  }
  return null;
}

/**
 * Take a Facebook live video live. Per the Live Video API, an UNPUBLISHED video is "not visible
 * to other users" until it's transitioned to LIVE_NOW via POST /{live-video-id}. The transition
 * only succeeds once the stream URL is
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

/**
 * Schedule a plain announcement post on the Page. Since the API can't schedule live videos or
 * create events, this is how an upcoming stream gets advance visibility — a normal feed post,
 * published automatically at `scheduledTime` (unix seconds, ~10 min to 6 months ahead). It is
 * NOT publicly visible until then. Returns the new post id.
 */
export async function createScheduledPagePost(
  message: string,
  scheduledTime: number,
): Promise<string> {
  const { accessToken, pageId } = getPageAuth();

  const params = new URLSearchParams({
    message,
    published: 'false',
    scheduled_publish_time: String(scheduledTime),
    access_token: accessToken,
  });

  const res = await fetch(`${API}/${pageId}/feed`, { method: 'POST', body: params });
  if (!res.ok) {
    throw new Error(`Facebook scheduled post failed: ${await errorMessage(res)}`);
  }

  const data = await res.json() as { id: string };
  return data.id;
}

/** Publish a post to the Page immediately (e.g. a "we're live now" announcement). Returns the post id. */
export async function createPagePost(message: string): Promise<string> {
  const { accessToken, pageId } = getPageAuth();

  const params = new URLSearchParams({ message, access_token: accessToken });
  const res = await fetch(`${API}/${pageId}/feed`, { method: 'POST', body: params });
  if (!res.ok) {
    throw new Error(`Facebook post failed: ${await errorMessage(res)}`);
  }

  const data = await res.json() as { id: string };
  return data.id;
}

/** Delete a Page post (e.g. a scheduled announcement no longer needed). Best-effort. */
export async function deletePagePost(postId: string): Promise<void> {
  const { accessToken } = getPageAuth();

  const res = await fetch(`${API}/${postId}?access_token=${encodeURIComponent(accessToken)}`, {
    method: 'DELETE',
  });

  if (!res.ok) {
    console.warn(`[facebook] Delete post failed: ${await errorMessage(res)}`);
  }
}
