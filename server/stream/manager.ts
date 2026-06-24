import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import { getYouTubeAuth } from '../auth/youtube.js';
import { getFacebookPageToken, getFacebookPageUrl } from '../auth/facebook.js';
import { getTwitchCredentials } from '../auth/twitch.js';
import { createYouTubeBroadcast, transitionToLive, endYouTubeBroadcast } from '../platforms/youtube.js';
import { createFacebookLiveVideo, endFacebookLiveVideo, publishFacebookLiveVideo, createScheduledPagePost, createPagePost, deletePagePost, resolveFacebookVideoId } from '../platforms/facebook.js';
import { updateTwitchChannel, getTwitchStreamKey, getTwitchVodUrl } from '../platforms/twitch.js';
import { getReminderSettings, computeReminderTime, renderReminder } from './reminders.js';
import type { Stream, PlatformStream, Platform } from '../types.js';

function logEvent(streamId: string | null, platform: string | null, event: string, detail?: string) {
  const db = getDb();
  db.prepare('INSERT INTO event_log (stream_id, platform, event, detail, ts) VALUES (?, ?, ?, ?, ?)').run(
    streamId, platform, event, detail ?? null, Date.now(),
  );
}

/**
 * Public URL for a Facebook video / VOD: {page}/videos/{id} (e.g. facebook.com/rosarymen/videos/123),
 * or the watch URL when the Page URL is unknown. IMPORTANT: `videoId` must be the underlying *video*
 * object id (from resolveFacebookVideoId), NOT the live-video id — the latter is not a valid
 * /videos/ permalink and renders "This content isn't available right now".
 */
function facebookVideoUrl(pageUrl: string | null, videoId: string): string {
  return pageUrl ? `${pageUrl}/videos/${videoId}` : `https://www.facebook.com/watch/live/?v=${videoId}`;
}

/** A scheduled announcement: the Facebook post id plus its publish time (unix seconds). */
interface ScheduledPost { id: string; time: number; }

/** Scheduled Facebook announcements stashed in a platform_stream's extra_json. */
function facebookAnnouncementPosts(extraJson: string | null | undefined): ScheduledPost[] {
  if (!extraJson) return [];
  try {
    const posts = (JSON.parse(extraJson) as { announcement_posts?: ScheduledPost[] }).announcement_posts;
    return Array.isArray(posts) ? posts : [];
  } catch {
    return [];
  }
}

/**
 * Schedule Facebook announcement posts for an upcoming stream per the reminder schedule.
 * Honors the global enable, the per-stream toggle, and Facebook's posting window. Best-effort:
 * individual failures are logged but never block setup. Returns the created posts (id + time).
 */
