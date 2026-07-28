import { describe, it, expect, vi, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";
import { Routes, Route } from "react-router-dom";
import { QueryWorkspaceHub } from "./QueryWorkspaceHub";

afterEach(() => vi.unstubAllGlobals());

describe("QueryWorkspaceHub", () => {
  it("renders the rail + RFQ workspace for the routed query id", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.endsWith("/api/queries/q1"))
        return { status: 200, body: { id: "q1", queryCode: "YAL26-0001", status: "RFQ_READY",
          incoterms: "FOB", freightMode: [], origin: [], destination: [], cargo: [], points: [], legs: [] } };
      if (url.includes("/rfq-state")) return { status: 200, body: { quotes: [], rfqs: [], freightForwarders: [] } };
      return { status: 404 };
    }));
    renderWithProviders(
      <Routes><Route path="/queries/:id/workspace" element={<QueryWorkspaceHub />} /></Routes>,
      { route: "/queries/q1/workspace", user: { id: "u1", name: "Exec", email: "e@x.com", role: "EXECUTIVE" } },
    );
    expect(await screen.findByText("YAL26-0001")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /create/i })).toHaveAttribute("href", "/queries/q1");
  });
});
