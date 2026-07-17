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
            pageSize: 20,
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
});
