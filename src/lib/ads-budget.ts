/** Booked as a cap, not as measured Etsy Ads spend. */
export function adsEstimateNote(date: string) {
  return `Etsy Ads daily cap (estimate) ${date}`;
}

export function adsNoteDate(note: string | null | undefined) {
  const match = note?.match(/Etsy Ads (?:daily cap \(estimate\)|budget) (\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return dayKey(next);
}

/**
 * Days that should carry the current daily cap as an estimate.
 * Fills gaps after ads were enabled (or after the first booked day, when that timestamp is missing).
 * Does not invent days before the first booking if we never recorded when ads were turned on.
 */
export function missingAdsDays(opts: {
  today: string;
  enabledAt: string | null;
  existingNotes: (string | null | undefined)[];
  lookbackDays?: number;
}) {
  const lookback = opts.lookbackDays ?? 90;
  const booked = new Set(opts.existingNotes.map(adsNoteDate).filter((d): d is string => Boolean(d)));
  const earliest = [...booked].sort()[0];
  let start = opts.today;
  if (opts.enabledAt) {
    const enabledDay = opts.enabledAt.slice(0, 10);
    start = enabledDay > opts.today ? opts.today : enabledDay;
  } else if (earliest) {
    start = earliest;
  }
  const earliestAllowed = addDays(opts.today, -lookback);
  if (start < earliestAllowed) start = earliestAllowed;
  const missing: string[] = [];
  for (let day = start; day <= opts.today; day = addDays(day, 1)) {
    if (!booked.has(day)) missing.push(day);
  }
  return missing;
}
