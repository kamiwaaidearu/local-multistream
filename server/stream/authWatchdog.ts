import { getDb } from '../db/index.js';
import { getPlatformAuthHealth } from './manager.js';
import { lastYouTubeAuthError } from '../auth/youtube.js';
import { sendAlert, clearAlert } from '../alerts.js';
import type { Platform } from '../types.js';

// Proactive platform-auth watchdog.
//
// The 2026-08-05 failure was not that a token expired — tokens expire routinely and refresh fine. It
// was that NOTHING touched the YouTube grant between 12:05Z and the 16:31Z go-live, so a revocation
// that happened in that window was discovered at the single worst moment, with the broadcast starting
// and no time to reconnect.
//
// This closes that window: every platform's auth is exercised for real on a schedule, so a dead grant
// becomes a warning hours ahead instead of a failed go-live. It only ever REPORTS — it never blocks
// anything and never touches a live stream, because nothing here should be able to interfere with a
// broadcast in progress.

/** How often to exercise every platform's credentials. Ten minutes bounds the discovery window
 *  comfortably inside the gap between setting up a stream and going live. */
const CHECK_INTERVAL_MS = 10 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
/** Last known health per platform, so we only log and shout on CHANGES. */
const lastOk = new Map<Platform, boolean>();

function logEvent(platform: string, event: string, detail: string): void {
  getDb().prepare('INSERT INTO event_log (stream_id, platform, event, detail, ts) VALUES (?, ?, ?, ?, ?)')
    .run(null, platform, event, detail, Date.now());
}

async function check(): Promise<void> {
  const health = await getPlatformAuthHealth();

  for (const [platform, state] of Object.entries(health) as [Platform, { connected: boolean; ok: boolean }][]) {
    if (!state.connected) {
      lastOk.delete(platform);
      continue;
    }

    const previous = lastOk.get(platform);
    lastOk.set(platform, state.ok);
    if (previous === state.ok) continue; // no change — stay quiet

    if (state.ok) {
      if (previous === false) {
        console.log(`[authwatch] ${platform} login is working again`);
        logEvent(platform, 'auth_recovered', 'Credentials are valid again');
        clearAlert('auth_broken', platform);
      }
      continue;
    }

    const why = platform === 'youtube' ? lastYouTubeAuthError() : null;
    const detail = why
      ? `${platform} login is broken: ${why}`
      : `${platform} login is broken — reconnect it in Settings`;
    // Loud on purpose. This is the warning that, had it existed, would have given hours of notice.
    console.error(`[authwatch] ${detail}`);
    logEvent(platform, 'auth_broken', detail);
    // And loud somewhere the operator will actually see it before the next broadcast — go-live is now
    // BLOCKED on this, so learning about it at 12:30 would still ruin the stream.
    sendAlert('auth_broken', platform, `${detail}. Go-live will be blocked until it's reconnected.`);
  }
}

/** Start the periodic auth check. Runs one immediately so a broken login is known at boot. */
export function startAuthWatchdog(): void {
  if (timer) return;
  const run = () => void check().catch((err) => {
    console.warn('[authwatch] Auth check failed:', err instanceof Error ? err.message : err);
  });
  run();
  timer = setInterval(run, CHECK_INTERVAL_MS);
  console.log(`[authwatch] Checking platform logins every ${CHECK_INTERVAL_MS / 60000} minutes`);
}

export function stopAuthWatchdog(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
