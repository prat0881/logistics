import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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

  it("keeps the submitted category and variant in sync with what is displayed after changing mode twice", async () => {
    // Regression test for a real bug found in review: selecting a category/variant under one
    // mode, then changing Mode twice, left react-hook-form's internally-validated value stuck
    // on the stale, now-invalid selection while the <select> itself visually fell back to some
    // in-range option (the browser's own reaction to its selected <option> disappearing) — so
    // Save silently did nothing (a validation error with no rendered message for these two
    // fields). Proves the fix: what's displayed is exactly what gets POSTed.
    // Does not use the shared renderForm() helper — it re-stubs global fetch with its own
    // narrower handler, which would silently overwrite the POST-capturing mock below.
    const posts: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me"))
          return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "ADMINISTRATOR" } } };
        if (url.endsWith("/api/charge-line-definitions/admin"))
          return { status: 200, body: [] };
        if (url.endsWith("/api/charge-line-definitions") && init?.method === "POST") {
          posts.push(JSON.parse(init.body as string));
          return { status: 201, body: { id: "new-id" } };
        }
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
    await userEvent.selectOptions(await screen.findByLabelText(/mode/i), "AIR");
    await userEvent.selectOptions(screen.getByLabelText(/category/i), "DESTINATION");
    await userEvent.selectOptions(screen.getByLabelText(/variant/i), "DIRECT");
    // Second mode change: Road has neither Destination (category) nor Direct (variant) —
    // both selections above become invalid the moment this fires.
    await userEvent.selectOptions(screen.getByLabelText(/mode/i), "ROAD");

    const displayedCategory = (screen.getByLabelText(/category/i) as HTMLSelectElement).value;
    const displayedVariant = (screen.getByLabelText(/variant/i) as HTMLSelectElement).value;
    expect(["FREIGHT", "ADDITIONAL"]).toContain(displayedCategory);
    expect(["DEDICATED", "GROUPAGE", "BOTH"]).toContain(displayedVariant);

    await userEvent.type(screen.getByLabelText(/^label$/i), "Mode Switch Regression");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].category).toBe(displayedCategory);
    expect(posts[0].variant).toBe(displayedVariant);
    expect(posts[0].mode).toBe("ROAD");
  });

  it("offers only the two input types resolveChargeConfig actually surfaces", async () => {
    renderForm();
    const select = await screen.findByLabelText(/input type/i);
    const values = within(select).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(["PLAIN", "HEAVY_WEIGHT_CALC"]);
  });

  it("renders an existing TRUCKING line's input type read-only with an explanation", async () => {
    const TRUCKING_LINE = { ...EXISTING_LINE, id: "trucking-id", key: "ROAD_CORE_TRUCKING", inputType: "TRUCKING" };
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me"))
          return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "ADMINISTRATOR" } } };
        if (url.endsWith("/api/charge-line-definitions/admin") && (!init || init.method === undefined || init.method === "GET"))
          return { status: 200, body: [TRUCKING_LINE] };
        return { status: 404 };
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <MemoryRouter initialEntries={["/masters/charge-catalogue/trucking-id"]}>
            <Routes>
              <Route path="/masters/charge-catalogue/:id" element={<ChargeLineFormPage />} />
              <Route path="/masters/charge-catalogue" element={<p>charge catalogue list</p>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );
    // The row's generated key also contains "TRUCKING" (ROAD_CORE_TRUCKING), so this asserts
    // against the read-only input-type label specifically rather than a bare /trucking/i,
    // which would match both and throw "multiple elements found".
    expect(await screen.findByText(/trucking \(type/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/input type/i)).not.toBeInTheDocument();
    expect(screen.getByText(/prices through the portal's rate rows/i)).toBeInTheDocument();
  });

  it("has no Sort order field", async () => {
    renderForm();
    await screen.findByLabelText(/label/i);
    expect(screen.queryByLabelText(/sort order/i)).not.toBeInTheDocument();
  });

  it("does not send sortOrder on save", async () => {
    const patchBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me"))
          return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "ADMINISTRATOR" } } };
        if (url.endsWith("/api/charge-line-definitions/admin") && (!init || init.method === undefined || init.method === "GET"))
          return { status: 200, body: [EXISTING_LINE] };
        if (url.endsWith(`/api/charge-line-definitions/${EXISTING_LINE.id}`) && init?.method === "PATCH") {
          patchBodies.push(JSON.parse(init.body as string));
          return { status: 200, body: {} };
        }
        return { status: 404 };
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <MemoryRouter initialEntries={[`/masters/charge-catalogue/${EXISTING_LINE.id}`]}>
            <Routes>
              <Route path="/masters/charge-catalogue/:id" element={<ChargeLineFormPage />} />
              <Route path="/masters/charge-catalogue" element={<p>charge catalogue list</p>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );
    await screen.findByLabelText(/^label$/i);
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).not.toHaveProperty("sortOrder");
  });
});
