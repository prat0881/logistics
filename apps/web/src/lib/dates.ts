import { format, parseISO } from "date-fns";

/**
 * Formats an ISO datetime string to "DD-MM-YYYY HH:mm".
 * Returns empty string for null or empty input.
 */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  try {
    return format(parseISO(iso), "dd-MM-yyyy HH:mm");
  } catch {
    return "";
  }
}

/**
 * Formats an ISO date string to "DD-MM-YYYY".
 * Returns empty string for null or empty input.
 */
export function formatDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return format(parseISO(iso), "dd-MM-yyyy");
  } catch {
    return "";
  }
}

/**
 * Converts an offset ISO string (e.g. "2024-03-15T14:30:00+05:30") to a
 * datetime-local string (e.g. "2024-03-15T14:30") suitable for
 * `<input type="datetime-local">`. Returns empty string for null/undefined/empty.
 *
 * FLOATING WALL-CLOCK: logistics dates (queryDate, readyDate, ETA/ETB/ETD, etc.)
 * represent a wall-clock time at a specific location, NOT an absolute instant.
 * We therefore extract the digits directly from the ISO string — no Date math,
 * no timezone re-projection — so "2026-06-15T09:00:00+05:30" always yields
 * "2026-06-15T09:00" regardless of the viewer's machine timezone.
 */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  // Match the YYYY-MM-DDTHH:MM prefix directly from the string — no Date parsing.
  // Handles: "...+HH:MM", "...-HH:MM", "...Z", "...+00:00", bare "YYYY-MM-DDTHH:MM:SS"
  const m = iso.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
  if (!m) return "";
  return m[1];
}

/**
 * Converts a datetime-local value (e.g. "2024-03-15T14:30") to an offset ISO string.
 *
 * FLOATING WALL-CLOCK: the entered digits are kept as-is; we append the machine's
 * local UTC offset (e.g. "+05:30") so the result satisfies z.string().datetime({offset:true})
 * without shifting the wall-clock digits to UTC. On a UTC machine the offset is "+00:00".
 * A round-trip isoToLocalInput(toIsoOffset(local)) === local is guaranteed.
 */
export function toIsoOffset(local: string): string {
  // Determine the machine's local UTC offset without relying on Date arithmetic on `local`.
  // new Date() gives the current offset (DST-aware for the current instant, which is
  // close enough for logistics planning; exact DST edge cases are acceptable).
  const now = new Date();
  const offsetMinutes = now.getTimezoneOffset(); // returns -330 for IST (+05:30)
  const sign = offsetMinutes <= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const hh = String(Math.floor(absOffset / 60)).padStart(2, "0");
  const mm = String(absOffset % 60).padStart(2, "0");
  const offset = `${sign}${hh}:${mm}`;
  // Append seconds if not already present, then the offset.
  // local is "YYYY-MM-DDTHH:MM" from a datetime-local input.
  const withSeconds = local.length === 16 ? `${local}:00` : local;
  return `${withSeconds}${offset}`;
}
