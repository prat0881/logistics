import { vi } from "vitest";

type Handler = (url: string, init?: RequestInit) => { status: number; body?: unknown };

export function mockFetch(handler: Handler) {
  return vi.fn((url: string, init?: RequestInit) => {
    const { status, body } = handler(url, init);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body ?? {}),
      text: () => Promise.resolve(body === undefined ? "" : JSON.stringify(body)),
    } as Response);
  });
}
