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

/** The connected channel's id + title (for display in Settings). */
export async function getYouTubeChannelInfo(): Promise<{ id: string; title: string } | null> {
  const yt = getYouTube();
  const res = await yt.channels.list({ part: ['snippet'], mine: true });
  const ch = res.data.items?.[0];
  if (!ch) return null;
  return { id: ch.id ?? '', title: ch.snippet?.title ?? ch.id ?? '' };
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
  /** Create the broadcast as private (a dry run) instead of public. */
  isTest = false,
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
        // Autostart OFF. It was briefly enabled to remove the OAuth token from the go-live critical
        // path, but measurement showed it makes things WORSE in this architecture, so it's reverted:
        //
        //  - Turning it on makes the manual transition permanently illegal: liveBroadcasts.transition
        //    returns 403 invalidTransition from `ready`, and keeps returning it. YouTube reserves the
        //    ready -> live move for itself.
        //  - But autostart only fires when the bound stream BECOMES active. We reuse one persistent
        //    stream across broadcasts (getOrCreateReusableStream) and goLive deliberately waits for the
        //    ingest to be publishing before it starts, so the stream is almost always active ALREADY.
        //    No edge, no autostart.
        //
        // Observed live on 2026-08-05: broadcast stuck at `ready` with streamStatus `active` and
        // healthStatus `good`, transition refused on every retry — i.e. unrecoverable. Whereas the
        // manual transition had succeeded every week for a month (07-08 through 07-29).
        //
        // Wednesday's actual root cause — a revoked grant discovered at go-live — is addressed by the
        // auth watchdog, the hard go-live gate, and validating the REFRESH token rather than a cached
        // access token. None of those depend on autostart.
        enableAutoStart: false,
        // Autostop stays OFF: it would end the broadcast on a brief source drop, killing the
        // reconnect window that lets a stream survive the operator's network hiccuping.
        enableAutoStop: false,
        latencyPreference: 'normal',
        monitorStream: { enableMonitorStream: false },
      },
      status: {
        // 'private' (not 'unlisted') for a test: unlisted is viewable by anyone holding the link, which
        // is not a guarantee worth relying on for a rehearsal. Private is visible only to the account.
        privacyStatus: isTest ? 'private' : 'public',
        // Declare the audience up front. Without this, YouTube leaves every API-created broadcast
        // pending and nags in Studio before it will publish — a manual step per broadcast, on the day.
        // It also isn't merely paperwork: "made for kids" DISABLES comments, so leaving it unset (or
        // answering it wrongly under time pressure) would silence the congregation on a prayer stream.
        // false = not made for kids, which is the operator's standing answer for this channel.
        selfDeclaredMadeForKids: false,
      },
    },
  });

  const broadcastId = broadcastRes.data.id!;

  // 2. Get or create reusable stream
  const { streamId, rtmpUrl, streamKey } = await getOrCreateReusableStream();

  // 3. Bind stream to broadcast
  await yt.liveBroadcasts.bind({ id: broadcastId, streamId, part: ['id', 'contentDetails'] });

  // 4. Upload thumbnail if provided. Best-effort here: a rejected image must not cost us the
  // broadcast we just created and bound.
  if (thumbnailPath) {
    try {
      await setYouTubeThumbnail(broadcastId, thumbnailPath);
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
    if (i === 23) throw new Error('YouTube stream did not become active within 2 minutes — check your video source (OBS or Web Studio)');

    await new Promise((r) => setTimeout(r, 5000));
  }

  // Already live? Nothing to do. (Cheap, and covers a retry after a partial success.)
  if (await isBroadcastLive(yt, broadcastId)) {
    console.log('[youtube] Broadcast is already live — no transition needed');
    return;
  }

  try {
    await yt.liveBroadcasts.transition({
      broadcastStatus: 'live',
      id: broadcastId,
      part: ['status'],
    });
  } catch (err) {
    // Don't interpret the error reason — ask what state the broadcast is ACTUALLY in. Both
    // redundantTransition and invalidTransition can mean "someone already moved it", and they can
    // equally mean a genuine refusal; only the resulting lifecycle tells us which. Guessing from the
    // reason string is what produced a reassuring "autostart probably handled it" message for a
    // broadcast that was in fact stuck at `ready` and never went live.
    const state = await broadcastLifeCycle(yt, broadcastId);
    if (state === 'live' || state === 'liveStarting') {
      console.log(`[youtube] Transition rejected but broadcast is ${state} — treating as success`);
      return;
    }
    console.error(`[youtube] Transition failed and broadcast is still "${state}" — it is NOT live`);
    throw err;
  }

  // Poll for live confirmation (max 60s)
  for (let i = 0; i < 12; i++) {
    const res = await yt.liveBroadcasts.list({ id: [broadcastId], part: ['status'] });
    const status = res.data.items?.[0]?.status?.lifeCycleStatus;
    if (status === 'live') return;
    await new Promise((r) => setTimeout(r, 5000));
  }
}

