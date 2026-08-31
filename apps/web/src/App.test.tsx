import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { App } from "./App";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

/**
 * Route-level role gating for the master forms.
 *
 * Every master-data write endpoint is `@Roles(Role.ADMINISTRATOR, Role.MANAGER)`, but the four
 * master *form* routes were registered under a bare `<Protected>` (signed-in only) while only
 * the charge-catalogue pair carried `AdminOrManagerOnly`. The list pages hide their "New" link
 * from an Executive, but each row is a `<Link>` to `/masters/<thing>/:id` with no gate at all —
 * so an Executive reached a fully-editable form whose every Save could only ever 403.
 */
function renderAt(path: string, role: string) {
  vi.stubGlobal(
    "fetch",
    mockFetch((url) => {
      if (url.endsWith("/api/auth/me"))
        return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role } } };
      // Owner-scoped sub-resources (GET /api/<owner>/:id/contacts, GET /api/<owner>/:id/warehouses)
      // are bare arrays server-side — listContacts/listWarehouses are plain findMany calls, not
      // paginated. They never carry a query string, unlike the real paginated list endpoints
      // (e.g. /api/warehouses?q=...&page=...&pageSize=...), so this suffix check can't collide
      // with those. Returning the paginated shape here instead crashed ClientFormPage and
      // FreightForwarderFormPage with "X.map/X.some is not a function" the moment either fetched
      // its owner's contacts or warehouses — not a production bug, a stale fixture.
      if (url.endsWith("/contacts") || url.endsWith("/warehouses")) return { status: 200, body: [] };
      // Every remaining list endpoint any redirect target might hit; shape is irrelevant to
      // these assertions.
      if (url.includes("/api/")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 10 } };
      return { status: 404 };
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

const FORM_ROUTES: [string, RegExp][] = [
  ["/masters/clients/new", /client form/i],
  ["/masters/clients/c1", /client form/i],
  ["/masters/vessels/new", /vessel form/i],
  ["/masters/vessels/v1", /vessel form/i],
  ["/masters/freight-forwarders/new", /freight forwarder form/i],
  ["/masters/freight-forwarders/f1", /freight forwarder form/i],
  ["/masters/warehouses/new", /warehouse form/i],
  ["/masters/warehouses/w1", /warehouse form/i],
  ["/masters/fx-rates/new", /new fx rate/i],
];

describe("master form routes are Administrator/Manager only", () => {
  it.each(FORM_ROUTES)("redirects an Executive away from %s", async (path, formLabel) => {
    renderAt(path, "EXECUTIVE");
    // The redirect lands on /queries (via "/"), so the form itself must never render.
    await waitFor(() => expect(screen.queryByRole("form", { name: formLabel })).not.toBeInTheDocument());
    expect(screen.queryByRole("form", { name: formLabel })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^save$/i })).not.toBeInTheDocument();
  });

  it.each(FORM_ROUTES)("still lets a Manager reach %s", async (path, formLabel) => {
    renderAt(path, "MANAGER");
    expect(await screen.findByRole("form", { name: formLabel })).toBeInTheDocument();
  });
});
