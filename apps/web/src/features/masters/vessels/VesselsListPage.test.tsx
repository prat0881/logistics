import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { VesselsListPage } from "./VesselsListPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

function renderList(role: string) {
  vi.stubGlobal(
    "fetch",
    mockFetch((url) => {
      if (url.endsWith("/api/auth/me"))
        return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role } } };
      if (url.includes("/api/vessels"))
        return {
          status: 200,
          body: {
            items: [
              {
                id: "v1",
                vesselCode: "VS-0001",
                name: "MV Test Carrier",
                imoNumber: "1234567",
                shippingLine: "Maersk",
                vesselType: "CONTAINER",
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
          <VesselsListPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("VesselsListPage", () => {
  it("lists vessels and shows New for a Manager", async () => {
    renderList("MANAGER");
    await waitFor(() => expect(screen.getByText("MV Test Carrier")).toBeInTheDocument());
    expect(screen.getByText("VS-0001")).toBeInTheDocument();
    expect(screen.getByText("1234567")).toBeInTheDocument();
    expect(screen.getByText("CONTAINER")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /new vessel/i })).toBeInTheDocument();
  });

  it("hides New for an Executive", async () => {
    renderList("EXECUTIVE");
    await waitFor(() => expect(screen.getByText("MV Test Carrier")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /new vessel/i })).not.toBeInTheDocument();
  });

  it("requests page size 10 and renders the paginator", async () => {
    const fetchMock = vi.fn(
      mockFetch((url) => {
        if (url.endsWith("/api/auth/me"))
          return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "ADMINISTRATOR" } } };
        if (url.includes("/api/vessels"))
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
            <VesselsListPage />
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );
    await screen.findByText(/no vessels/i);
    const url = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/api/vessels"))!;
    expect(url).toMatch(/pageSize=10/);
    expect(screen.getByLabelText("Rows per page")).toBeInTheDocument();
  });
});
