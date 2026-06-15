import { google, youtube_v3 } from 'googleapis';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getYouTubeAuth } from '../auth/youtube.js';
import { getDb } from '../db/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getYouTube(): youtube_v3.Youtube {
  const auth = getYouTubeAuth();
  if (!auth) throw new Error('YouTube not connected');
  return google.youtube({ version: 'v3', auth });
}

/**
 * Get or create a reusable ingest stream. Reuses the same stream key across broadcasts.
 */
async function getOrCreateReusableStream(): Promise<{ streamId: string; rtmpUrl: string; streamKey: string }> {
  const db = getDb();
  const cred = db.prepare('SELECT extra_json FROM credentials WHERE platform = ?').get('youtube') as { extra_json: string | null } | undefined;
  const extra = cred?.extra_json ? JSON.parse(cred.extra_json) : {};

  // Check if we have a stored reusable stream
  if (extra.yt_reusable_stream_id) {
    try {
      const yt = getYouTube();
      const res = await yt.liveStreams.list({ id: [extra.yt_reusable_stream_id], part: ['cdn', 'status'] });
      const stream = res.data.items?.[0];
      if (stream && stream.status?.streamStatus !== 'error') {
        return {
          streamId: stream.id!,
          rtmpUrl: stream.cdn?.ingestionInfo?.ingestionAddress ?? '',
          streamKey: stream.cdn?.ingestionInfo?.streamName ?? '',
        };
      }
    } catch {
      // Stream might be deleted, create a new one
    }
  }

  // Create new reusable stream
  const yt = getYouTube();
  const res = await yt.liveStreams.insert({
    part: ['snippet', 'cdn', 'contentDetails', 'status'],
    requestBody: {
      snippet: { title: 'Multistream Ingest' },
      cdn: { ingestionType: 'rtmp', frameRate: '30fps', resolution: '1080p' },
      contentDetails: { isReusable: true },
    },
  });

  const stream = res.data;
  const result = {
    streamId: stream.id!,
    rtmpUrl: stream.cdn?.ingestionInfo?.ingestionAddress ?? '',
    streamKey: stream.cdn?.ingestionInfo?.streamName ?? '',
  };

  // Store for reuse
  extra.yt_reusable_stream_id = stream.id;
  db.prepare('UPDATE credentials SET extra_json = ? WHERE platform = ?').run(JSON.stringify(extra), 'youtube');

  return result;
}

/**
 * Create a YouTube broadcast and bind the reusable ingest stream.
 */
export async function createYouTubeBroadcast(
  title: string,
  description: string | null,
  scheduledStart: number | null,
  thumbnailPath: string | null,
): Promise<{ broadcastId: string; streamId: string; rtmpUrl: string; streamKey: string }> {
  const yt = getYouTube();

  // If no scheduled time, use now + 5 minutes
  const startTime = scheduledStart
    ? new Date(scheduledStart * 1000).toISOString()
    : new Date(Date.now() + 5 * 60 * 1000).toISOString();

  // 1. Create broadcast
  const broadcastRes = await yt.liveBroadcasts.insert({
    part: ['snippet', 'contentDetails', 'status'],
    requestBody: {
      snippet: {
        title,
        description: description ?? undefined,
        scheduledStartTime: startTime,
      },
      contentDetails: {
        // We drive the go-live transition ourselves (transitionToLive polls for the
        // stream to become active, then transitions). Autostart must be OFF — with it on,
        // YouTube auto-transitions when data arrives and our transition() call then fails
        // with redundantTransition.
        enableAutoStart: false,
        enableAutoStop: false,
        latencyPreference: 'normal',
        monitorStream: { enableMonitorStream: false },
      },
      status: { privacyStatus: 'public' },
    },
  });

  const broadcastId = broadcastRes.data.id!;

  // 2. Get or create reusable stream
  const { streamId, rtmpUrl, streamKey } = await getOrCreateReusableStream();

  // 3. Bind stream to broadcast
  await yt.liveBroadcasts.bind({ id: broadcastId, streamId, part: ['id', 'contentDetails'] });

  // 4. Upload thumbnail if provided
  if (thumbnailPath) {
    try {
      const fullPath = join(__dirname, '..', '..', thumbnailPath);
      const body = readFileSync(fullPath);
      await yt.thumbnails.set({
        videoId: broadcastId,
        media: { body },
      });
    } catch (err) {
      console.warn('[youtube] Thumbnail upload failed:', err);
    }
  }

  return { broadcastId, streamId, rtmpUrl, streamKey };
}

