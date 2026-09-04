import type { ReactNode } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { ClientsListPage } from "./ClientsListPage";
import { mockFetch } from "@/test/mock-fetch";
import { AuthSettled } from "@/test/AuthSettled";

afterEach(() => vi.unstubAllGlobals());

function renderList(role: string, extra?: ReactNode) {
  vi.stubGlobal(
    "fetch",
    mockFetch((url) => {
      if (url.endsWith("/api/auth/me"))
        return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role } } };
      if (url.includes("/api/clients"))
        return {
          status: 200,
          body: {
            items: [
              {
                id: "c1",
                clientCode: "CL-0001",
                companyName: "Acme",
                country: "IN",
                status: "ACTIVE",
              },
            ],
            total: 1,
            page: 1,
            pageSize: 10,
          },
        };
      return { status: 404 };
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter>
          {extra}
          <ClientsListPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("ClientsListPage", () => {
  it("lists clients and shows New for a Manager", async () => {
    renderList("MANAGER");
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument());
    expect(screen.getByText("CL-0001")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /new client/i })).toBeInTheDocument();
  });

  it("hides New for an Executive", async () => {
    renderList("EXECUTIVE", <AuthSettled />);
    // Await the probe, not the "Acme" row. The list query and /api/auth/me are independent and
    // resolve in either order, and useCanWrite() is false while auth loads as well as for an
    // Executive — so awaiting the row proves nothing about the role, and this test passed
    // unchanged with the role check deleted. See AuthSettled's own doc comment.
    expect(await screen.findByText("auth role: EXECUTIVE")).toBeInTheDocument();
    // The row too, awaited separately: the two queries are independent, so neither one's arrival
    // implies the other's. This keeps the original "the list actually rendered" coverage.
    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /new client/i })).not.toBeInTheDocument();
  });

  it("requests page size 10 and renders the paginator", async () => {
    const fetchMock = vi.fn(
      mockFetch((url) => {
        if (url.endsWith("/api/auth/me"))
          return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "ADMINISTRATOR" } } };
        if (url.includes("/api/clients"))
          return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 10 } };
        return { status: 404 };
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <MemoryRouter>
            <ClientsListPage />
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );
    await screen.findByText(/no clients/i);
    const url = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/api/clients"))!;
    expect(url).toMatch(/pageSize=10/);
    expect(screen.getByLabelText("Rows per page")).toBeInTheDocument();
  });
});

describe("ClientsListPage fetch failure", () => {
  // Mirrors ChargeCatalogueListPage: a failed fetch must never render the same "No clients yet."
  // message an empty-but-successful load produces — that reads as data loss.
  it("surfaces the server’s message and never the empty-state message", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.endsWith("/api/auth/me"))
          return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } } };
        if (url.includes("/api/clients")) return { status: 500, body: { message: "Database unavailable" } };
        return { status: 404 };
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <MemoryRouter>
            <ClientsListPage />
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Database unavailable");
    expect(screen.queryByText("No clients yet.")).not.toBeInTheDocument();
  });
});
