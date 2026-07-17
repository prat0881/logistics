import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { ClientsListPage } from "./ClientsListPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

function renderList(role: string) {
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
    renderList("EXECUTIVE");
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /new client/i })).not.toBeInTheDocument();
  });
});
