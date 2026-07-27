import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { FreightForwarderFormPage } from "./FreightForwarderFormPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

function renderForm() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={["/masters/freight-forwarders/new"]}>
          <Routes>
            <Route path="/masters/freight-forwarders/new" element={<FreightForwarderFormPage />} />
            <Route path="/masters/freight-forwarders" element={<p>ff list</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("FreightForwarderFormPage (create)", () => {
  it("blocks submit and shows an error when required fields are missing", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me"))
          return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } } };
        if (url.endsWith("/api/freight-forwarders") && init?.method === "POST") {
          calls.push("create");
          return { status: 201, body: {} };
        }
        return { status: 404 };
      }),
    );
    renderForm();
    await userEvent.click(await screen.findByRole("button", { name: /save/i }));
    expect(await screen.findByText(/select at least one mode/i)).toBeInTheDocument();
    expect(calls).not.toContain("create");
  });

  it("submits a valid FF and navigates to the list", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me"))
          return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } } };
        if (url.endsWith("/api/freight-forwarders") && init?.method === "POST") {
          calls.push("create");
          return { status: 201, body: { id: "f9", freightForwarderCode: "FF-0009" } };
        }
        return { status: 404 };
      }),
    );
    renderForm();
    await userEvent.type(await screen.findByLabelText(/company name/i), "Acme Freight");
    await userEvent.type(screen.getByLabelText(/person in charge/i), "Jane Doe");
    await userEvent.type(screen.getByLabelText(/contact number/i), "+15551234567");
    await userEvent.type(screen.getByLabelText(/^email$/i), "ops@acme.example");
    // countries — open popover, select Singapore, then close via Escape
    await userEvent.click(screen.getByRole("button", { name: /countries/i }));
    await userEvent.click(await screen.findByText("Singapore"));
    await userEvent.keyboard("{Escape}");
    // modes — open popover, select AIR, then close via Escape
    await userEvent.click(screen.getByRole("button", { name: /^modes$/i }));
    await userEvent.click(await screen.findByText("AIR"));
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText("ff list")).toBeInTheDocument());
    expect(calls).toContain("create");
  });
});
