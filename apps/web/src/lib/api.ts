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

async function raise(res: Response): Promise<never> {
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
  throw new ApiError(
    res.status,
    (body as Record<string, unknown> | undefined)?.message as string ??
      `Request failed: ${res.status}`,
    findings,
    issues,
    body,
  );
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) return raise(res);
  return (await res.json()) as T;
}

export async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) return raise(res);
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
  if (!res.ok) return raise(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function del(url: string): Promise<void> {
  const res = await fetch(url, { method: "DELETE", credentials: "include" });
  if (!res.ok) return raise(res);
}
