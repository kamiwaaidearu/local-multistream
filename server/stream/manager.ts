import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import { getYouTubeAuth } from '../auth/youtube.js';
import { getFacebookPageToken } from '../auth/facebook.js';
import { getTwitchCredentials } from '../auth/twitch.js';
import { createYouTubeBroadcast, transitionToLive, endYouTubeBroadcast } from '../platforms/youtube.js';
import { createFacebookLiveVideo, endFacebookLiveVideo, publishFacebookLiveVideo } from '../platforms/facebook.js';
import { updateTwitchChannel, getTwitchStreamKey, getTwitchVodUrl } from '../platforms/twitch.js';
import type { Stream, PlatformStream, Platform } from '../types.js';

function logEvent(streamId: string | null, platform: string | null, event: string, detail?: string) {
  const db = getDb();
  db.prepare('INSERT INTO event_log (stream_id, platform, event, detail, ts) VALUES (?, ?, ?, ?, ?)').run(
    streamId, platform, event, detail ?? null, Date.now(),
  );
}

function getEnabledPlatforms(): Platform[] {
  const platforms: Platform[] = [];
  if (getYouTubeAuth()) platforms.push('youtube');
  if (getFacebookPageToken()) platforms.push('facebook');
  if (getTwitchCredentials()) platforms.push('twitch');
  return platforms;
}

/**
 * Setup platforms for a single stream — creates broadcasts on each connected platform.
 */
export async function setupStream(streamId: string): Promise<{ results: Record<string, { success: boolean; error?: string }> }> {
  const db = getDb();
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(streamId) as Stream | undefined;
  if (!stream) throw new Error('Stream not found');
  if (stream.status !== 'draft' && stream.status !== 'ready') {
    throw new Error('Can only setup draft or ready streams');
  }

  const platforms = getEnabledPlatforms();
  if (platforms.length === 0) throw new Error('No platforms connected. Go to Settings first.');

  const results: Record<string, { success: boolean; error?: string }> = {};
  let anySuccess = false;

  for (const platform of platforms) {
    // Skip if already set up
    const existing = db.prepare('SELECT * FROM platform_streams WHERE stream_id = ? AND platform = ?').get(streamId, platform) as PlatformStream | undefined;
    if (existing?.status === 'created') {
      results[platform] = { success: true };
      anySuccess = true;
      continue;
    }

    try {
      if (platform === 'youtube') {
        const yt = await createYouTubeBroadcast(
          stream.name,
          stream.description,
          stream.scheduled_start,
          stream.thumbnail_path,
        );

        const psId = existing?.id ?? nanoid();
        db.prepare(`
          INSERT OR REPLACE INTO platform_streams (id, stream_id, platform, broadcast_id, stream_key, rtmp_url, status, error_message, extra_json)
          VALUES (?, ?, 'youtube', ?, ?, ?, 'created', NULL, ?)
        `).run(psId, streamId, yt.broadcastId, yt.streamKey, yt.rtmpUrl, JSON.stringify({ stream_id: yt.streamId }));

        logEvent(streamId, 'youtube', 'setup_success', `Broadcast ${yt.broadcastId} created`);

      } else if (platform === 'facebook') {
        // Facebook: only create if within 7 days or no scheduled time
        const now = Math.floor(Date.now() / 1000);
        const sevenDays = 7 * 24 * 60 * 60;
        if (stream.scheduled_start && stream.scheduled_start - now > sevenDays) {
          // Too far out, mark as pending
          const psId = existing?.id ?? nanoid();
          db.prepare(`
            INSERT OR REPLACE INTO platform_streams (id, stream_id, platform, status, error_message)
            VALUES (?, ?, 'facebook', 'pending', 'Scheduled more than 7 days out — will auto-create closer to date')
          `).run(psId, streamId);
          results[platform] = { success: true };
          anySuccess = true;
          continue;
        }

        const fb = await createFacebookLiveVideo(
          stream.name,
          stream.description,
          stream.scheduled_start,
        );

        const psId = existing?.id ?? nanoid();
        db.prepare(`
          INSERT OR REPLACE INTO platform_streams (id, stream_id, platform, broadcast_id, rtmp_url, status, error_message)
          VALUES (?, ?, 'facebook', ?, ?, 'created', NULL)
        `).run(psId, streamId, fb.liveVideoId, fb.streamUrl);

        logEvent(streamId, 'facebook', 'setup_success', `Live video ${fb.liveVideoId} created`);

      } else if (platform === 'twitch') {
        const key = await getTwitchStreamKey();
        const psId = existing?.id ?? nanoid();
        db.prepare(`
          INSERT OR REPLACE INTO platform_streams (id, stream_id, platform, stream_key, rtmp_url, status, error_message)
          VALUES (?, ?, 'twitch', ?, 'rtmp://live.twitch.tv/app', 'created', NULL)
        `).run(psId, streamId, key);

        logEvent(streamId, 'twitch', 'setup_success', 'Stream key fetched, title will be set at go-live');
      }

      results[platform] = { success: true };
      anySuccess = true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      results[platform] = { success: false, error: errorMsg };

      const psId = existing?.id ?? nanoid();
      db.prepare(`
        INSERT OR REPLACE INTO platform_streams (id, stream_id, platform, status, error_message)
        VALUES (?, ?, ?, 'error', ?)
      `).run(psId, streamId, platform, errorMsg);

      logEvent(streamId, platform, 'setup_error', errorMsg);
    }
  }

  // Update stream status
  if (anySuccess) {
    db.prepare('UPDATE streams SET status = ? WHERE id = ?').run('ready', streamId);
  }

  return { results };
}