/**
 * Poll until YouTube stream is active, then transition broadcast to live.
 */
export async function transitionToLive(broadcastId: string, streamId: string): Promise<void> {
  const yt = getYouTube();

  // If broadcast is scheduled in the future, move start time to now so YouTube allows the transition
  try {
    const bcRes = await yt.liveBroadcasts.list({ id: [broadcastId], part: ['snippet', 'status'] });
    const bc = bcRes.data.items?.[0];
    if (bc?.snippet?.scheduledStartTime) {
      const scheduled = new Date(bc.snippet.scheduledStartTime).getTime();
      if (scheduled > Date.now() + 60_000) {
        console.log('[youtube] Broadcast scheduled in the future — moving start time to now');
        bc.snippet.scheduledStartTime = new Date().toISOString();
        await yt.liveBroadcasts.update({
          part: ['snippet'],
          requestBody: { id: broadcastId, snippet: bc.snippet },
        });
      }
    }
  } catch (err) {
    console.warn('[youtube] Could not update scheduled start time:', err);
  }

  // Poll for stream active status (max 2 min, every 5s)
  for (let i = 0; i < 24; i++) {
    const res = await yt.liveStreams.list({ id: [streamId], part: ['status'] });
    const status = res.data.items?.[0]?.status?.streamStatus;

    if (status === 'active') break;
    if (status === 'error') throw new Error('YouTube stream is in error state');
    if (i === 23) throw new Error('YouTube stream did not become active within 2 minutes — check OBS connection');

    await new Promise((r) => setTimeout(r, 5000));
  }

  // Transition to live
  await yt.liveBroadcasts.transition({
    broadcastStatus: 'live',
    id: broadcastId,
    part: ['status'],
  });

  // Poll for live confirmation (max 60s)
  for (let i = 0; i < 12; i++) {
    const res = await yt.liveBroadcasts.list({ id: [broadcastId], part: ['status'] });
    const status = res.data.items?.[0]?.status?.lifeCycleStatus;
    if (status === 'live') return;
    await new Promise((r) => setTimeout(r, 5000));
  }
}

/**
 * End a YouTube broadcast.
 */
export async function endYouTubeBroadcast(broadcastId: string): Promise<void> {
  const yt = getYouTube();
  await yt.liveBroadcasts.transition({
    broadcastStatus: 'complete',
    id: broadcastId,
    part: ['status'],
  });
}

/**
 * Update a YouTube broadcast's title/description/time.
 */
export async function updateYouTubeBroadcast(
  broadcastId: string,
  title?: string,
  description?: string,
  scheduledStart?: number | null,
): Promise<void> {
  const yt = getYouTube();

  // GET-merge-PUT pattern: fetch current, merge changes, put back
  const current = await yt.liveBroadcasts.list({ id: [broadcastId], part: ['snippet'] });
  const snippet = current.data.items?.[0]?.snippet;
  if (!snippet) throw new Error('Broadcast not found');

  if (title !== undefined) snippet.title = title;
  if (description !== undefined) snippet.description = description;
  if (scheduledStart !== undefined) {
    snippet.scheduledStartTime = scheduledStart
      ? new Date(scheduledStart * 1000).toISOString()
      : new Date(Date.now() + 5 * 60 * 1000).toISOString();
  }

  await yt.liveBroadcasts.update({
    part: ['snippet'],
    requestBody: { id: broadcastId, snippet },
  });
}

/**
 * Delete/cancel a YouTube broadcast.
 */
export async function deleteYouTubeBroadcast(broadcastId: string): Promise<void> {
  const yt = getYouTube();
  await yt.liveBroadcasts.delete({ id: broadcastId });
}
