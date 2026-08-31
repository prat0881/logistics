import { QueryClient } from "@tanstack/react-query";
import type { Finding } from "@svyft/shared";

export const queryClient = new QueryClient();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly findings?: Finding[],
    readonly issues?: unknown[],
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Global 401 handler (U1). Fired by raise() when an authenticated request gets a
 * 401 (cookie/JWT expiry) from a NON-auth endpoint. Auth endpoints (`/api/auth/*`)
 * manage their own 401s (login errors, the initial me-probe) so they're excluded.
 * AuthProvider registers a handler that clears the user + query cache, which makes
 * ProtectedRoute redirect to /login.
 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

async function raise(res: Response, url: string): Promise<never> {
  let body: unknown = undefined;
  try {
    body = await res.json();
  } catch {
    /* empty */
  }
  const findings =
    body && Array.isArray((body as Record<string, unknown>).findings)
      ? ((body as Record<string, unknown>).findings as Finding[])
      : undefined;
  const issues =
    body && Array.isArray((body as Record<string, unknown>).issues)
      ? ((body as Record<string, unknown>).issues as unknown[])
      : undefined;
  // U1: an authenticated request 401'd (session/cookie expiry) — trigger global
  // logout. Auth endpoints handle their own 401s, so exclude them.
  if (res.status === 401 && !url.includes("/api/auth/")) {
    onUnauthorized?.();
  }
  // ZodValidationPipe throws `{ message: "Validation failed", issues }` for EVERY schema
  // rejection, so `message` alone renders the same unactionable constant no matter what was
  // wrong — including the composite endpoints' headline rules (exactlyOnePrimary /
  // atMostOnePrimary), whose real text lives only in `issues`. Design decision C10 argued that
  // one consolidated error region rendering *nothing* is worse than six that do; the same
  // argument applies to rendering a constant, so the first issue's own message wins when there
  // is one.
  //
  // `??` alone is not enough at either step: an empty or whitespace-only string is a *present*
  // string, so it passes a nullish check and renders as a blank alert. Every master form now
  // shows one consolidated error region, and a blank region on a real failure is worse than no
  // region.
  const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : undefined);
  const firstIssueMessage = text((issues?.[0] as { message?: unknown } | undefined)?.message);
  const rawMessage = text((body as Record<string, unknown> | undefined)?.message);
  const message = firstIssueMessage ?? rawMessage ?? `Request failed: ${res.status}`;

  throw new ApiError(res.status, message, findings, issues, body);
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) return raise(res, url);
  return (await res.json()) as T;
}

export async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) return raise(res, url);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function patchJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return raise(res, url);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function putJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return raise(res, url);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function del(url: string): Promise<void> {
  const res = await fetch(url, { method: "DELETE", credentials: "include" });
  if (!res.ok) return raise(res, url);
}
