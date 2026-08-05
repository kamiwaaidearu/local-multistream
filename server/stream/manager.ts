import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import { getYouTubeAuth, validateYouTubeAuth, lastYouTubeAuthError } from '../auth/youtube.js';
import { getFacebookPageToken, getFacebookPageUrl, validateFacebookAuth } from '../auth/facebook.js';
import { getTwitchCredentials, validateTwitchAuth } from '../auth/twitch.js';
import { createYouTubeBroadcast, transitionToLive, endYouTubeBroadcast } from '../platforms/youtube.js';
import { createFacebookLiveVideo, endFacebookLiveVideo, publishFacebookLiveVideo, createScheduledPagePost, createPagePost, deletePagePost, resolveFacebookVideoId } from '../platforms/facebook.js';
import { updateTwitchChannel, getTwitchStreamKey, getTwitchVodUrl } from '../platforms/twitch.js';
import { getReminderSettings, computeReminderTime, renderReminder } from './reminders.js';
import { startHealthMonitor, stopHealthMonitor, waitForPlatformReceiving } from './healthMonitor.js';
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

export interface PlatformAuthHealth {
  connected: boolean;
  ok: boolean;
  /** Why it's broken, when the platform told us (e.g. "Token has been expired or revoked."). */
  error?: string | null;
}

/**
 * Thrown by goLive when a connected platform's login is dead. Carries the platform list so the API
 * can return a 409 the UI turns into a confirm-and-override prompt, rather than a dead end: the
 * operator must ALWAYS be able to get on air without the broken platform.
 */
export class AuthPreflightError extends Error {
  constructor(public readonly platforms: string[]) {
    super(
      `These platforms have a broken login and cannot go live: ${platforms.join(', ')}. ` +
      'Reconnect them in Settings, or go live without them.',
    );
    this.name = 'AuthPreflightError';
  }
}

/**
 * Per-platform auth health for every connected platform — powers the go-live pre-check and the
 * live "reconnect" controls. `ok` means the token actually works right now (real refresh /
 * debug_token probe), so an expired YouTube login shows up here instead of silently failing the
 * transition mid-broadcast.
 */
export async function getPlatformAuthHealth(): Promise<Record<Platform, PlatformAuthHealth>> {
  const ytConnected = !!getYouTubeAuth();
  const fbConnected = !!getFacebookPageToken();
  const twConnected = !!getTwitchCredentials();
  const [yt, fb, tw] = await Promise.all([
    ytConnected ? validateYouTubeAuth() : Promise.resolve(false),
    fbConnected ? validateFacebookAuth() : Promise.resolve(false),
    twConnected ? validateTwitchAuth() : Promise.resolve(false),
  ]);
  return {
    youtube: { connected: ytConnected, ok: yt, error: yt ? null : lastYouTubeAuthError() },
    facebook: { connected: fbConnected, ok: fb },
    twitch: { connected: twConnected, ok: tw },
  };
}

/**
 * Retry bringing a single platform live mid-broadcast — e.g. after reconnecting YouTube whose token
 * had expired. Never changes the overall stream status and never touches the other platforms' legs:
 * it (re)starts only this platform's fan-out leg if it died, then re-runs the control-plane
 * transition/publish with the current (possibly just-refreshed) credentials.
 */
