import type { ReactNode } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider, useAuth } from "@/features/auth/AuthProvider";
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

// A tiny probe reading the same AuthProvider context useCanWrite() reads, so a test can prove
// auth has actually settled to a specific role before asserting on role-gated UI. FxRatesPage
// itself renders nothing that depends on auth having *loaded* — only on the resolved role — and
// its FX table comes from an independent useFxRatesList() query that can resolve before or after
// /api/auth/me regardless of role. Neither the table nor "nothing rendered yet" proves settlement
// for a non-writer; this does, because it only shows the resolved role once loading is false.
function AuthSettled() {
  const { loading, user } = useAuth();
  return <p>{loading ? "auth loading" : `auth role: ${user?.role ?? "none"}`}</p>;
}

function renderPage(role: string, extra?: ReactNode) {
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
          {extra}
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
    const { container } = renderPage("MANAGER");
    expect(await screen.findByRole("link", { name: /new fx rate/i })).toHaveAttribute(
      "href",
      "/masters/fx-rates/new",
    );
    // AddRateForm and its aria-label="Add rate form" are gone entirely — querying for that label
    // can only ever return null, proving nothing. Assert there is no <form> at all instead:
    // FxRatesPage is a pure list+link page, so this fails if an inline add form ever came back.
    expect(container.querySelector("form")).not.toBeInTheDocument();
  });

  it("hides the New FX rate link from a non-writer", async () => {
    renderPage("EXECUTIVE", <AuthSettled />);
    // Await the probe, not the table: the table can resolve before /api/auth/me regardless of
    // role, and useCanWrite() defaults to false while auth is still loading too — so "no link"
    // is indistinguishable from "not settled yet" unless something proves the EXECUTIVE role was
    // actually evaluated. This waits for that proof, then asserts the link stays absent.
    expect(await screen.findByText("auth role: EXECUTIVE")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /new fx rate/i })).not.toBeInTheDocument();
  });
});
