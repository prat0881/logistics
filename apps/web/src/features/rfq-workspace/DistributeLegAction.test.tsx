import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mockFetch } from "@/test/mock-fetch";
import { DistributeLegAction } from "./DistributeLegAction";

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
afterEach(() => vi.unstubAllGlobals());

describe("DistributeLegAction", () => {
  it("distributes and shows the minted RFQ number + portal link input", async () => {
    vi.stubGlobal("fetch", mockFetch((url, init) => {
      if (url.includes("/distribute") && init?.method === "POST")
        return { status: 201, body: { rfqs: [{ freightForwarderId: "a", rfqId: "r1", rfqNumber: "YAL26-0001-RFQ001", minted: true, accessToken: "TOK", legIds: ["l1"] }], distributedLegIds: ["l1"], skipped: [] } };
      return { status: 404 };
    }));
    wrap(<DistributeLegAction queryId="q1" legId="l1" deadlineLocal="2026-08-01T10:00" canDistribute />);
    await userEvent.click(screen.getByRole("button", { name: /^distribute rfq$/i }));
    expect(await screen.findByText(/YAL26-0001-RFQ001/)).toBeInTheDocument();
    const linkInput = await screen.findByLabelText(/portal link/i) as HTMLInputElement;
    expect(linkInput.value).toContain("/ff/rfq/TOK");
  });

  it("updated rows (no accessToken) show no portal link", async () => {
    vi.stubGlobal("fetch", mockFetch((url, init) => {
      if (url.includes("/distribute") && init?.method === "POST")
        return { status: 201, body: { rfqs: [{ freightForwarderId: "a", rfqId: "r2", rfqNumber: "YAL26-0001-RFQ002", minted: false, legIds: ["l1"] }], distributedLegIds: ["l1"], skipped: [] } };
      return { status: 404 };
    }));
    wrap(<DistributeLegAction queryId="q1" legId="l1" deadlineLocal="2026-08-01T10:00" canDistribute />);
    await userEvent.click(screen.getByRole("button", { name: /^distribute rfq$/i }));
    expect(await screen.findByText(/YAL26-0001-RFQ002/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/portal link/i)).toBeNull();
  });

  it("renders F1/F4/F5 gate codes inline on 400", async () => {
    vi.stubGlobal("fetch", mockFetch((url, init) => {
      if (url.includes("/distribute") && init?.method === "POST")
        return { status: 400, body: { message: "Leg is not ready for distribution", codes: ["F1_INCOMPLETE_LEG", "F5_DG_FF_CANNOT_HANDLE"] } };
      return { status: 404 };
    }));
    wrap(<DistributeLegAction queryId="q1" legId="l1" deadlineLocal="2026-08-01T10:00" canDistribute />);
    await userEvent.click(screen.getByRole("button", { name: /^distribute rfq$/i }));
    expect(await screen.findByText(/leg is incomplete/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot handle dangerous goods/i)).toBeInTheDocument();
  });

  it("on 409 opens a confirm dialog and resends with confirm:true", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", mockFetch((url, init) => {
      if (url.includes("/distribute") && init?.method === "POST") {
        const body = JSON.parse((init.body as string) ?? "{}");
        bodies.push(body);
        if (!body.confirm) return { status: 409, body: { message: "already sent; confirm to proceed." } };
        return { status: 201, body: { rfqs: [], distributedLegIds: [], skipped: [{ legId: "l1", reason: "already-distributed" }] } };
      }
      return { status: 404 };
    }));
    wrap(<DistributeLegAction queryId="q1" legId="l1" deadlineLocal="2026-08-01T10:00" canDistribute />);
    await userEvent.click(screen.getByRole("button", { name: /^distribute rfq$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /re-distribute/i }));
    await waitFor(() => expect(bodies.some((b) => (b as { confirm?: boolean }).confirm === true)).toBe(true));
  });
});
