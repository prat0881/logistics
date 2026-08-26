import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { ChargeLineFormPage } from "./ChargeLineFormPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

const EXISTING_LINE = {
  id: "existing-id",
  key: "SEA_DEST_WHARFAGE",
  mode: "SEA",
  variant: "BOTH",
  category: "DESTINATION",
  label: "Wharfage Charges",
  isAdditional: true,
  tagKey: null,
  inputType: "PLAIN",
  sortOrder: 69,
  isActive: true,
};

function renderForm(opts?: { id?: string }) {
  vi.stubGlobal(
    "fetch",
    mockFetch((url, init) => {
      if (url.endsWith("/api/auth/me"))
        return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "ADMINISTRATOR" } } };
      if (url.endsWith("/api/charge-line-definitions/admin") && (!init || init.method === undefined || init.method === "GET"))
        return { status: 200, body: [EXISTING_LINE] };
      return { status: 404 };
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const path = opts?.id ? `/masters/charge-catalogue/${opts.id}` : "/masters/charge-catalogue/new";
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/masters/charge-catalogue/new" element={<ChargeLineFormPage />} />
            <Route path="/masters/charge-catalogue/:id" element={<ChargeLineFormPage />} />
            <Route path="/masters/charge-catalogue" element={<p>charge catalogue list</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("ChargeLineFormPage", () => {
  it("offers only the categories and variants that belong to the chosen mode", async () => {
    renderForm();
    await userEvent.selectOptions(await screen.findByLabelText(/mode/i), "ROAD");
    const categories = within(screen.getByLabelText(/category/i)).getAllByRole("option");
    expect(categories.map((o) => o.textContent)).toEqual(["Freight Charges", "Additional Charges"]);

    await userEvent.selectOptions(screen.getByLabelText(/mode/i), "SEA");
    const variants = within(screen.getByLabelText(/variant/i)).getAllByRole("option");
    expect(variants.map((o) => (o as HTMLOptionElement).value)).toEqual(["FCL", "LCL", "BOTH"]);
  });

  it("locks category and additional when editing an existing line", async () => {
    renderForm({ id: "existing-id" });
    expect(await screen.findByLabelText(/category/i)).toBeDisabled();
    expect(screen.getByLabelText(/additional charge/i)).toBeDisabled();
  });

  it("shows the generated key read-only when editing", async () => {
    renderForm({ id: "existing-id" });
    expect(await screen.findByText("SEA_DEST_WHARFAGE")).toBeInTheDocument();
  });

  it("surfaces the server's error message instead of failing silently", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me"))
          return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "ADMINISTRATOR" } } };
        if (url.endsWith("/api/charge-line-definitions/admin"))
          return { status: 200, body: [] };
        if (url.endsWith("/api/charge-line-definitions") && init?.method === "POST")
          return { status: 409, body: { message: 'A SEA DESTINATION charge line named "Wharfage Charges" already exists (key: SEA_DEST_WHARFAGE). Use that line instead of creating a near-duplicate.' } };
        return { status: 404 };
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <MemoryRouter initialEntries={["/masters/charge-catalogue/new"]}>
            <Routes>
              <Route path="/masters/charge-catalogue/new" element={<ChargeLineFormPage />} />
              <Route path="/masters/charge-catalogue" element={<p>charge catalogue list</p>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );
    await userEvent.type(await screen.findByLabelText(/^label$/i), "Wharfage Charges");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    expect(screen.queryByText("charge catalogue list")).not.toBeInTheDocument();
  });
});