/**
 * Setup a single platform for a stream (retry).
 */
export async function setupSinglePlatform(streamId: string, platform: Platform): Promise<void> {
  const db = getDb();

  // Delete the existing failed platform_stream
  db.prepare('DELETE FROM platform_streams WHERE stream_id = ? AND platform = ?').run(streamId, platform);

  // Re-run setup (setupStream handles individual platforms)
  await setupStream(streamId);
}

/**
 * Go live — start FFmpeg fan-out and transition YouTube.
 */
export async function goLive(streamId: string): Promise<void> {
  const db = getDb();
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(streamId) as Stream | undefined;
  if (!stream) throw new Error('Stream not found');
  if (stream.status !== 'ready') throw new Error('Stream must be in ready status');

  // Concurrent stream guard
  const liveStream = db.prepare("SELECT id FROM streams WHERE status = 'live'").get() as { id: string } | undefined;
  if (liveStream) throw new Error('Another stream is already live. End it first.');

  const platformStreams = db.prepare("SELECT * FROM platform_streams WHERE stream_id = ? AND status = 'created'").all(streamId) as unknown as PlatformStream[];
  if (platformStreams.length === 0) throw new Error('No platforms are set up');

  // Verify an ingest source is actually publishing. Without this we'd mark the stream
  // "live" while nothing flows — the fan-out would retry then give up, and YouTube would
  // time out after 2 minutes.
  const { isObsConnected } = await import('../rtmp/server.js');
  const { isStudioConnected } = await import('../studio/ingest.js');
  if (!isObsConnected() && !isStudioConnected()) {
    throw new Error('No video source is connected. Start OBS or the Web Studio before going live.');
  }

  // Update Twitch title at go-live time
  const twitchPs = platformStreams.find((ps) => ps.platform === 'twitch');
  if (twitchPs) {
    try {
      await updateTwitchChannel(stream.name);
      logEvent(streamId, 'twitch', 'title_updated', stream.name);
    } catch (err) {
      console.warn('[manager] Twitch title update failed:', err);
    }
  }

  // Mark stream as live
  db.prepare('UPDATE streams SET status = ?, started_at = ? WHERE id = ?').run('live', Date.now(), streamId);
  logEvent(streamId, null, 'go_live', `Starting fan-out to ${platformStreams.length} platforms`);

  // Start FFmpeg fan-out (imported dynamically to avoid circular deps)
  const { startFanOut } = await import('../fanout/ffmpeg.js');
  startFanOut(streamId, platformStreams);

  // YouTube transition (async — don't block the response)
  const ytPs = platformStreams.find((ps) => ps.platform === 'youtube');
  if (ytPs?.broadcast_id) {
    const extra = ytPs.extra_json ? JSON.parse(ytPs.extra_json) : {};
    transitionToLive(ytPs.broadcast_id, extra.stream_id).then(() => {
      db.prepare("UPDATE platform_streams SET status = 'live' WHERE id = ?").run(ytPs.id);
      logEvent(streamId, 'youtube', 'transitioned_live');
    }).catch((err) => {
      console.error('[manager] YouTube transition failed:', err);
      logEvent(streamId, 'youtube', 'transition_error', String(err));
    });
  }

  // Facebook: an UNPUBLISHED live video must be explicitly transitioned to LIVE_NOW —
  // streaming RTMP alone leaves it in preview, never visible on the Page. (The fan-out
  // process sets the DB status to 'live'; this call is what actually publishes it.)
  const fbPs = platformStreams.find((ps) => ps.platform === 'facebook');
  if (fbPs?.broadcast_id) {
    const fbId = fbPs.broadcast_id;
    // FB only accepts the LIVE_NOW transition once it's receiving the encoder's data, so
    // wait a few seconds for the fan-out to connect, and retry a couple of times in case
    // the ingest connection is slow to establish.
    const publishFb = (attempt = 0): void => {
      publishFacebookLiveVideo(fbId)
        .then(() => logEvent(streamId, 'facebook', 'published_live'))
        .catch((err) => {
          if (attempt < 2) {
            setTimeout(() => publishFb(attempt + 1), 5000);
          } else {
            console.error('[manager] Facebook publish failed:', err);
            logEvent(streamId, 'facebook', 'publish_error', String(err));
          }
        });
    };
    setTimeout(() => publishFb(), 4000);
  }

  // Twitch goes live automatically when RTMP connects; the fan-out marks it 'live'.
}

/**
 * End stream — kill FFmpeg, end broadcasts, fetch VOD links.
 */
