// Facebook reminder schedule — composes and times the announcement posts that give an upcoming
// stream advance visibility. (The live video itself can't be scheduled via the API; see
// platforms/facebook.ts.) The schedule is user-editable and stored in the `settings` table.
import { getSetting } from '../db/index.js';
import type { Stream } from '../types.js';

const SETTINGS_KEY = 'facebook_reminders';

/** When a reminder fires, relative to the event's scheduled start. */
export type ReminderWhen =
  | { kind: 'sameDayAt'; time: string }                         // event day at HH:MM
  | { kind: 'weekdayBeforeAt'; weekday: number; time: string }  // last <weekday> (0=Sun) before the event, at HH:MM
  | { kind: 'beforeStart'; minutes: number };                   // event start minus N minutes

export interface ReminderRule {
  id: string;
  label: string;
  enabled: boolean;
  when: ReminderWhen;
  /** Post text. Placeholders: {title} {description} {date} {time} {datetime} {weekday} {site} */
  template: string;
}

export interface ReminderSettings {
  enabled: boolean;   // global on/off (covers advance reminders AND the go-live post)
  timezone: string;   // IANA tz the times are interpreted in, e.g. America/New_York
  site: string;       // value for the {site} placeholder
  rules: ReminderRule[];
  /**
   * A post published the moment you go live — fired after the broadcast is LIVE, so unlike the
   * advance reminders it can link to the actual video via {video}.
   */
  goLivePost: { enabled: boolean; template: string };
}

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  enabled: true,
  timezone: 'America/New_York',
  site: 'RosaryMen.com',
  rules: [
    {
      id: 'sunday-before',
      label: 'Sunday before',
      enabled: true,
      when: { kind: 'weekdayBeforeAt', weekday: 0, time: '18:00' },
      template: '🙏 Coming up {weekday} — {title}\n\nJoin us live {datetime} right here on our page:\n{page}\n\n{description}',
    },
    {
      id: 'morning-of',
      label: 'Morning of',
      enabled: true,
      when: { kind: 'sameDayAt', time: '08:00' },
      template: '🔴 LIVE TODAY at {time} — {title}\n\nWatch here ▶️ {page}\n\n{description}',
    },
  ],
  goLivePost: {
    enabled: true,
    template: "🔴 WE'RE LIVE NOW — {title}\n\nWatch ▶️ {video}\n\n{description}",
  },
};

export function getReminderSettings(): ReminderSettings {
  // Merge over defaults so settings saved before a field existed (e.g. goLivePost) still work.
  const saved = getSetting<Partial<ReminderSettings>>(SETTINGS_KEY);
  return saved ? { ...DEFAULT_REMINDER_SETTINGS, ...saved } : DEFAULT_REMINDER_SETTINGS;
}

export const REMINDER_SETTINGS_KEY = SETTINGS_KEY;

// --- Timezone math (no external deps) ---

/** Wall-clock parts of a unix instant as seen in a given IANA timezone. */
function tzParts(unixSec: number, tz: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(unixSec * 1000))) {
    if (p.type !== 'literal') map[p.type] = parseInt(p.value, 10);
  }
  // Some environments emit hour '24' for midnight — normalize to 0.
  if (map.hour === 24) map.hour = 0;
  return { year: map.year, month: map.month, day: map.day, hour: map.hour, minute: map.minute, second: map.second };
}

/** Convert a wall-clock time in a given IANA timezone to a unix timestamp (seconds). */
function wallClockToUnix(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  // Interpret the wall clock as if it were UTC, then correct by the zone's offset at that instant.
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const seen = tzParts(Math.floor(naiveUtcMs / 1000), tz);
  const seenAsUtcMs = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
  const offsetMs = seenAsUtcMs - naiveUtcMs;
  return Math.floor((naiveUtcMs - offsetMs) / 1000);
}

/** Day-of-week (0=Sun..6=Sat) for a calendar date. */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function parseHM(time: string): { hour: number; minute: number } {
  const [h, m] = time.split(':').map((n) => parseInt(n, 10));
  return { hour: Number.isFinite(h) ? h : 0, minute: Number.isFinite(m) ? m : 0 };
}

/**
 * Compute the unix timestamp (seconds) at which a reminder rule should publish for an event that
 * starts at `eventStartUnix`, interpreting clock times in `tz`. Returns null if the rule can't
 * produce a valid time.
 */
export function computeReminderTime(rule: ReminderRule, eventStartUnix: number, tz: string): number | null {
  if (rule.when.kind === 'beforeStart') {
    return eventStartUnix - rule.when.minutes * 60;
  }

  const ev = tzParts(eventStartUnix, tz);

  if (rule.when.kind === 'sameDayAt') {
    const { hour, minute } = parseHM(rule.when.time);
    return wallClockToUnix(ev.year, ev.month, ev.day, hour, minute, tz);
  }

  // weekdayBeforeAt: walk back to the most recent target weekday strictly before the event date.
  const eventWeekday = weekdayOf(ev.year, ev.month, ev.day);
  let daysBack = (eventWeekday - rule.when.weekday + 7) % 7;
  if (daysBack === 0) daysBack = 7; // same weekday => the previous week's occurrence
  const target = new Date(Date.UTC(ev.year, ev.month - 1, ev.day - daysBack));
  const { hour, minute } = parseHM(rule.when.time);
  return wallClockToUnix(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), hour, minute, tz);
}

/**
 * Render a reminder template for a stream, filling in placeholders. `pageUrl` fills {page} (the
 * Page, where the live surfaces — what advance posts link to). `videoUrl` fills {video} (the
 * actual broadcast URL — only available for the go-live post, once the video exists).
 */
export function renderReminder(template: string, stream: Stream, settings: ReminderSettings, pageUrl = '', videoUrl = ''): string {
  const start = stream.scheduled_start ? new Date(stream.scheduled_start * 1000) : null;
  const tz = settings.timezone;
  const fmt = (opts: Intl.DateTimeFormatOptions) =>
    start ? start.toLocaleString('en-US', { ...opts, timeZone: tz }) : '';

  const weekday = fmt({ weekday: 'long' });
  const date = fmt({ weekday: 'long', month: 'long', day: 'numeric' });
  const time = fmt({ hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const datetime = fmt({ weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

  const values: Record<string, string> = {
    title: stream.name,
    description: stream.description ?? '',
    date,
    time,
    datetime,
    weekday,
    site: settings.site,
    page: pageUrl,
    video: videoUrl,
  };

  return template
    .replace(/\{(\w+)\}/g, (m, key: string) => (key in values ? values[key] : m))
    // Collapse blank lines left by an empty {description}.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
