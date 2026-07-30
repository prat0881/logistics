import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mockFetch } from "@/test/mock-fetch";
import { RegeneratePortalLink } from "./RegeneratePortalLink";

afterEach(() => vi.unstubAllGlobals());
const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
};

describe("RegeneratePortalLink", () => {
  it("regenerates and shows the new link + invalidation note", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ status: 200, body: { rfqId: "r", rfqNumber: "Q-1-RFQ001", freightForwarderId: "ff1", accessToken: "NEWTOK" } })));
    render(wrap(<RegeneratePortalLink queryId="q1" freightForwarderId="ff1" />));
    await userEvent.click(screen.getByRole("button", { name: /regenerate portal link/i }));
    const field = await screen.findByLabelText(/portal link/i);
    expect((field as HTMLInputElement).value).toContain("/ff/rfq/NEWTOK");
    expect(screen.getByText(/invalidates the previous link/i)).toBeInTheDocument();
  });
});
