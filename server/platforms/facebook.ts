import { config } from '../config.js';
import { getFacebookPageToken } from '../auth/facebook.js';
import { httpTimeout } from '../httpTimeout.js';

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
    signal: httpTimeout(),
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
 * Resolve the underlying *video* object id for a live video. CRITICAL: the id returned by
 * /live_videos (which we store as broadcast_id) is the *live-video* object id — NOT the id used in
 * the public /{page}/videos/{id} permalink, which is the underlying *video* object's id (a
 * different number). Linking with the live-video id yields "This content isn't available right
 * now". We read the live-video node's video{id} (falling back to parsing the id out of
 * permalink_url) to get the real id, so the caller can build a /{page}/videos/{id} link that
 * actually works. Returns null if it can't be resolved — the caller should then fall back.
 *
 * Confirmed against the live Graph API: GET /{live_video_id}?fields=video{id},permalink_url returns
 * the real video id, and that /{page}/videos/{id} URL loads the published video.
 */
export async function resolveFacebookVideoId(liveVideoId: string): Promise<string | null> {
  const { accessToken } = getPageAuth();

  const params = new URLSearchParams({ fields: 'video{id},permalink_url', access_token: accessToken });
  const res = await fetch(`${API}/${liveVideoId}?${params}`, { signal: httpTimeout() });
  if (!res.ok) {
    console.warn(`[facebook] Could not resolve video id for live video ${liveVideoId}: ${await errorMessage(res)}`);
    return null;
  }

  const data = await res.json() as { video?: { id?: string }; permalink_url?: string };

  if (data.video?.id) return data.video.id;
  // permalink_url is a path like "/rosarymen/videos/1873954543276237/" — pull the id out.
  const match = data.permalink_url?.match(/\/videos\/(\d+)/);
  return match ? match[1] : null;
}

/** Facebook's own measurement of what it is receiving on the ingest stream. */
export interface FacebookIngestHealth {
  /** FB's live-video status (LIVE, LIVE_STOPPED, UNPUBLISHED, VOD, …), or null if not reported. */
  status: string | null;
  /** True when FB reports an ingest stream carrying a non-zero video bitrate. The authoritative
   *  "is Facebook actually getting our video" signal — see getFacebookIngestHealth. */
  receiving: boolean;
  videoKbps: number | null;
  audioKbps: number | null;
  fps: number | null;
  /** Keyframe interval in milliseconds, as FB measures it. Must stay <= 2000. */
  gopMs: number | null;
  width: number | null;
  height: number | null;
  /** Set when the probe itself failed (network/permissions); health is then unknown, not bad. */
  error: string | null;
}

/**
 * Ask Facebook what it is actually receiving, via `ingest_streams{stream_health}`.
 *
 * This is the only trustworthy way to know a Facebook broadcast is working. Our ffmpeg leg exiting
 * cleanly proves nothing: on 2026-08-05 it pushed for 24 minutes and exited 0 while FB produced a
 * video of 0:00 duration. Nor does the LIVE_NOW publish returning 200 prove anything — FB published
 * that empty video happily. Only stream_health reports the bitrate/framerate/GOP FB itself sees.
 *
 * `receiving` is false when FB reports no ingest stream or a zero video bitrate. A failed request
 * leaves `receiving` false but sets `error`, so callers can distinguish "FB says nothing is arriving"
 * from "we couldn't ask" and avoid acting on a blip in our own connectivity.
 *
 * Ref: https://developers.facebook.com/docs/live-video-api/guides/backup_stream (stream_health
 * fields: video_bitrate, video_framerate, video_gop_size, video_width, video_height, audio_bitrate —
 * bitrates in bits/sec, gop in ms).
 */
export async function getFacebookIngestHealth(liveVideoId: string): Promise<FacebookIngestHealth> {
  const unknown = (error: string): FacebookIngestHealth => ({
    status: null, receiving: false, videoKbps: null, audioKbps: null,
    fps: null, gopMs: null, width: null, height: null, error,
  });

  let data: {
    status?: string;
    ingest_streams?: { is_master?: boolean; stream_health?: Record<string, number> }[];
  };
  try {
    const params = new URLSearchParams({
      fields: 'status,ingest_streams{is_master,stream_health}',
      access_token: getPageAuth().accessToken,
    });
    const res = await fetch(`${API}/${liveVideoId}?${params}`, { signal: httpTimeout() });
    if (!res.ok) return unknown(await errorMessage(res));
    data = await res.json();
  } catch (err) {
    return unknown(err instanceof Error ? err.message : String(err));
  }

  const streams = data.ingest_streams ?? [];
  // Prefer the stream FB has designated master; with no backup stream configured there's just one.
  const health = (streams.find((s) => s.is_master) ?? streams[0])?.stream_health;
  const num = (v: number | undefined): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const kbps = (v: number | undefined): number | null => {
    const n = num(v);
    return n === null ? null : Math.round(n / 1000);
  };

  const videoKbps = kbps(health?.video_bitrate);
  return {
    status: data.status ?? null,
    receiving: videoKbps !== null && videoKbps > 0,
    videoKbps,
    audioKbps: kbps(health?.audio_bitrate),
    fps: num(health?.video_framerate),
    gopMs: num(health?.video_gop_size),
    width: num(health?.video_width),
    height: num(health?.video_height),
    error: null,
  };
}

/**
 * Take a Facebook live video live. Per the Live Video API, an UNPUBLISHED video is "not visible
 * to other users" until it's transitioned to LIVE_NOW via POST /{live-video-id}.
 *
 * IMPORTANT: this returning 200 does NOT mean Facebook is receiving video. We used to publish on a
 * blind 4-second timer and treat success as proof of ingest; on 2026-08-05 that published an empty
 * video and announced it publicly. Callers must confirm ingest via getFacebookIngestHealth first.
 * Ref: https://developers.facebook.com/docs/live-video-api (status=LIVE_NOW).
 */
export async function publishFacebookLiveVideo(liveVideoId: string): Promise<void> {
  const { accessToken } = getPageAuth();

  const res = await fetch(`${API}/${liveVideoId}`, {
    signal: httpTimeout(),
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
    signal: httpTimeout(),
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
    signal: httpTimeout(),
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
    signal: httpTimeout(),
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

  const res = await fetch(`${API}/${pageId}/feed`, { method: 'POST', body: params, signal: httpTimeout() });
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
  const res = await fetch(`${API}/${pageId}/feed`, { method: 'POST', body: params, signal: httpTimeout() });
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
    signal: httpTimeout(),
    method: 'DELETE',
  });

  if (!res.ok) {
    console.warn(`[facebook] Delete post failed: ${await errorMessage(res)}`);
  }
}
