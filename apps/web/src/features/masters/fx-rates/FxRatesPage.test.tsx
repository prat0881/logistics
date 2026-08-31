import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

function renderPage(role: string) {
  vi.stubGlobal(
    "fetch",
    mockFetch((url) => {
      if (url.endsWith("/api/auth/me"))
        return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role } } };
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
  it("lists FX rates and shows a seeded INR row", async () => {
    renderPage("EXECUTIVE");
    // The Add-rate <select> also renders an "INR" <option> on the old inline form, so scope to
    // the table cell — now moot since the form moved off this page, but scoping stays correct.
    await waitFor(() => expect(screen.getByRole("cell", { name: "INR" })).toBeInTheDocument());
    expect(screen.getByText("83.12")).toBeInTheDocument();
    expect(screen.getByText("RBI reference rate")).toBeInTheDocument();
  });

  it("offers a New FX rate link for a writer and no inline add form", async () => {
    renderPage("MANAGER");
    expect(await screen.findByRole("link", { name: /new fx rate/i })).toHaveAttribute(
      "href",
      "/masters/fx-rates/new",
    );
    expect(screen.queryByRole("form", { name: /add rate form/i })).not.toBeInTheDocument();
  });

  it("hides the New FX rate link from a non-writer", async () => {
    renderPage("EXECUTIVE");
    // role EXECUTIVE — await the table first, then assert the link is absent, so this doesn't
    // race AuthProvider resolving the role before the gated UI has a chance to render.
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /new fx rate/i })).not.toBeInTheDocument();
  });
});
