import { config } from './config.js';
import { httpTimeout } from './httpTimeout.js';

// Out-of-band alerting.
//
// Everything else this app reports lands in the browser UI — which belongs to the person leading the
// rosary on camera. They cannot be watching it. So an in-UI alarm about a dead Facebook ingest or a
// silent microphone reaches nobody until the broadcast is over, which is exactly what happened on
// 2026-08-05. This module pushes the handful of genuinely urgent events somewhere a *different* human
// can see them.
//
// Deliberately a generic webhook rather than an integration: one URL works with Slack, Discord, ntfy,
// Zapier, Home Assistant, or a self-hosted endpoint, and needs no credentials beyond the URL itself.
// The body carries `text` (Slack), `content` (Discord) and structured fields, so the common targets
// render it without any per-service code.

/** Alert kinds, so repeats of the same condition can be suppressed independently. */
export type AlertKey =
  | 'health_alarm'
  | 'audio_missing'
  | 'ingest_unconfirmed'
  | 'auth_broken'
  | 'uplink_congested'
  | 'studio_dropped'
  | 'audio_silent'
  | 'video_missing';

/** Don't re-send the same alert key more often than this. A stuck condition is polled every 20s; the
 *  operator needs to be told once, not eighty times. */
const REPEAT_SUPPRESS_MS = 10 * 60 * 1000;

const lastSent = new Map<string, number>();

/** Clear suppression for a key — call when the condition recovers, so the NEXT occurrence alerts. */
export function clearAlert(key: AlertKey, subject: string): void {
  lastSent.delete(`${key}:${subject}`);
}

/**
 * Fire an alert, best-effort. Never throws and never blocks the caller: a broadcast must not be
 * affected by whether an alerting endpoint is reachable.
 *
 * `subject` is the thing the alert is about (usually a platform name) and takes part in the
 * suppression key, so a Facebook alarm doesn't silence a YouTube one.
 */
export function sendAlert(key: AlertKey, subject: string, message: string): void {
  const url = config.alertWebhookUrl;
  if (!url) return;

  const dedupeKey = `${key}:${subject}`;
  const previous = lastSent.get(dedupeKey);
  if (previous !== undefined && Date.now() - previous < REPEAT_SUPPRESS_MS) return;
  lastSent.set(dedupeKey, Date.now());

  const text = `🔴 ${config.alertPrefix} ${subject}: ${message}`;
  const body = JSON.stringify({
    // `text` is what Slack renders; `content` is what Discord renders. Sending both means one URL
    // works with either, with no service-specific code here.
    text,
    content: text,
    // Structured copy for anything that parses rather than displays.
    alert: key,
    subject,
    message,
    at: new Date().toISOString(),
  });

  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: httpTimeout(),
  })
    .then((res) => {
      if (!res.ok) console.warn(`[alert] Webhook returned ${res.status} for ${dedupeKey}`);
    })
    .catch((err) => {
      // A failed alert must never surface as an unhandled rejection mid-broadcast.
      console.warn(`[alert] Could not deliver ${dedupeKey}:`, err instanceof Error ? err.message : err);
    });

  console.warn(`[alert] ${text}`);
}

/** True when alerting is configured — used at startup to tell the operator whether they'll be told. */
export function alertsEnabled(): boolean {
  return !!config.alertWebhookUrl;
}
