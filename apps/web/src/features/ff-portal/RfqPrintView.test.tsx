import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { FfPortalRfqDto, FfPortalLegDto, ManifestSnapshotCargo } from "@svyft/shared";
import { RfqPrintView } from "./RfqPrintView";

const pkg: ManifestSnapshotCargo = {
  packageId: "pk1",
  packageNo: "PK-1",
  packageType: "CRATE",
  packageCount: 2,
  dimL: "120",
  dimW: "100",
  dimH: "80",
  netWt: "900",
  grossWt: "1500",
  volumeCbm: "2.5",
  tags: ["DG"],
};

const leg: FfPortalLegDto = {
  legId: "L1",
  quoteId: "Q1",
  status: "RFQ_SENT",
  mode: "AIR",
  manifest: {
    legId: "L1",
    legCode: "LEG-01",
    legName: null,
    mode: "AIR",
    incoterms: null,
    origin: { name: "Origin WH", city: "Mumbai", country: "IN" },
    destination: { name: "Dest Airport", city: "Dubai", country: "AE" },
    readyDate: null,
    targetDelivery: null,
    cargo: [pkg],
    frozenAt: "2026-08-01T00:00:00.000Z",
  },
  endpoints: [],
  seededCharges: [
    {
      zone: "ORIGIN",
      definitionKey: "AIR_ORIGIN_THC",
      inputType: "PLAIN",
      presetKey: "AIR_ORIGIN_THC",
      label: "Origin THC / Airport Handling",
      isPreset: true,
      amount: null,
    },
    {
      zone: "MAIN_FREIGHT",
      definitionKey: "AIR_MAIN_FREIGHT",
      inputType: "PLAIN",
      presetKey: "AIR_MAIN_FREIGHT",
      label: "Air Freight",
      isPreset: true,
      amount: null,
    },
  ],
  warehouseIncluded: true,
  draft: null,
};

const roadLeg: FfPortalLegDto = {
  ...leg,
  legId: "L2",
  quoteId: "Q2",
  mode: "ROAD",
  manifest: { ...leg.manifest, legId: "L2", legCode: "LEG-02", mode: "ROAD", cargo: [] },
  seededCharges: [], // ROAD legs seed via `endpoints`/trucking, not `seededCharges`
};

const rfq: FfPortalRfqDto = {
  rfqNumber: "R-99",
  incoterms: "FOB",
  submissionDeadline: "2026-09-01T12:00:00.000Z",
  currency: "USD",
  quoteValidityUntil: "2026-09-15T00:00:00.000Z",
  freightForwarder: { companyName: "Acme Freight" },
  legs: [leg],
};

describe("RfqPrintView", () => {
  it("renders the RFQ header — number, company, incoterms, currency", () => {
    render(<RfqPrintView rfq={rfq} />);
    expect(screen.getByText("R-99")).toBeInTheDocument();
    expect(screen.getByText("Acme Freight")).toBeInTheDocument();
    expect(screen.getByText("FOB")).toBeInTheDocument();
    expect(screen.getByText("USD")).toBeInTheDocument();
  });

  it("renders the leg code, mode, and masked origin/destination (name · city · country)", () => {
    render(<RfqPrintView rfq={rfq} />);
    expect(screen.getByText("LEG-01")).toBeInTheDocument();
    expect(screen.getByText("AIR")).toBeInTheDocument();
    const routeLine = screen.getByText(/Origin WH/).closest("p")!;
    expect(routeLine).toHaveTextContent("Origin WH · Mumbai · IN");
    expect(routeLine).toHaveTextContent("Dest Airport · Dubai · AE");
  });

  it("renders the leg's package list rows (reusing CargoManifestTable)", () => {
    render(<RfqPrintView rfq={rfq} />);
    const row = screen.getByText("CRATE").closest("tr")!;
    expect(within(row).getByText("2")).toBeInTheDocument(); // package count
    expect(within(row).getByText("900")).toBeInTheDocument(); // net wt
    expect(within(row).getByText("1500")).toBeInTheDocument(); // gross wt
    expect(within(row).getByLabelText("Dangerous Goods")).toBeInTheDocument();
  });

  it("renders the requested charge structure with zone + label, amounts blank", () => {
    render(<RfqPrintView rfq={rfq} />);
    expect(screen.getByText("Air Freight")).toBeInTheDocument();
    expect(screen.getByText("Origin THC / Airport Handling")).toBeInTheDocument();
    expect(screen.getByText("Main freight")).toBeInTheDocument();
    expect(screen.getByText("Origin")).toBeInTheDocument();
    // Amounts are blank "—" — this is the request document, not the FF's priced quote.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("shows an empty state for a leg with no seeded charge lines (e.g. ROAD)", () => {
    render(<RfqPrintView rfq={{ ...rfq, legs: [roadLeg] }} />);
    expect(screen.getByText(/no preset charge lines/i)).toBeInTheDocument();
  });

  it("renders a Terms & Conditions section", () => {
    render(<RfqPrintView rfq={rfq} />);
    expect(screen.getByText(/terms.*conditions/i)).toBeInTheDocument();
  });

  it("renders nothing interactive — no buttons, inputs, or checkboxes", () => {
    render(<RfqPrintView rfq={rfq} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
