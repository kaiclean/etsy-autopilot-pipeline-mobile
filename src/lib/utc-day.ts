const DAY_MS = 864e5;

/** UTC midnight for the calendar day containing `now`. */
export function utcDayStart(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function utcDayKey(now: Date) {
  return utcDayStart(now).toISOString().slice(0, 10);
}

/** Monday (UTC) of the calendar week that contains `now`. */
export function mondayKey(now: Date) {
  const start = utcDayStart(now);
  const day = start.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  start.setUTCDate(start.getUTCDate() - diff);
  return start.toISOString().slice(0, 10);
}

/**
 * Trailing 7 days ending at `now`.
 * `weekStart` is the Monday of the window start, so a second Monday run updates one row.
 */
export function weeklyWindow(now: Date) {
  const end = now;
  const start = new Date(end.getTime() - 7 * DAY_MS);
  return { start, end, weekStart: mondayKey(start) };
}
