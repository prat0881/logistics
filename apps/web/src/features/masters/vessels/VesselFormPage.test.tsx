import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { VesselFormPage } from "./VesselFormPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

function renderForm() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={["/masters/vessels/new"]}>
          <Routes>
            <Route path="/masters/vessels/new" element={<VesselFormPage />} />
            <Route path="/masters/vessels" element={<p>vessels list</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("VesselFormPage (create)", () => {
  it("submits a new vessel with the required IMO, shipping line and type, and navigates to the list", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me"))
          return {
            status: 200,
            body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } },
          };
        if (url.endsWith("/api/vessels") && init?.method === "POST") {
          calls.push("create");
          return {
            status: 201,
            body: {
              id: "v9",
              vesselCode: "VS-0009",
              name: "MV NewCo",
              imoNumber: null,
              shippingLine: null,
              vesselType: "CONTAINER",
              status: "ACTIVE",
            },
          };
        }
        return { status: 404 };
      }),
    );
    renderForm();
    await userEvent.type(await screen.findByLabelText(/^name$/i), "MV NewCo");
    await userEvent.type(screen.getByLabelText(/imo number/i), "1234567");
    await userEvent.type(screen.getByLabelText(/shipping line/i), "Maersk");
    await userEvent.type(screen.getByLabelText(/vessel type/i), "Container Vessel");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText("vessels list")).toBeInTheDocument());
    expect(calls).toContain("create");
  });

  it("rejects a non-empty, badly-formed IMO instead of submitting", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.endsWith("/api/auth/me"))
          return {
            status: 200,
            body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } },
          };
        return { status: 404 };
      }),
    );
    renderForm();
    await userEvent.type(await screen.findByLabelText(/^name$/i), "MV Bad IMO");
    await userEvent.type(screen.getByLabelText(/imo number/i), "123");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText("IMO must be 7 digits")).toBeInTheDocument();
    expect(screen.queryByText("vessels list")).not.toBeInTheDocument();
  });
});

describe("VesselFormPage save failure", () => {
  // Mirrors ChargeLineFormPage: before this, onSubmit had no try/catch and there is no toast
  // system anywhere in apps/web, so a rejected save produced NOTHING — the button stopped
  // spinning and the page sat there. The 409 below is the message the API actually returns.
  it("surfaces the server’s error message instead of failing silently", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me"))
          return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } } };
        if (url.endsWith("/api/vessels") && init?.method === "POST")
          return { status: 409, body: { message: "A vessel with that IMO number already exists" } };
        return { status: 404 };
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <MemoryRouter initialEntries={["/masters/vessels/new"]}>
            <Routes>
              <Route path="/masters/vessels/new" element={<VesselFormPage />} />
              <Route path="/masters/vessels" element={<p>vessels list</p>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );
    await userEvent.type(await screen.findByLabelText(/name/i), "Dupe Vessel");
    await userEvent.type(screen.getByLabelText(/imo number/i), "9074729");
    await userEvent.type(screen.getByLabelText(/shipping line/i), "Test Line");
    await userEvent.type(screen.getByLabelText(/vessel type/i), "Container Vessel");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    // Still on the form: a refused save must never look like a successful one.
    expect(screen.queryByText("vessels list")).not.toBeInTheDocument();
  });
});
