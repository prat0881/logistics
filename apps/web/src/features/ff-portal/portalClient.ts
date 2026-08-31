// portalClient.ts — the portal's ONLY network client. Deliberately independent of
// lib/api.ts so a portal 401 can NEVER trigger the app's global logout (setUser(null)+cache clear).
import type { Finding } from "@svyft/shared";

export class PortalError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`Portal request failed: ${status}`);
    this.name = "PortalError";
  }
  get findings(): Finding[] | undefined {
    const f = (this.body as Record<string, unknown> | undefined)?.findings;
    return Array.isArray(f) ? (f as Finding[]) : undefined;
  }
  /** Nest's default HttpException body shape is `{statusCode, message, error}` — e.g. the
   *  stale-page 409's "please refresh" text (S5.9 D10). Undefined for bodies that don't carry a
   *  plain string message (e.g. the 422 findings body above). */
  get serverMessage(): string | undefined {
    const m = (this.body as Record<string, unknown> | undefined)?.message;
    return typeof m === "string" ? m : undefined;
  }
}

async function parse(res: Response): Promise<unknown> {
  try { return await res.json(); } catch { return undefined; }
}

export async function portalGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "omit" });
  const body = await parse(res);
  if (!res.ok) throw new PortalError(res.status, body);
  return body as T;
}

async function write<T>(method: "PATCH" | "POST", path: string, payload: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await parse(res);
  if (!res.ok) throw new PortalError(res.status, body);
  return body as T;
}

export const portalPatch = <T>(path: string, body: unknown) => write<T>("PATCH", path, body);
export const portalPost = <T>(path: string, body: unknown) => write<T>("POST", path, body);
