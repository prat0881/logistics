import { describe, it, expect, vi, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";
import { Routes, Route } from "react-router-dom";
import { QueryWorkspaceHub } from "./QueryWorkspaceHub";

afterEach(() => vi.unstubAllGlobals());

describe("QueryWorkspaceHub", () => {
  function renderHub(status: string) {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.endsWith("/api/queries/q1"))
          return {
            status: 200,
            body: {
              id: "q1",
              queryCode: "YAL26-0001",
              status,
              incoterms: "FOB",
              freightMode: [],
              origin: [],
              destination: [],
              cargos: [],
              points: [],
              legs: [],
            },
          };
        if (url.includes("/rfq-state"))
          return { status: 200, body: { quotes: [], rfqs: [], freightForwarders: [] } };
        return { status: 404 };
      }),
    );
    return renderWithProviders(
      <Routes>
        <Route path="/queries/:id/workspace" element={<QueryWorkspaceHub />} />
      </Routes>,
      {
        route: "/queries/q1/workspace",
        user: { id: "u1", name: "Exec", email: "e@x.com", role: "EXECUTIVE" },
      },
    );
  }

  it("renders the rail + RFQ workspace for the routed query id", async () => {
    renderHub("RFQ_READY");
    expect(await screen.findByText("YAL26-0001")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /create/i })).toHaveAttribute("href", "/queries/q1");
    // RFQ_READY is before the merged Quotation step's gate (S5.9.3 P5 merged the former "Quotes"
    // and "Quotation" steps into one — RFQ_SENT+) — it is not navigable yet.
    expect(screen.queryByRole("link", { name: /quotation/i })).not.toBeInTheDocument();
  });

  // 🔴 Final review CRITICAL #2 — this rail passed ONLY `rfqEnabled`, so its Quotes and Quotation
  // steps both rendered with `to: undefined` regardless of the query's status: from the RFQ
  // workspace there was no way forward at all, and the S5.8 quotation builder had no entry point
  // anywhere. S5.9.3 P5 merged those two steps into one "Quotation" step; the case this test
  // guards — a status past both underlying gates gets a live link forward — still applies, now to
  // the single merged step's link.
  it("links the merged Quotation step to the client quotation builder once the query has reached QUOTING_CLIENT", async () => {
    renderHub("QUOTING_CLIENT");
    expect(await screen.findByText("YAL26-0001")).toBeInTheDocument();

    expect(screen.getByRole("link", { name: /quotation/i })).toHaveAttribute(
      "href",
      "/queries/q1/quotation",
    );
  });

  // S5.9.3 P5 — before the merge, a status between the two gates (RFQ_SENT..QUOTING_CLIENT-1,
  // e.g. plain QUOTED) linked "Quotes" to Compare Quotes but left "Quotation" a dead placeholder.
  // Now there is one step: it must still be navigable in that window, just pointed at Compare
  // Quotes rather than going dark until QUOTING_CLIENT.
  it("links the merged Quotation step to Compare Quotes for a status past RFQ_SENT but before the client-quotation gate", async () => {
    renderHub("QUOTED");
    expect(await screen.findByText("YAL26-0001")).toBeInTheDocument();

    expect(screen.getByRole("link", { name: /quotation/i })).toHaveAttribute(
      "href",
      "/queries/q1/compare",
    );
  });
});
