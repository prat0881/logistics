import { ApiError } from "@/lib/api";

const usableText = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v : undefined;

/**
 * Masters-local error-message resolver.
 *
 * `raise()` (apps/web/src/lib/api.ts) surfaces the response body's own `message` for
 * every caller, since it's the shared fetch boundary for the whole app. But
 * `ZodValidationPipe` throws `{ message: "Validation failed", issues }` for every schema
 * rejection, so that constant is all a naive `err.message` read gets — including for the
 * masters' headline server rules (e.g. "Exactly one contact must be marked Primary"),
 * whose real text lives only in `issues`.
 *
 * This helper is what the masters' consolidated error regions call instead: it prefers the
 * first `issues[]` entry with a non-blank message, falls back to `err.message`, and falls
 * back again to a page-supplied `fallback` — the same non-blank-string test `raise()` itself
 * uses, so a whitespace-only issue message can't win over a good `err.message`.
 */
export function saveErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;

  const issues = err.issues;
  if (Array.isArray(issues)) {
    for (const issue of issues) {
      const message = usableText((issue as { message?: unknown } | undefined)?.message);
      if (message) return message;
    }
  }

  return usableText(err.message) ?? fallback;
}
