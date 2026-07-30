// packages/shared/src/timezone.ts
// Location-anchored timezone helpers (Issue 3). Pure + isomorphic — native Intl only.
// Operational times are stored as true UTC and interpreted/displayed in an anchor zone.

const pad = (n: number) => String(n).padStart(2, "0");

/** True iff `zone` is a resolvable IANA timezone id. */
export function isValidIanaZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The runtime's IANA zone (browser/server local). */
export function viewerZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

// ms that `zone` is ahead of UTC at instant `date` (DST-aware).
function zoneOffsetMs(zone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const p = dtf.formatToParts(date).reduce<Record<string, string>>((a, x) => {
    if (x.type !== "literal") a[x.type] = x.value;
    return a;
  }, {});
  const hour = Number(p.hour);
  const asIfUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    hour,
    Number(p.minute),
    Number(p.second),
  );
  return asIfUtc - date.getTime();
}

/**
 * Interpret a wall-clock ("YYYY-MM-DDTHH:mm" or ":ss") AS IF in `zone`; return the UTC ISO instant.
 * Two-pass offset resolution handles DST transitions.
 */
export function zonedInputToUtc(wallClock: string, zone: string): string {
  if (!wallClock) return "";
  const provisional = new Date(`${wallClock.length === 16 ? `${wallClock}:00` : wallClock}Z`);
  if (Number.isNaN(provisional.getTime())) return "";
  let utcMs = provisional.getTime() - zoneOffsetMs(zone, provisional);
  const off2 = zoneOffsetMs(zone, new Date(utcMs));
  utcMs = provisional.getTime() - off2; // re-resolve at the candidate instant (DST edges)
  return new Date(utcMs).toISOString();
}

/** UTC ISO → the "YYYY-MM-DDTHH:mm" wall-clock in `zone` (for a datetime-local input). */
export function utcToZonedInput(utcIso: string, zone: string): string {
  if (!utcIso) return "";
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return "";
  const off = zoneOffsetMs(zone, d);
  const local = new Date(d.getTime() + off);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
  );
}

/** Padded GMT offset at an optional instant (e.g. "GMT+05:30", "GMT-04:00"). */
export function zoneLabel(zone: string, atUtcIso?: string): string {
  const d = atUtcIso ? new Date(atUtcIso) : new Date();
  const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
    .formatToParts(Number.isNaN(d.getTime()) ? new Date() : d)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? zone;
}

/** UTC ISO → "dd-MM-yyyy HH:mm <zoneLabel>" in `zone`. Empty for empty input. */
export function formatInZone(utcIso: string, zone: string): string {
  if (!utcIso) return "";
  const input = utcToZonedInput(utcIso, zone); // "YYYY-MM-DDTHH:mm"
  if (!input) return "";
  const [date, time] = input.split("T");
  const [y, m, day] = date.split("-");
  return `${day}-${m}-${y} ${time} ${zoneLabel(zone, utcIso)}`;
}

/**
 * UTC ISO instant for "today at 12:00 (noon), :00 minutes" as seen in `zone`.
 *
 * Used to seed a new query/leg's datetime inputs so they render a clean 12:00
 * default in the field's display zone — instead of the native datetime-local
 * empty-state, which shows a greyed placeholder that reads as ":30" once an
 * empty (UTC-anchored) instant is projected into a +HH:30 zone like IST.
 * "Today" is the calendar date IN `zone` (not the UTC date), so the picker never
 * lands on the wrong day near midnight. `now` is injectable for deterministic tests.
 * Returns "" if the zone is unresolvable.
 */
export function noonTodayInZone(zone: string, now: Date = new Date()): string {
  if (!zone) return "";
  const today = utcToZonedInput(now.toISOString(), zone).slice(0, 10); // "YYYY-MM-DD" in zone
  if (!today) return "";
  return zonedInputToUtc(`${today}T12:00`, zone);
}
