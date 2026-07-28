import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { QueryDetail } from "@svyft/shared";
import { QueryOverviewHeader } from "./QueryOverviewHeader";

const query = {
  queryCode: "YAL26-0001",
  incoterms: "FOB",
  status: "RFQ_SENT",
  freightMode: ["AIR", "ROAD"],
  origin: [{ id: "p1", name: "Shanghai Port", city: "Shanghai", country: "CN" }],
  destination: [{ id: "p2", name: null, city: "Dubai", country: "AE" }],
  legs: [
    { rollup: { totalPackages: 3, totalCbm: 12, totalGrossWt: 500, totalNetWt: 400 } },
    { rollup: { totalPackages: 2, totalCbm: 8, totalGrossWt: 300, totalNetWt: 250 } },
  ],
} as unknown as QueryDetail;

describe("QueryOverviewHeader", () => {
  it("shows the query code, modes, rolled-up totals and status", () => {
    render(<QueryOverviewHeader query={query} />);
    expect(screen.getByText("YAL26-0001")).toBeInTheDocument();
    expect(screen.getByText("AIR")).toBeInTheDocument();
    expect(screen.getByText("RFQ Sent")).toBeInTheDocument();
    expect(screen.getByText(/5 pkg/i)).toBeInTheDocument();   // 3 + 2 packages
    expect(screen.getByText(/Shanghai Port/)).toBeInTheDocument();
    expect(screen.getByText(/Dubai/)).toBeInTheDocument();
  });
});
