import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { FreightForwardersListPage } from "./FreightForwardersListPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

function renderList(role: string) {
  vi.stubGlobal(
    "fetch",
    mockFetch((url) => {
      if (url.endsWith("/api/auth/me"))
        return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role } } };
      if (url.includes("/api/freight-forwarders"))
        return {
          status: 200,
          body: {
            items: [
              {
                id: "f1",
                freightForwarderCode: "FF-0001",
                companyName: "Acme Freight",
                pic: "Jane",
                contactNumber: "+15551234567",
                email: "ops@acme.example",
                availableCountries: ["US", "SG"],
                modes: ["AIR", "SEA"],
                handleDg: true,
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
          <FreightForwardersListPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("FreightForwardersListPage", () => {
  it("lists FFs and shows New for a Manager", async () => {
    renderList("MANAGER");
    await waitFor(() => expect(screen.getByText("Acme Freight")).toBeInTheDocument());
    expect(screen.getByText("FF-0001")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /new freight forwarder/i })).toBeInTheDocument();
  });

  it("hides New for an Executive", async () => {
    renderList("EXECUTIVE");
    await waitFor(() => expect(screen.getByText("Acme Freight")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /new freight forwarder/i })).not.toBeInTheDocument();
  });
});
