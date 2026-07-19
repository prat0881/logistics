import { type ReactElement } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import type { AuthUser } from "@/features/auth/AuthProvider";

interface RenderOptions {
  route?: string;
  user?: AuthUser;
}

/**
 * Wraps the given UI in the standard provider tree used across Plan 6 feature tests:
 *   QueryClientProvider (retry:false) + AuthProvider + MemoryRouter
 *
 * The caller is responsible for stubbing `fetch` before calling this, including:
 *   - /api/auth/me → { user } (if user is provided, otherwise null user is expected)
 *
 * Example:
 *   vi.stubGlobal("fetch", mockFetch((url) => {
 *     if (url.endsWith("/api/auth/me")) return { status: 200, body: { user } };
 *     return { status: 404 };
 *   }));
 *   const { getByText } = renderWithProviders(<MyComponent />, { route: "/queries", user });
 */
export function renderWithProviders(
  ui: ReactElement,
  { route = "/" }: RenderOptions = {},
): RenderResult {
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
