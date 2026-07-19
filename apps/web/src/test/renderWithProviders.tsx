import { type ReactElement } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import type { AuthUser } from "@/features/auth/AuthProvider";
import { vi } from "vitest";

interface RenderOptions {
  route?: string;
  /**
   * When provided, the rendered tree is authenticated as this user without any
   * manual fetch stub by the caller. `renderWithProviders` installs a
   * `/api/auth/me` stub automatically.
   */
  user?: AuthUser;
}

/**
 * Wraps the given UI in the standard provider tree used across Plan 6 feature tests:
 *   QueryClientProvider (retry:false) + AuthProvider + MemoryRouter
 *
 * When `user` is provided, a `/api/auth/me` fetch stub is automatically installed
 * so the tree is authenticated as that user — no manual stub required by the caller.
 *
 * Example:
 *   const { getByText } = renderWithProviders(<MyComponent />, { route: "/queries", user });
 */
export function renderWithProviders(
  ui: ReactElement,
  { route = "/", user }: RenderOptions = {},
): RenderResult {
  if (user !== undefined) {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (typeof url === "string" && url.endsWith("/api/auth/me")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ user }),
            text: () => Promise.resolve(JSON.stringify({ user })),
          } as Response);
        }
        // Fall through to original fetch if available, otherwise 404
        if (originalFetch) return originalFetch(url, init);
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
        } as Response);
      }),
    );
  }

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}
