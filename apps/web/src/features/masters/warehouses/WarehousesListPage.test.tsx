import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { WarehousesListPage } from "./WarehousesListPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

function renderList(role: string) {
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
    renderList("EXECUTIVE");
    await waitFor(() => expect(screen.getByText("Dubai DC")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /new warehouse/i })).not.toBeInTheDocument();
  });
});
