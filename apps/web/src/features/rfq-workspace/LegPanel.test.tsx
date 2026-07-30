import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { QueryLegDto, QueryPointDto } from "@svyft/shared";
import { mockFetch } from "@/test/mock-fetch";
import { LegPanel, defaultDeadlineLocal } from "./LegPanel";

const leg = {
  id: "l1", legCode: "L1", legName: "Main air leg", mode: "AIR", status: "READY_FOR_RFQ",
  originPointId: "p1", destinationPointId: "p2", readyDate: "2026-08-01T00:00:00.000Z",
  targetDelivery: "2026-08-05T00:00:00.000Z",
  rollup: { totalPackages: 3, totalCbm: 12, totalGrossWt: 500, totalNetWt: 400 },
} as unknown as QueryLegDto;

const points = [
  { id: "p1", name: "Shanghai PVG", city: "Shanghai", country: "CN" },
  { id: "p2", name: "Dubai DXB", city: "Dubai", country: "AE" },
] as unknown as QueryPointDto[];

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

afterEach(() => vi.unstubAllGlobals());

describe("LegPanel", () => {
  it("defaultDeadlineLocal is +48h from now", () => {
    const s = defaultDeadlineLocal(Date.parse("2026-08-01T10:00:00.000Z"));
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("shows leg summary + status, and collapses the grid on toggle", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: [] };
      return { status: 404 };
    }));
    wrap(<LegPanel queryId="q1" leg={leg} points={points} legQuotes={[]} referencedFfs={[]} cargo={[]} />);
    // defaults open → header + summary + grid all visible
    expect(screen.getByText("Main air leg")).toBeInTheDocument();
    expect(screen.getByText("Ready for RFQ")).toBeInTheDocument();
    expect(screen.getByText(/Shanghai PVG/)).toBeInTheDocument();
    expect(await screen.findByText(/Eligible 0/i)).toBeInTheDocument();
    // clicking the header collapses the panel → grid hidden
    await userEvent.click(screen.getByRole("button", { name: /main air leg/i }));
    expect(screen.queryByText(/Eligible 0/i)).not.toBeInTheDocument();
  });

  it("shows kg net when totalNetWt > 0", () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: [] };
      return { status: 404 };
    }));
    const legWithNet = {
      ...leg,
      rollup: { ...leg.rollup, totalNetWt: 120 },
    } as unknown as QueryLegDto;
    wrap(<LegPanel queryId="q1" leg={legWithNet} points={points} legQuotes={[]} referencedFfs={[]} cargo={[]} />);
    expect(screen.getByText(/120 kg net/)).toBeInTheDocument();
    expect(screen.getByText(/kg gross/)).toBeInTheDocument();
  });

  it("hides kg net when totalNetWt is 0, still shows gross", () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: [] };
      return { status: 404 };
    }));
    const legZeroNet = {
      ...leg,
      rollup: { ...leg.rollup, totalNetWt: 0 },
    } as unknown as QueryLegDto;
    wrap(<LegPanel queryId="q1" leg={legZeroNet} points={points} legQuotes={[]} referencedFfs={[]} cargo={[]} />);
    expect(screen.queryByText(/kg net/)).not.toBeInTheDocument();
    expect(screen.getByText(/kg gross/)).toBeInTheDocument();
  });
});
