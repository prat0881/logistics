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
    // RFQ_READY is before both later gates — neither step is navigable yet.
    expect(screen.queryByRole("link", { name: /quotes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /award/i })).not.toBeInTheDocument();
  });

  // 🔴 Final review CRITICAL #2 — this rail passed ONLY `rfqEnabled`, so its Quotes and Award steps
  // both rendered with `to: undefined` regardless of the query's status: from the RFQ workspace
  // there was no way forward at all, and the S5.8 quotation builder had no entry point anywhere.
  it("links the Quotes and Award steps once the query has reached QUOTING_CLIENT", async () => {
    renderHub("QUOTING_CLIENT");
    expect(await screen.findByText("YAL26-0001")).toBeInTheDocument();

    expect(screen.getByRole("link", { name: /quotes/i })).toHaveAttribute(
      "href",
      "/queries/q1/compare",
    );
    expect(screen.getByRole("link", { name: /award/i })).toHaveAttribute(
      "href",
      "/queries/q1/quotation",
    );
  });
});
