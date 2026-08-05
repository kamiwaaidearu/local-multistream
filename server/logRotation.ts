// Pure filename/retention logic for the server log files, split out from logging.ts so it can be
// unit-tested without touching the filesystem or patching console.

/** Log file basename for a given instant, in LOCAL time (an operator reading logs thinks in local
 * days, and the streams are scheduled in local time). */
export function logFileName(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `server-${y}-${m}-${d}.log`;
}

/** True when `at` falls on a different local day than `openedAt` — i.e. time to rotate. */
export function shouldRotate(openedAt: Date, at: Date): boolean {
  return logFileName(openedAt) !== logFileName(at);
}

const NAME_RE = /^server-(\d{4})-(\d{2})-(\d{2})\.log$/;

/**
 * Which of `names` are server logs older than `retentionDays` relative to `today`. Anything that
 * isn't a `server-YYYY-MM-DD.log` is left alone — we only ever delete files we created, so an
 * operator can drop unrelated notes in the log directory without losing them. A retentionDays of 0
 * or less disables pruning entirely (returns nothing) rather than deleting everything, which would
 * be a surprising reading of "keep 0 days" for a config typo.
 */
export function filesToPrune(names: string[], today: Date, retentionDays: number): string[] {
  if (retentionDays <= 0) return [];
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  cutoff.setDate(cutoff.getDate() - (retentionDays - 1));

  return names.filter((name) => {
    const m = NAME_RE.exec(name);
    if (!m) return false;
    const fileDay = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return fileDay.getTime() < cutoff.getTime();
  });
}