export async function retryPlatformLive(streamId: string, platform: Platform): Promise<void> {
  const db = getDb();
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(streamId) as Stream | undefined;
  if (!stream) throw new Error('Stream not found');
  if (stream.status !== 'live') throw new Error('Stream is not live');

  const ps = db.prepare('SELECT * FROM platform_streams WHERE stream_id = ? AND platform = ?')
    .get(streamId, platform) as PlatformStream | undefined;
  if (!ps) throw new Error(`${platform} is not set up for this stream`);

  const { ensurePlatformLeg } = await import('../fanout/ffmpeg.js');

  if (platform === 'youtube') {
    if (!ps.broadcast_id) throw new Error('YouTube broadcast was never created — set it up first');
    ensurePlatformLeg(streamId, ps); // restart the video pipe only if it died; no-op if still running
    const extra = ps.extra_json ? JSON.parse(ps.extra_json) : {};
    await transitionToLive(ps.broadcast_id, extra.stream_id);
    db.prepare("UPDATE platform_streams SET status = 'live', error_message = NULL WHERE id = ?").run(ps.id);
    logEvent(streamId, 'youtube', 'retried_live', `Broadcast ${ps.broadcast_id} transitioned`);
  } else if (platform === 'facebook') {
    // Create the live video now if it was deferred or a prior attempt failed.
    if (!ps.broadcast_id) {
      const fb = await createFacebookLiveVideo(stream.name, stream.description);
      db.prepare('UPDATE platform_streams SET broadcast_id = ?, rtmp_url = ? WHERE id = ?')
        .run(fb.liveVideoId, fb.streamUrl, ps.id);
      ps.broadcast_id = fb.liveVideoId;
      ps.rtmp_url = fb.streamUrl;
      logEvent(streamId, 'facebook', 'setup_success', `Live video ${fb.liveVideoId} created on retry`);
    }
    ensurePlatformLeg(streamId, ps);
    // Facebook only accepts LIVE_NOW once it's receiving the encoder's data — give a freshly
    // (re)started leg a moment to connect before publishing.
    await new Promise((r) => setTimeout(r, 3000));
    await publishFacebookLiveVideo(ps.broadcast_id);
    db.prepare("UPDATE platform_streams SET status = 'live', error_message = NULL WHERE id = ?").run(ps.id);
    logEvent(streamId, 'facebook', 'retried_live', `Live video ${ps.broadcast_id} published`);
  } else {
    // Twitch goes live automatically once RTMP flows; just ensure the leg is up and (re)set title.
    ensurePlatformLeg(streamId, ps);
    await updateTwitchChannel(stream.name);
    db.prepare("UPDATE platform_streams SET status = 'live', error_message = NULL WHERE id = ?").run(ps.id);
    logEvent(streamId, 'twitch', 'retried_live', 'Leg ensured; title set');
  }
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

// Guards against two go-lives running at once. Only one stream can be live at a time, and the
// up-to-15s ingest wait inside goLive widens the window in which two concurrent calls (e.g. two
// admins, or a double-fire) could both pass the single-live guard and double-start the fan-out.
// A single server process, so an in-memory flag is sufficient; the check-and-set below is atomic
// (no await between them).
let goLiveInFlight = false;

/**
 * Go live — start FFmpeg fan-out and transition YouTube.
 */
export async function goLive(streamId: string, opts: { force?: boolean } = {}): Promise<void> {
  const db = getDb();
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(streamId) as Stream | undefined;
  if (!stream) throw new Error('Stream not found');
  if (stream.status !== 'ready') throw new Error('Stream must be in ready status');

  if (goLiveInFlight) throw new Error('A go-live is already in progress. Please wait a moment and try again.');
  goLiveInFlight = true;
  try {
    // Concurrent stream guard
    const liveStream = db.prepare("SELECT id FROM streams WHERE status = 'live'").get() as { id: string } | undefined;
    if (liveStream) throw new Error('Another stream is already live. End it first.');

    const platformStreams = db.prepare("SELECT * FROM platform_streams WHERE stream_id = ? AND status = 'created'").all(streamId) as unknown as PlatformStream[];
    if (platformStreams.length === 0) throw new Error('No platforms are set up');

    // Auth pre-flight. A connected platform with a dead grant does not fail loudly — it goes live on
    // paper and silently does nothing, which is how the 2026-08-05 YouTube leg was lost. Stopping here
    // gives the operator the chance to reconnect BEFORE the broadcast starts.
    //
    // This is a speed bump, never a wall: `force` always gets through, so a broken platform (or a
    // broken health probe) can never prevent going live on the platforms that do work.
    if (!opts.force) {
      const health = await getPlatformAuthHealth();
      const broken = Object.entries(health).filter(([, v]) => v.connected && !v.ok).map(([p]) => p);
      if (broken.length > 0) throw new AuthPreflightError(broken);
    }

    // Verify an ingest source is present. Without this we'd mark the stream "live" while nothing
    // flows — the fan-out would retry then give up, and YouTube would time out after 2 minutes.
    // isRtmpPublishing() covers OBS (and a fully-warmed Studio ingest); isStudioConnected() covers
    // a Studio WebSocket whose ingest FFmpeg may still be establishing its RTMP publish.
    const { isRtmpPublishing } = await import('../rtmp/server.js');
    const { isStudioConnected } = await import('../studio/ingest.js');
    if (!isRtmpPublishing() && !isStudioConnected()) {
      throw new Error('No video source is connected. Start OBS or the Web Studio before going live.');
    }

    // Web Studio's WebSocket opens seconds before its ingest FFmpeg has actually published to the
    // local RTMP server (spawn + webm probe + encode + RTMP handshake). If we started the fan-out on
    // the WebSocket alone, every relay leg would fire into an empty input and burn its retry budget
    // before the encoder is ready — the burst of "exited (code ...) — reconnecting" we used to see
    // at go-live. So when Studio is connected but not yet publishing, wait for the publish first.
    // OBS always publishes before the operator can click Go Live, so this is effectively Studio-only.
    if (!isRtmpPublishing() && isStudioConnected()) {
      const { waitForCondition } = await import('./waitForCondition.js');
      const published = await waitForCondition(() => isRtmpPublishing(), { timeoutMs: 15000, intervalMs: 500 });
      if (!published) {
        throw new Error('The Web Studio is connected but no video has started flowing yet. Give it a moment and try Go Live again.');
      }
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
      void transitionYouTubeWithRetry(streamId, ytPs, extra.stream_id);
    }

    // Facebook: an UNPUBLISHED live video must be explicitly transitioned to LIVE_NOW —
    // streaming RTMP alone leaves it in preview, never visible on the Page. (The fan-out
    // process sets the DB status to 'live'; this call is what actually publishes it.)
    const fbPs = platformStreams.find((ps) => ps.platform === 'facebook');
    if (fbPs?.broadcast_id) {
      void publishFacebookOnceReceiving(streamId, stream, fbPs);
    }

    // Twitch goes live automatically when RTMP connects; the fan-out marks it 'live'.

    // Watch every platform's OWN view of the ingest for the rest of the broadcast. Our FFmpeg
    // staying alive is not evidence the platform is receiving anything — see healthMonitor.
    startHealthMonitor(streamId);
  } finally {
    goLiveInFlight = false;
  }
}

/**
 * Drive the YouTube go-live transition, retrying transient failures.
 *
 * Since createYouTubeBroadcast sets enableAutoStart, YouTube takes the broadcast live on its own the
 * moment our RTMP arrives — so this failing no longer means the broadcast failed. That's why an
 * exhausted retry records a *warning* on the row rather than marking the leg broken: on 2026-08-05
 * an invalid_grant here left the operator believing YouTube was down when, with autostart, it would
 * have been live. The health monitor reports whether YouTube is genuinely receiving video.
 */
async function transitionYouTubeWithRetry(streamId: string, ytPs: PlatformStream, ytStreamId: string): Promise<void> {
  const db = getDb();
  const ATTEMPTS = 3;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      await transitionToLive(ytPs.broadcast_id!, ytStreamId);
      db.prepare("UPDATE platform_streams SET status = 'live', error_message = NULL WHERE id = ?").run(ytPs.id);
      logEvent(streamId, 'youtube', 'transitioned_live', attempt > 1 ? `Succeeded on attempt ${attempt}` : undefined);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[manager] YouTube transition failed (attempt ${attempt}/${ATTEMPTS}):`, err);
      logEvent(streamId, 'youtube', 'transition_error', `Attempt ${attempt}/${ATTEMPTS}: ${msg}`);

      if (attempt === ATTEMPTS) {
        db.prepare("UPDATE platform_streams SET error_message = ? WHERE id = ?").run(
          `Could not confirm the go-live transition (${msg}). Autostart should have taken the broadcast live anyway — check the health panel.`,
          ytPs.id,
        );
        return;
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

/**
 * Publish the Facebook live video — but only once Facebook confirms it is actually receiving video,
 * and only announce it publicly if that confirmation arrived.
 *
 * This replaces a blind `setTimeout(publish, 4000)`. That timer assumed FB would reject LIVE_NOW
 * unless data was flowing; it doesn't. On 2026-08-05 the publish returned 200 for a stream FB never
 * ingested, we posted the announcement 3 seconds later, and followers got a link to a 0:00 video.
 *
 * On timeout we still publish — going live is what the operator asked for, and a broken health probe
 * must never be the reason we stay dark — but we suppress the announcement and record it loudly, so
 * the worst case is a quiet broken stream rather than a publicly advertised one.
 */
async function publishFacebookOnceReceiving(streamId: string, stream: Stream, fbPs: PlatformStream): Promise<void> {
  const fbId = fbPs.broadcast_id!;

  // The ingest is live as soon as the fan-out pushes RTMP; LIVE_NOW only controls visibility. So
  // stream_health is readable while the video is still UNPUBLISHED, which is what makes this order
  // (confirm ingest → publish → announce) possible.
  const { receiving, detail } = await waitForPlatformReceiving(fbPs, { timeoutMs: 45_000 });
  const bitrate = detail.videoKbps != null ? `${detail.videoKbps} kbps` : 'bitrate unknown';

  if (receiving) {
    logEvent(streamId, 'facebook', 'ingest_confirmed', `Facebook is receiving video (${bitrate})`);
  } else {
    console.error('[manager] Facebook never confirmed it was receiving video — publishing without announcing');
    logEvent(streamId, 'facebook', 'ingest_unconfirmed',
      'Facebook did not report an incoming stream within 45s — publishing anyway, suppressing the announcement post');
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await publishFacebookLiveVideo(fbId);
      logEvent(streamId, 'facebook', receiving ? 'published_live' : 'published_live_unconfirmed');
      // Only tell the world when Facebook told US it has the video.
      if (receiving) void postGoLiveAnnouncement(stream, fbId);
      return;
    } catch (err) {
      if (attempt === 2) {
        console.error('[manager] Facebook publish failed:', err);
        logEvent(streamId, 'facebook', 'publish_error', String(err));
        return;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/**
 * End stream — kill FFmpeg, end broadcasts, fetch VOD links.
 */
export async function endStream(streamId: string): Promise<void> {
  const db = getDb();
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(streamId) as Stream | undefined;
  if (!stream) throw new Error('Stream not found');
  if (stream.status !== 'live') throw new Error('Stream is not live');

  stopHealthMonitor(streamId);

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
      // Our side of the broadcast IS over regardless of whether YouTube accepted the call, so the
      // row must not stay 'live'. Leaving it live is how two rows (2026-07-01 and 2026-08-05, both
      // invalid_grant days) ended up permanently stuck: the parent stream was correctly marked
      // 'ended', which put them out of reach of reconcileLiveStreams.
      db.prepare("UPDATE platform_streams SET status = 'ended', error_message = ? WHERE id = ?")
        .run(`Ended locally, but YouTube's end call failed: ${err instanceof Error ? err.message : String(err)}`, ytPs.id);
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
      db.prepare("UPDATE platform_streams SET status = 'ended', error_message = ? WHERE id = ?")
        .run(`Ended locally, but Facebook's end call failed: ${err instanceof Error ? err.message : String(err)}`, fbPs.id);
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

  // Orphaned platform legs: rows still 'live'/'reconnecting' whose parent stream has already ended.
  // The loop above can't see these — it starts from streams that are still 'live', and the whole
  // point of this case is that the stream ended correctly while one platform's row did not (an end
  // API call that threw). Sweep them separately so the UI never shows a finished broadcast as live.
  const orphaned = db.prepare(`
    UPDATE platform_streams SET status = 'ended'
    WHERE status IN ('live', 'reconnecting')
      AND stream_id IN (SELECT id FROM streams WHERE status != 'live')
  `).run();
  if (orphaned.changes > 0) {
    console.log(`[manager] Reconciled ${orphaned.changes} orphaned platform leg(s) left 'live' under an ended stream`);
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