/**
 * The broadcast's current lifeCycleStatus (created / ready / testing / live / complete / revoked), or
 * 'unknown' when it can't be read.
 *
 * This is the authoritative answer to "did it actually go live", and is deliberately used INSTEAD of
 * interpreting transition error reasons — see the catch block in transitionToLive.
 */
async function broadcastLifeCycle(yt: ReturnType<typeof getYouTube>, broadcastId: string): Promise<string> {
  try {
    const res = await yt.liveBroadcasts.list({ id: [broadcastId], part: ['status'] });
    return res.data.items?.[0]?.status?.lifeCycleStatus ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Is this broadcast already live? Best-effort — a read failure returns false so the caller still
 *  attempts the transition rather than assuming success. */
async function isBroadcastLive(yt: ReturnType<typeof getYouTube>, broadcastId: string): Promise<boolean> {
  return (await broadcastLifeCycle(yt, broadcastId)) === 'live';
}

/** YouTube's own view of the ingest stream, from liveStreams.status. */
export interface YouTubeStreamHealth {
  /** status.streamStatus: active | created | ready | inactive | error. */
  streamStatus: string | null;
  /** status.healthStatus.status: good | ok | bad | noData. */
  health: string | null;
  /** Configuration issues at warning/error severity — e.g. videoBitrateLow, noAudioStream. */
  issues: { type: string; severity: string; reason: string }[];
  /** True when YouTube says it is receiving data. */
  receiving: boolean;
  /** Set when the probe failed (e.g. a dead token); health is then unknown, not bad. */
  error: string | null;
}

/**
 * Ask YouTube what it thinks of our ingest. `healthStatus.configurationIssues` is where YouTube
 * reports exactly the complaint the Live Control Room shows an operator — including
 * `videoBitrateLow`, the warning seen on 2026-08-05 — so we can surface it live instead of the
 * operator discovering it in YouTube Studio.
 *
 * Ref: https://developers.google.com/youtube/v3/live/docs/liveStreams (status.streamStatus,
 * status.healthStatus.status, status.healthStatus.configurationIssues).
 */
export async function getYouTubeStreamHealth(streamId: string): Promise<YouTubeStreamHealth> {
  try {
    const yt = getYouTube();
    const res = await yt.liveStreams.list({ id: [streamId], part: ['status'] });
    const status = res.data.items?.[0]?.status;
    const streamStatus = status?.streamStatus ?? null;
    return {
      streamStatus,
      health: status?.healthStatus?.status ?? null,
      issues: (status?.healthStatus?.configurationIssues ?? [])
        .filter((i) => i.severity === 'warning' || i.severity === 'error')
        .map((i) => ({ type: i.type ?? '', severity: i.severity ?? '', reason: i.reason ?? '' })),
      receiving: streamStatus === 'active',
      error: null,
    };
  } catch (err) {
    return {
      streamStatus: null, health: null, issues: [], receiving: false,
      error: err instanceof Error ? err.message : String(err),
    };
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
 * Set (or replace) a broadcast's custom thumbnail from an app-relative upload path
 * (e.g. `/uploads/abc123`). Throws on failure so editing callers can surface it — the create path
 * wraps it in its own best-effort catch.
 */
export async function setYouTubeThumbnail(broadcastId: string, thumbnailPath: string): Promise<void> {
  const yt = getYouTube();
  const body = readFileSync(join(__dirname, '..', '..', thumbnailPath));
  await yt.thumbnails.set({ videoId: broadcastId, media: { body } });
}

/**
 * Delete/cancel a YouTube broadcast.
 */
export async function deleteYouTubeBroadcast(broadcastId: string): Promise<void> {
  const yt = getYouTube();
  await yt.liveBroadcasts.delete({ id: broadcastId });
}