export async function endStream(streamId: string): Promise<void> {
  const db = getDb();
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(streamId) as Stream | undefined;
  if (!stream) throw new Error('Stream not found');
  if (stream.status !== 'live') throw new Error('Stream is not live');

  // Stop FFmpeg
  const { stopFanOut } = await import('../fanout/ffmpeg.js');
  await stopFanOut(streamId);

  const platformStreams = db.prepare('SELECT * FROM platform_streams WHERE stream_id = ?').all(streamId) as unknown as PlatformStream[];

  // End YouTube broadcast
  const ytPs = platformStreams.find((ps) => ps.platform === 'youtube');
  if (ytPs?.broadcast_id) {
    try {
      await endYouTubeBroadcast(ytPs.broadcast_id);
      const vodUrl = `https://youtube.com/watch?v=${ytPs.broadcast_id}`;
      const extra = ytPs.extra_json ? JSON.parse(ytPs.extra_json) : {};
      extra.vod_url = vodUrl;
      db.prepare("UPDATE platform_streams SET status = 'ended', extra_json = ? WHERE id = ?").run(JSON.stringify(extra), ytPs.id);
      logEvent(streamId, 'youtube', 'broadcast_ended');
    } catch (err) {
      console.error('[manager] YouTube end failed:', err);
      logEvent(streamId, 'youtube', 'end_error', String(err));
    }
  }

  // End Facebook live video
  const fbPs = platformStreams.find((ps) => ps.platform === 'facebook');
  if (fbPs?.broadcast_id) {
    try {
      await endFacebookLiveVideo(fbPs.broadcast_id);
      const extra = fbPs.extra_json ? JSON.parse(fbPs.extra_json) : {};
      extra.vod_url = `https://www.facebook.com/watch/live/?v=${fbPs.broadcast_id}`;
      db.prepare("UPDATE platform_streams SET status = 'ended', extra_json = ? WHERE id = ?").run(JSON.stringify(extra), fbPs.id);
      logEvent(streamId, 'facebook', 'live_ended');
    } catch (err) {
      console.error('[manager] Facebook end failed:', err);
      logEvent(streamId, 'facebook', 'end_error', String(err));
    }
  }

  // Twitch: mark ended now; fetch the VOD URL in the background. Twitch needs time to
  // publish the archive, so blocking the End Stream response on it just makes the UI hang.
  const twitchPs = platformStreams.find((ps) => ps.platform === 'twitch');
  if (twitchPs) {
    db.prepare("UPDATE platform_streams SET status = 'ended' WHERE id = ?").run(twitchPs.id);
    logEvent(streamId, 'twitch', 'stream_ended');
    setTimeout(() => {
      getTwitchVodUrl().then((vodUrl) => {
        if (!vodUrl) return;
        const row = db.prepare('SELECT extra_json FROM platform_streams WHERE id = ?').get(twitchPs.id) as { extra_json: string | null } | undefined;
        const extra = row?.extra_json ? JSON.parse(row.extra_json) : {};
        extra.vod_url = vodUrl;
        db.prepare("UPDATE platform_streams SET extra_json = ? WHERE id = ?").run(JSON.stringify(extra), twitchPs.id);
        logEvent(streamId, 'twitch', 'vod_ready', vodUrl);
      }).catch((err) => console.error('[manager] Twitch VOD fetch failed:', err));
    }, 10000);
  }

  // Mark stream as ended
  db.prepare('UPDATE streams SET status = ?, ended_at = ? WHERE id = ?').run('ended', Date.now(), streamId);
  logEvent(streamId, null, 'stream_ended');
}

/**
 * Reconcile streams stuck in 'live' on startup. No FFmpeg survives a process restart,
 * so a 'live' row after boot is stale (a crash/restart mid-stream). Left alone it would
 * block every future go-live via the concurrent-stream guard.
 */
export function reconcileLiveStreams(): void {
  const db = getDb();
  const live = db.prepare("SELECT id FROM streams WHERE status = 'live'").all() as Array<{ id: string }>;
  for (const s of live) {
    db.prepare('UPDATE streams SET status = ?, ended_at = ? WHERE id = ?').run('ended', Date.now(), s.id);
    db.prepare("UPDATE platform_streams SET status = 'ended' WHERE stream_id = ? AND status IN ('live', 'reconnecting')").run(s.id);
    logEvent(s.id, null, 'reconciled_after_restart', 'Stream was live at shutdown; marked ended on startup');
  }
  if (live.length > 0) {
    console.log(`[manager] Reconciled ${live.length} stream(s) stuck in 'live' after restart`);
  }
}

/**
 * Best-effort: gracefully end any live streams during server shutdown, so platform
 * broadcasts aren't left dangling and FFmpeg is stopped cleanly.
 */
export async function endLiveStreamsForShutdown(): Promise<void> {
  const db = getDb();
  const live = db.prepare("SELECT id FROM streams WHERE status = 'live'").all() as Array<{ id: string }>;
  for (const s of live) {
    try {
      await endStream(s.id);
    } catch (err) {
      console.error('[manager] Failed to end stream during shutdown:', err);
    }
  }
}
