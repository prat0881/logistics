import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider } from "react-hook-form";
import type { QuoteDraft, QuoteDraftCharge, FfPortalSeededCharge } from "@svyft/shared";
import { ChargeZonePanel } from "./ChargeZonePanel";

// Shaped like real seeded lines (ff-portal.service.ts's resolveScope): definitionKey set,
// presetKey always null — isPreset is definitionKey-based (ChargeZonePanel.tsx), not presetKey.
const baseCharges: QuoteDraftCharge[] = [
  { zone: "ORIGIN", definitionKey: "AIR_ORIGIN_THC", presetKey: null, label: "Origin THC", amount: null },
  { zone: "MAIN_FREIGHT", definitionKey: "AIR_MAIN_FREIGHT", presetKey: null, label: "Air Freight", amount: null },
];

function Harness({
  charges = baseCharges,
  seededCharges = [],
}: {
  charges?: QuoteDraftCharge[];
  seededCharges?: FfPortalSeededCharge[];
}) {
  const form = useForm<QuoteDraft>({ defaultValues: {
    legId: "L1", mode: "AIR", currency: "USD", quoteValidityUntil: null, cargo: [],
    charges,
    trucking: [], warehouse: [], transit: null, dgSurchargeNote: null, termsConditions: null } });
  return <FormProvider {...form}><ChargeZonePanel seededCharges={seededCharges} /></FormProvider>;
}

describe("ChargeZonePanel", () => {
  it("shows preset lines grouped by zone and a live origin subtotal", async () => {
    render(<Harness />);
    expect(screen.getByText("Origin THC")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/amount.*Origin THC/i), "500");
    const origin = screen.getByTestId("zone-subtotal-ORIGIN");
    expect(within(origin).getByText("500.00")).toBeInTheDocument();
  });
  it("adds a custom line to a zone", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: /add line.*origin/i }));
    expect(screen.getAllByDisplayValue("Custom charge").length).toBe(1);
  });
  it("custom line amount updates zone subtotal via absolute index binding", async () => {
    render(<Harness />);
    // Append a custom line to MAIN_FREIGHT (it will sit at absolute index 2)
    await userEvent.click(screen.getByRole("button", { name: /add line.*main freight/i }));
    // Type into the custom line's amount field — label is "Custom charge"
    const amountInputs = screen.getAllByLabelText(/amount.*Custom charge/i);
    await userEvent.type(amountInputs[0], "250");
    const mainFreightSubtotal = screen.getByTestId("zone-subtotal-MAIN_FREIGHT");
    expect(within(mainFreightSubtotal).getByText("250.00")).toBeInTheDocument();
  });
});

// ── Task 14: seeded-line rendering routed by inputType (Air FSC/Peak + Heavy-Weight calc) ──
const airMainCharges: QuoteDraftCharge[] = [
  { zone: "MAIN_FREIGHT", definitionKey: "AIR_MAIN_FSC", presetKey: null, label: "Fuel Surcharge (FSC)", amount: null },
  { zone: "MAIN_FREIGHT", definitionKey: "AIR_MAIN_PEAK_SEASON", presetKey: null, label: "Peak Season Surcharge", amount: null },
  {
    zone: "MAIN_FREIGHT", definitionKey: "AIR_MAIN_HEAVY_WEIGHT", presetKey: null,
    label: "Heavy Weight Surcharge", amount: null,
    pieceWeightKg: null, airlineLimitKg: null, ratePerExcessKg: null,
  },
];

// Mirrors what ff-portal.service.ts's resolveScope actually seeds (definitionKey + inputType;
// presetKey is always null on catalogue lines — kept only for shape compatibility).
const airMainSeeded: FfPortalSeededCharge[] = [
  { zone: "MAIN_FREIGHT", definitionKey: "AIR_MAIN_FSC", inputType: "PLAIN", presetKey: null, label: "Fuel Surcharge (FSC)", isPreset: true, amount: null },
  { zone: "MAIN_FREIGHT", definitionKey: "AIR_MAIN_PEAK_SEASON", inputType: "PLAIN", presetKey: null, label: "Peak Season Surcharge", isPreset: true, amount: null },
  { zone: "MAIN_FREIGHT", definitionKey: "AIR_MAIN_HEAVY_WEIGHT", inputType: "HEAVY_WEIGHT_CALC", presetKey: null, label: "Heavy Weight Surcharge", isPreset: true, amount: null },
];

