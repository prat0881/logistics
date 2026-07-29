import { describe, it, expect, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";
import { FfPortalPage } from "./FfPortalPage";

afterEach(() => vi.unstubAllGlobals());

const renderAt = (token: string) =>
  renderWithProviders(
    <Routes>
      <Route path="/ff/rfq/:token" element={<FfPortalPage />} />
    </Routes>,
    { route: `/ff/rfq/${token}` },
  );

const okRfq = {
  rfqNumber: "R-1",
  incoterms: "FOB",
  submissionDeadline: "2999-01-01T00:00:00.000Z",
  currency: "USD",
  quoteValidityUntil: "2999-02-01T00:00:00.000Z",
  freightForwarder: { companyName: "Acme" },
  legs: [],
};

describe("FfPortalPage terminal states", () => {
  it("shows the invalid-token card on 401", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) =>
        url.includes("/api/ff/rfq/")
          ? { status: 401, body: {} }
          : { status: 401 },
      ),
    );
    renderAt("bad");
    expect(await screen.findByText(/invalid or has expired/i)).toBeInTheDocument();
  });

  it("renders the shell when loaded", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) =>
        url.includes("/api/ff/rfq/tok")
          ? { status: 200, body: okRfq }
          : { status: 401 },
      ),
    );
    renderAt("tok");
    expect(await screen.findByText(/Acme/)).toBeInTheDocument();
  });

  it("shows the expired banner when the deadline is past", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) =>
        url.includes("/api/ff/rfq/tok")
          ? {
              status: 200,
              body: { ...okRfq, submissionDeadline: "2000-01-01T00:00:00.000Z" },
            }
          : { status: 401 },
      ),
    );
    renderAt("tok");
    expect(await screen.findByText(/deadline has passed/i)).toBeInTheDocument();
  });
});

describe("FfPortalPage loading state", () => {
  it("shows a loading indicator while the rfq is being fetched", async () => {
    let resolve: (v: unknown) => void;
    const pending = new Promise((res) => { resolve = res; });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => pending),
    );
    renderAt("tok");
    // The loading spinner/status should be visible before fetch resolves
    expect(screen.getByRole("status")).toBeInTheDocument();
    // Clean up by resolving the promise
    resolve!({
      ok: true,
      status: 200,
      json: () => Promise.resolve(okRfq),
      text: () => Promise.resolve(JSON.stringify(okRfq)),
    });
  });
});

describe("usePortalHead integration", () => {
  it("sets the document title to the portal title", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) =>
        url.includes("/api/ff/rfq/tok")
          ? { status: 200, body: okRfq }
          : { status: 401 },
      ),
    );
    renderAt("tok");
    await waitFor(() => {
      expect(document.title).toBe("Request for quote · Svyft Logistics");
    });
  });
});
