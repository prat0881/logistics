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
