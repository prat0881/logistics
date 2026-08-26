import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { WarehouseFormPage } from "./WarehouseFormPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

function renderForm() {
  vi.stubGlobal(
    "fetch",
    mockFetch((url, init) => {
      if (url.endsWith("/api/auth/me"))
        return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } } };
      if (url.endsWith("/api/warehouses") && init?.method === "POST") {
        return { status: 201, body: { id: "w9", name: "Owned DC" } };
      }
      return { status: 404 };
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={["/masters/warehouses/new"]}>
          <Routes>
            <Route path="/masters/warehouses/new" element={<WarehouseFormPage />} />
            <Route path="/masters/warehouses" element={<p>warehouses list</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("WarehouseFormPage (create)", () => {
  it("shows agreement and insurance dates only for owned and contracted warehouses", async () => {
    renderForm();
    await screen.findByLabelText(/type of warehouse/i);
    expect(screen.queryByLabelText(/agreement valid until/i)).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/type of warehouse/i), "OWNED");
    expect(screen.getByLabelText(/agreement valid until/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/insurance valid until/i)).toBeInTheDocument();
  });

  it("reports the missing agreement date rather than silently failing", async () => {
    renderForm();
    await userEvent.selectOptions(await screen.findByLabelText(/type of warehouse/i), "OWNED");
    await userEvent.type(screen.getByLabelText(/warehouse name/i), "Owned DC");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/required for owned and contracted/i);
  });

  it("submits a valid owned warehouse and navigates to the list", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me"))
          return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } } };
        if (url.endsWith("/api/warehouses") && init?.method === "POST") {
          body = JSON.parse(init.body as string);
          return { status: 201, body: { id: "w9", name: "Owned DC" } };
        }
        return { status: 404 };
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <MemoryRouter initialEntries={["/masters/warehouses/new"]}>
            <Routes>
              <Route path="/masters/warehouses/new" element={<WarehouseFormPage />} />
              <Route path="/masters/warehouses" element={<p>warehouses list</p>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );
    await userEvent.selectOptions(await screen.findByLabelText(/type of warehouse/i), "CLIENT");
    await userEvent.type(screen.getByLabelText(/warehouse name/i), "Client DC");
    await userEvent.type(screen.getByLabelText(/street address/i), "1 Dock Road");
    await userEvent.type(screen.getByLabelText(/^country$/i), "United Arab Emirates");
    await userEvent.type(screen.getByLabelText(/^city$/i), "Dubai");
    await userEvent.type(screen.getByLabelText(/pin ?code/i), "00000");
    await userEvent.type(screen.getByLabelText(/capacity$/i), "500");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText("warehouses list")).toBeInTheDocument());
    expect(body).toMatchObject({ name: "Client DC", type: "CLIENT" });
  });
});