describe("ChargeZonePanel — seeded inputType routing (Task 14)", () => {
  it("renders FSC and Peak (PLAIN) as normal priceable amount rows", () => {
    render(<Harness charges={airMainCharges} seededCharges={airMainSeeded} />);
    expect(screen.getByLabelText(/amount for fuel surcharge/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/amount for peak season surcharge/i)).toBeInTheDocument();
  });

  it("renders the HEAVY_WEIGHT_CALC line as 3 calc inputs, not a single amount field", () => {
    render(<Harness charges={airMainCharges} seededCharges={airMainSeeded} />);
    expect(screen.getByLabelText(/piece weight.*heavy weight surcharge/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/airline limit.*heavy weight surcharge/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/rate per excess kg.*heavy weight surcharge/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^amount for heavy weight surcharge$/i)).toBeNull();
  });

  it("zone subtotal sums a priced PLAIN line and the live-computed HEAVY_WEIGHT_CALC amount", async () => {
    render(<Harness charges={airMainCharges} seededCharges={airMainSeeded} />);
    await userEvent.type(screen.getByLabelText(/amount for fuel surcharge/i), "100");
    await userEvent.type(screen.getByLabelText(/piece weight.*heavy weight surcharge/i), "1200");
    await userEvent.type(screen.getByLabelText(/airline limit.*heavy weight surcharge/i), "1000");
    await userEvent.type(screen.getByLabelText(/rate per excess kg.*heavy weight surcharge/i), "2");
    const subtotal = screen.getByTestId("zone-subtotal-MAIN_FREIGHT");
    // FSC 100 + Peak (unpriced → 0) + Heavy Weight computed (1200 − 1000) × 2 = 400 ⇒ 500
    expect(within(subtotal).getByText("500.00")).toBeInTheDocument();
  });

  // isPreset must be definitionKey-based, not presetKey-based (presetKey is always null on
  // catalogue lines now — see FfPortalSeededCharge — so a presetKey check would wrongly treat
  // every seeded line as "custom"). Pins the fix against regressing back to presetKey.
  it("renders a seeded PLAIN line's label as read-only text, not an editable input", () => {
    render(<Harness charges={airMainCharges} seededCharges={airMainSeeded} />);
    expect(screen.getByText("Fuel Surcharge (FSC)")).toBeInTheDocument();
    expect(screen.getByText("Peak Season Surcharge")).toBeInTheDocument();
    // Every row in this fixture is a seeded catalogue line — no editable label input anywhere.
    expect(screen.queryByLabelText("Custom line label")).toBeNull();
  });

  it("renders a genuinely custom [+ Add line] row's label as an editable input", async () => {
    render(<Harness charges={airMainCharges} seededCharges={airMainSeeded} />);
    await userEvent.click(screen.getByRole("button", { name: /add line.*main freight/i }));
    expect(screen.getByLabelText("Custom line label")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Custom charge")).toBeInTheDocument();
  });
});

// ── Task 15: Sea Zone-1 Bill of Lading line gets a billOfLadingType dropdown ──
const seaOriginCharges: QuoteDraftCharge[] = [
  { zone: "ORIGIN", definitionKey: "SEA_ORIGIN_THC", presetKey: null, label: "Origin THC", amount: null },
  { zone: "ORIGIN", definitionKey: "SEA_ORIGIN_BILL_OF_LADING", presetKey: null, label: "Bill of Lading", amount: null },
];
const seaOriginSeeded: FfPortalSeededCharge[] = [
  { zone: "ORIGIN", definitionKey: "SEA_ORIGIN_THC", inputType: "PLAIN", presetKey: null, label: "Origin THC", isPreset: true, amount: null },
  { zone: "ORIGIN", definitionKey: "SEA_ORIGIN_BILL_OF_LADING", inputType: "PLAIN", presetKey: null, label: "Bill of Lading", isPreset: true, amount: null },
];

describe("ChargeZonePanel — Sea Bill of Lading dropdown (Task 15)", () => {
  it("renders a billOfLadingType Select only on the SEA_ORIGIN_BILL_OF_LADING line, alongside its amount input", () => {
    render(<Harness charges={seaOriginCharges} seededCharges={seaOriginSeeded} />);
    expect(screen.getByLabelText(/amount for bill of lading/i)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /bill of lading type for bill of lading/i })).toBeInTheDocument();
    // The other Origin line (THC) gets no B/L dropdown
    expect(screen.queryByRole("combobox", { name: /bill of lading type for origin thc/i })).toBeNull();
  });

  it("selecting a Bill of Lading type writes charges[idx].billOfLadingType", async () => {
    render(<Harness charges={seaOriginCharges} seededCharges={seaOriginSeeded} />);
    const trigger = screen.getByRole("combobox", { name: /bill of lading type for bill of lading/i });
    await userEvent.click(trigger);
    const option = screen.getByRole("option", { name: "Telex Release" });
    await userEvent.click(option);
    // charges[1] is the SEA_ORIGIN_BILL_OF_LADING line (absolute index within `charges`)
    expect(screen.getByRole("combobox", { name: /bill of lading type for bill of lading/i })).toHaveTextContent("Telex Release");
  });
});
