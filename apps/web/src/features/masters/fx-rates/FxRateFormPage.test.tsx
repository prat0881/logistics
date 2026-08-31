import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { FxRateFormPage } from "./FxRateFormPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

function renderForm() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={["/masters/fx-rates/new"]}>
          <Routes>
            <Route path="/masters/fx-rates/new" element={<FxRateFormPage />} />
            <Route path="/masters/fx-rates" element={<p>fx list</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("FxRateFormPage (create)", () => {
  it("creates a rate and returns to the list", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me"))
          return {
            status: 200,
            body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } },
          };
        if (url.endsWith("/api/fx-rates") && init?.method === "POST") {
          return {
            status: 201,
            body: {
              id: "fx2",
              currency: "INR",
              unitsPerUsd: 83.5,
              effectiveFrom: "2026-08-14T00:00:00.000Z",
              note: null,
              createdById: "u1",
              createdAt: "2026-08-14T00:00:00.000Z",
            },
          };
        }
        return { status: 404 };
      }),
    );
    renderForm();
    await userEvent.selectOptions(await screen.findByLabelText(/currency/i), "INR");
    await userEvent.type(screen.getByLabelText(/units\/usd/i), "83.5");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText("fx list")).toBeInTheDocument();
  });

  it("submits a new rate as a Manager and posts the exact body to POST /api/fx-rates", async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me"))
          return {
            status: 200,
            body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } },
          };
        if (url.endsWith("/api/fx-rates") && init?.method === "POST") {
          const body = init.body
            ? (JSON.parse(init.body as string) as Record<string, unknown>)
            : {};
          calls.push(body);
          return {
            status: 201,
            body: {
              id: "fx2",
              currency: body.currency,
              unitsPerUsd: body.unitsPerUsd,
              effectiveFrom: "2026-08-14T00:00:00.000Z",
              note: null,
              createdById: "u1",
              createdAt: "2026-08-14T00:00:00.000Z",
            },
          };
        }
        return { status: 404 };
      }),
    );
    renderForm();
    await userEvent.selectOptions(await screen.findByLabelText(/currency/i), "INR");
    await userEvent.type(screen.getByLabelText(/units\/usd/i), "83.2");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ currency: "INR", unitsPerUsd: 83.2 });
  });
});
