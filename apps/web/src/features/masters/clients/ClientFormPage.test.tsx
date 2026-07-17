import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { ClientFormPage } from "./ClientFormPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

describe("ClientFormPage (create)", () => {
  it("submits a new client and navigates to the list", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me"))
          return {
            status: 200,
            body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } },
          };
        if (url.endsWith("/api/clients") && init?.method === "POST") {
          calls.push("create");
          return {
            status: 201,
            body: {
              id: "c9",
              clientCode: "CL-0009",
              companyName: "NewCo",
              country: "IN",
              status: "ACTIVE",
            },
          };
        }
        return { status: 404 };
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <MemoryRouter initialEntries={["/masters/clients/new"]}>
            <Routes>
              <Route path="/masters/clients/new" element={<ClientFormPage />} />
              <Route path="/masters/clients" element={<p>clients list</p>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );
    await userEvent.type(await screen.findByLabelText(/company name/i), "NewCo");
    await userEvent.type(screen.getByLabelText(/country/i), "IN");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText("clients list")).toBeInTheDocument());
    expect(calls).toContain("create");
  });
});
