import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { FxRatesPage } from "./FxRatesPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

const SEEDED_RATE = {
  id: "fx1",
  currency: "INR",
  unitsPerUsd: 83.12,
  effectiveFrom: "2026-08-01T00:00:00.000Z",
  note: "RBI reference rate",
  createdById: "u1",
  createdAt: "2026-08-01T00:00:00.000Z",
};

function renderPage(role: string, onCreateCall?: (body: Record<string, unknown>) => void) {
  vi.stubGlobal(
    "fetch",
    mockFetch((url, init) => {
      if (url.endsWith("/api/auth/me"))
        return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role } } };
      if (url.endsWith("/api/fx-rates") && init?.method === "POST") {
        const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
        onCreateCall?.(body);
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
      if (url.endsWith("/api/fx-rates")) return { status: 200, body: [SEEDED_RATE] };
      return { status: 404 };
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter>
          <FxRatesPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("FxRatesPage", () => {
  it("lists FX rates and shows a seeded INR row, with no Add-rate form for an Executive", async () => {
    renderPage("EXECUTIVE");
    // The Add-rate <select> also renders an "INR" <option>, so scope to the table cell.
    await waitFor(() => expect(screen.getByRole("cell", { name: "INR" })).toBeInTheDocument());
    expect(screen.getByText("83.12")).toBeInTheDocument();
    expect(screen.getByText("RBI reference rate")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add rate/i })).not.toBeInTheDocument();
  });

  it("submits a new rate as a Manager and posts the exact body to POST /api/fx-rates", async () => {
    const calls: Record<string, unknown>[] = [];
    renderPage("MANAGER", (body) => calls.push(body));
    // The FX list and /api/auth/me resolve independently, and the Add-rate form is gated on the
    // role from auth — so waiting for the table proves nothing about the form. Wait for the form.
    await userEvent.selectOptions(await screen.findByLabelText(/currency/i), "INR");
    await userEvent.type(screen.getByLabelText(/units\/usd/i), "83.2");
    await userEvent.click(screen.getByRole("button", { name: /add rate/i }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ currency: "INR", unitsPerUsd: 83.2 });
  });
});