async function scheduleFacebookReminders(stream: Stream): Promise<ScheduledPost[]> {
  if (!stream.scheduled_start || !stream.fb_reminders_enabled) return [];

  const settings = getReminderSettings();
  if (!settings.enabled) return [];

  // {page} links to the Facebook Page (where the live video surfaces once live) — the live
  // video itself doesn't exist until go-live, so an advance post can't link to it directly.
  const pageUrl = (await getFacebookPageUrl()) ?? settings.site;

  const now = Math.floor(Date.now() / 1000);
  const minLead = 10 * 60;             // Facebook requires ≥ ~10 min ahead
  const maxLead = 180 * 24 * 60 * 60;  // ...and ≤ ~6 months

  const posts: ScheduledPost[] = [];
  for (const rule of settings.rules) {
    if (!rule.enabled) continue;
    const when = computeReminderTime(rule, stream.scheduled_start, settings.timezone);
    if (when == null) continue;
    if (when < now + minLead || when > now + maxLead) {
      logEvent(stream.id, 'facebook', 'announcement_skipped', `${rule.label}: outside Facebook's posting window`);
      continue;
    }
    try {
      const postId = await createScheduledPagePost(renderReminder(rule.template, stream, settings, pageUrl), when);
      posts.push({ id: postId, time: when });
      logEvent(stream.id, 'facebook', 'announcement_scheduled', `${rule.label} → post ${postId}`);
    } catch (err) {
      logEvent(stream.id, 'facebook', 'announcement_error', `${rule.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return posts;
}

/**
 * Re-sync a stream's Facebook announcement posts after an edit (time/title/description/toggle).
 * Deletes the still-pending posts and recreates them from the current details; posts that have
 * already published are left alone (can't un-send what people have seen). No-op until setup.
 */
export async function resyncFacebookReminders(streamId: string): Promise<void> {
  const db = getDb();
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(streamId) as Stream | undefined;
  if (!stream) return;
  const fbPs = db.prepare("SELECT * FROM platform_streams WHERE stream_id = ? AND platform = 'facebook'").get(streamId) as PlatformStream | undefined;
  if (!fbPs || fbPs.status !== 'created') return; // not set up yet — nothing scheduled to sync

  const now = Math.floor(Date.now() / 1000);
  const existing = facebookAnnouncementPosts(fbPs.extra_json);
  const published = existing.filter((p) => p.time <= now);
  const pending = existing.filter((p) => p.time > now);

  for (const p of pending) {
    try { await deletePagePost(p.id); } catch { /* best-effort */ }
  }

  const fresh = await scheduleFacebookReminders(stream);
  const all = [...published, ...fresh];
  db.prepare('UPDATE platform_streams SET extra_json = ? WHERE id = ?')
    .run(all.length ? JSON.stringify({ announcement_posts: all }) : null, fbPs.id);
  logEvent(streamId, 'facebook', 'announcements_resynced', `${pending.length} replaced, ${fresh.length} pending`);
}

/**
 * Publish the "we're live now" post once the broadcast is actually LIVE — this is the one post
 * that can link to the real video ({video}), since the video only exists at go-live. Honors the
 * global enable, the go-live sub-toggle, and the per-stream toggle. Best-effort.
 */
async function postGoLiveAnnouncement(stream: Stream, broadcastId: string): Promise<void> {
  if (!stream.fb_reminders_enabled) return;
  const settings = getReminderSettings();
  if (!settings.enabled || !settings.goLivePost?.enabled) return;

  const fbPageUrl = await getFacebookPageUrl();
  const pageUrl = fbPageUrl ?? settings.site;
  // broadcastId is the live-video id, which is NOT the id in the public /videos/{id} permalink.
  // Resolve the real video id and build a {page}/videos/{id} link; if that lookup ever fails, fall
  // back to the Page URL (always valid — the live surfaces there) rather than a dead video link.
  const videoId = await resolveFacebookVideoId(broadcastId);
  const videoUrl = videoId ? facebookVideoUrl(fbPageUrl, videoId) : pageUrl;

  try {
    const postId = await createPagePost(renderReminder(settings.goLivePost.template, stream, settings, pageUrl, videoUrl));
    logEvent(stream.id, 'facebook', 'golive_post', `Post ${postId}`);
  } catch (err) {
    logEvent(stream.id, 'facebook', 'golive_post_error', err instanceof Error ? err.message : String(err));
  }
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
        // Facebook's API can neither create Events nor schedule live videos (both
        // deprecated/partner-gated — verified against the live API). So for advance visibility we
        // schedule announcement POSTS per the reminder schedule, and the live video itself is
        // created at go-live (see goLive). This row represents that live video — created deferred
        // here (status 'created', no broadcast_id) with the announcement post ids in extra_json
        // so they can be cleaned up on retry/delete.
        const psId = existing?.id ?? nanoid();
        const posts = await scheduleFacebookReminders(stream);

        db.prepare(`
          INSERT OR REPLACE INTO platform_streams (id, stream_id, platform, status, error_message, extra_json)
          VALUES (?, ?, 'facebook', 'created', NULL, ?)
        `).run(psId, streamId, posts.length ? JSON.stringify({ announcement_posts: posts }) : null);

        logEvent(streamId, 'facebook', 'setup_success',
          posts.length
            ? `${posts.length} announcement post(s) scheduled — live video will be created at go-live`
            : 'Ready — live video will be created at go-live');

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

  // If retrying Facebook, delete any previously-scheduled announcement posts first so we don't
  // orphan them or end up with duplicates when setup re-creates them.
  if (platform === 'facebook') {
    const existing = db.prepare("SELECT extra_json FROM platform_streams WHERE stream_id = ? AND platform = 'facebook'").get(streamId) as { extra_json: string | null } | undefined;
    for (const post of facebookAnnouncementPosts(existing?.extra_json)) {
      try { await deletePagePost(post.id); } catch { /* best-effort */ }
    }
  }

  // Delete the existing platform_stream
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

  // Facebook: create the live video now if it was deferred (a scheduled stream). FB no longer
  // supports API scheduling and its RTMP URL is short-lived, so the live video can only be
  // created at the moment we actually start streaming. Must run before the fan-out so the
  // freshly-issued rtmp_url is in place when startFanOut reads it.
  const fbDeferred = platformStreams.find((ps) => ps.platform === 'facebook' && !ps.broadcast_id);
  if (fbDeferred) {
    try {
      const fb = await createFacebookLiveVideo(stream.name, stream.description);
      db.prepare("UPDATE platform_streams SET broadcast_id = ?, rtmp_url = ? WHERE id = ?")
        .run(fb.liveVideoId, fb.streamUrl, fbDeferred.id);
      fbDeferred.broadcast_id = fb.liveVideoId;
      fbDeferred.rtmp_url = fb.streamUrl;
      logEvent(streamId, 'facebook', 'setup_success', `Live video ${fb.liveVideoId} created at go-live`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      db.prepare("UPDATE platform_streams SET status = 'error', error_message = ? WHERE id = ?")
        .run(msg, fbDeferred.id);
      // Drop it from this go-live so the fan-out doesn't try to use an empty URL.
      platformStreams.splice(platformStreams.indexOf(fbDeferred), 1);
      logEvent(streamId, 'facebook', 'setup_error', msg);
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
        .then(() => {
          logEvent(streamId, 'facebook', 'published_live');
          // Now that the broadcast is live, post the "we're live now" announcement with its link.
          void postGoLiveAnnouncement(stream, fbId);
        })
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
      // Build the VOD link from the real video id, not the live-video id (see resolveFacebookVideoId).
      const fbVideoId = (await resolveFacebookVideoId(fbPs.broadcast_id)) ?? fbPs.broadcast_id;
      extra.vod_url = facebookVideoUrl(await getFacebookPageUrl(), fbVideoId);
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
