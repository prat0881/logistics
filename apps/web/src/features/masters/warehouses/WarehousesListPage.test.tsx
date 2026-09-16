import type { ReactNode } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { WarehousesListPage } from "./WarehousesListPage";
import { mockFetch } from "@/test/mock-fetch";
import { AuthSettled } from "@/test/AuthSettled";

afterEach(() => vi.unstubAllGlobals());

function renderList(role: string, extra?: ReactNode) {
  vi.stubGlobal(
    "fetch",
    mockFetch((url) => {
      if (url.endsWith("/api/auth/me"))
        return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role } } };
      if (url.includes("/api/warehouses"))
        return {
          status: 200,
          body: {
            items: [
              {
                id: "w1",
                name: "Dubai DC",
                type: "OWNED",
                city: "Dubai",
                country: "UAE",
                capacity: "5000",
                capacityUnit: "CBM",
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
          <WarehousesListPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("WarehousesListPage", () => {
  it("lists warehouses and shows New for a Manager", async () => {
    renderList("MANAGER");
    await waitFor(() => expect(screen.getByText("Dubai DC")).toBeInTheDocument());
    expect(screen.getByText("Dubai")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /new warehouse/i })).toBeInTheDocument();
  });

  it("hides New for an Executive", async () => {
    renderList("EXECUTIVE", <AuthSettled />);
    // Await the probe, not the data row. The list query and /api/auth/me are independent
    // and resolve in either order, and useCanWrite() is false while auth loads as well as
    // for an Executive — so awaiting the row proves nothing about the role, and this test
    // passed unchanged with the role check deleted. See AuthSettled's own doc comment.
    expect(await screen.findByText("auth role: EXECUTIVE")).toBeInTheDocument();
    // The row too, awaited separately: neither query's arrival implies the other's. This
    // keeps the original "the list actually rendered" coverage.
    expect(await screen.findByText("Dubai DC")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /new warehouse/i })).not.toBeInTheDocument();
  });
});

describe("WarehousesListPage fetch failure", () => {
  // Mirrors ChargeCatalogueListPage: a failed fetch must never render the same "No warehouses yet."
  // message an empty-but-successful load produces — that reads as data loss.
  it("surfaces the server’s message and never the empty-state message", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.endsWith("/api/auth/me"))
          return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } } };
        if (url.includes("/api/warehouses")) return { status: 500, body: { message: "Database unavailable" } };
        return { status: 404 };
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <MemoryRouter>
            <WarehousesListPage />
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Database unavailable");
    expect(screen.queryByText("No warehouses yet.")).not.toBeInTheDocument();
  });
});
