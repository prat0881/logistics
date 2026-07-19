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
 * Converts a datetime-local value (e.g. "2024-03-15T14:30") to an offset ISO string.
 * Uses the local timezone offset so the server receives the correct moment.
 */
export function toIsoOffset(local: string): string {
  const d = new Date(local);
  const offsetMinutes = d.getTimezoneOffset();
  const sign = offsetMinutes <= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const hh = String(Math.floor(absOffset / 60)).padStart(2, "0");
  const mm = String(absOffset % 60).padStart(2, "0");
  // Build ISO string with offset
  const yyyy = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  const MM = String(d.getMinutes()).padStart(2, "0");
  const SS = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mo}-${dd}T${HH}:${MM}:${SS}${sign}${hh}:${mm}`;
}
