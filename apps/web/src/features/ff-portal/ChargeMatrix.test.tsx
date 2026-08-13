import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider, useWatch, type Control } from "react-hook-form";
import type {
  QuoteDraft,
  FfPortalSeededCharge,
  FreightMode,
  ResolvedChargeLine,
} from "@svyft/shared";
import { validateQuote, seedQuoteDraftPricing } from "@svyft/shared";
import { ChargeMatrix } from "./ChargeMatrix";

// ── Radix Select helper ──────────────────────────────────────────────────────────────────────
// Radix only keeps its hidden native <select aria-hidden="true"> (the jsdom-friendly
// form-bubbling shortcut used elsewhere in this codebase — see PackageEditor.test.tsx /
// LegEditor.test.tsx) mounted past the first render when the trigger sits inside a real <form>
// element (SelectBubbleInput's `isFormControl` check — @radix-ui/react-select's
// trigger.closest("form")). None of the ff-portal form components render an actual <form> tag
// (LegSection.tsx and siblings are plain <div>s under FormProvider), so that shortcut isn't
// available here — confirmed empirically (the hidden select unmounts after the trigger ref
// settles). Falls back to the same click-through-the-popover approach already proven reliable for
// these exact Select instances by TruckingBlocks.test.tsx / SeaChargesPanel.test.tsx /
// ChargeZonePanel.test.tsx (this codebase's jsdom setup polyfills the pointer-capture/
// scrollIntoView APIs Radix needs — see src/test/setup.ts).
async function selectOption(triggerName: RegExp, optionName: string): Promise<void> {
  await userEvent.click(screen.getByRole("combobox", { name: triggerName }));
  await userEvent.click(screen.getByRole("option", { name: optionName }));
}

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────
function baseDraft(mode: FreightMode | null): QuoteDraft {
  return {
    legId: "L1",
    mode,
    currency: "USD",
    quoteValidityUntil: null,
    chargedWeightKg: null,
    notes: null,
    cargo: [],
    charges: [],
    trucking: [],
    seaRates: [],
    warehouse: [],
    transit: { departureDate: null, arrivalDate: null, guaranteedTransitDaysByVariant: {} },
    dgSurchargeNote: null,
    termsConditions: null,
  };
}

const ROAD_LINES: FfPortalSeededCharge[] = [
  {
    zone: null,
    definitionKey: "ROAD_STD_TAIL_LIFT",
    inputType: "PLAIN",
    presetKey: null,
    label: "Tail-lift / lift-gate",
    isPreset: true,
    amount: null,
  },
  {
    zone: null,
    definitionKey: "ROAD_STD_INSURANCE",
    inputType: "PLAIN",
    presetKey: null,
    label: "Insurance",
    isPreset: true,
    amount: null,
  },
];

// v4 (design D1): every `charges` row is COMMON — ONE row per definitionKey, `rateVariant: null`,
// regardless of mode. Freight is the one thing that stays per-variant, and it never lived in this
// array — Road prices it via `trucking`, seeded separately below.
function roadDraft(): QuoteDraft {
  const d = baseDraft("ROAD");
  d.charges = ROAD_LINES.map((s) => ({
    zone: s.zone,
    definitionKey: s.definitionKey,
    presetKey: null,
    label: s.label,
    amount: null,
    rateVariant: null,
  }));
  d.trucking = (["DEDICATED", "GROUPAGE"] as const).map((rv) => ({
    legEndpointPointId: "p1",
    truckingType: rv,
    basis: "PER_TRUCK" as const,
    amount: null,
    rateVariant: rv,
    tonnage: null,
  }));
  return d;
}

const SEA_LINES: FfPortalSeededCharge[] = [
  {
    zone: "ORIGIN",
    definitionKey: "SEA_ORIGIN_THC",
    inputType: "PLAIN",
    presetKey: null,
    label: "Origin THC",
    isPreset: true,
    amount: null,
  },
  {
    zone: "ORIGIN",
    definitionKey: "SEA_ORIGIN_BILL_OF_LADING",
    inputType: "PLAIN",
    presetKey: null,
    label: "Bill of Lading",
    isPreset: true,
    amount: null,
  },
];

function seaDraft(): QuoteDraft {
  const d = baseDraft("SEA");
  d.charges = SEA_LINES.map((s) => ({
    zone: s.zone,
    definitionKey: s.definitionKey,
    presetKey: null,
    label: s.label,
    amount: null,
    rateVariant: null,
    billOfLadingType: null,
  }));
  d.seaRates = (["FCL", "LCL"] as const).map((rv) => ({
    rateVariant: rv,
    containerSize: null,
    amount: null,
  }));
  return d;
}

const AIR_LINES: FfPortalSeededCharge[] = [
  {
    zone: "MAIN_FREIGHT",
    definitionKey: "AIR_MAIN_FREIGHT",
    inputType: "PLAIN",
    presetKey: null,
    label: "Air Freight",
    isPreset: true,
    amount: null,
  },
  {
    zone: "MAIN_FREIGHT",
    definitionKey: "AIR_MAIN_HEAVY_WEIGHT",
    inputType: "HEAVY_WEIGHT_CALC",
    presetKey: null,
    label: "Heavy Weight Surcharge",
    isPreset: true,
    amount: null,
  },
];

// Air's charges were ALREADY common in v3 (its single implicit column never fanned out) — this
// fixture is unchanged by the v4 model.
function airDraft(): QuoteDraft {
  const d = baseDraft("AIR");
  d.charges = AIR_LINES.map((s) => ({
    zone: s.zone,
    definitionKey: s.definitionKey,
    presetKey: null,
    label: s.label,
    amount: null,
    rateVariant: null,
    ...(s.inputType === "HEAVY_WEIGHT_CALC"
      ? { pieceWeightKg: null, airlineLimitKg: null, ratePerExcessKg: null }
      : {}),
  }));
  return d;
}

// ── Harness ───────────────────────────────────────────────────────────────────────────────────
function ChargesDebug({ control }: { control: Control<QuoteDraft> }) {
  const rows = useWatch({ control, name: "charges" });
  return <div data-testid="charges-debug">{JSON.stringify(rows)}</div>;
}
function TruckingDebug({ control }: { control: Control<QuoteDraft> }) {
  const rows = useWatch({ control, name: "trucking" });
  return <div data-testid="trucking-debug">{JSON.stringify(rows)}</div>;
}
function SeaRatesDebug({ control }: { control: Control<QuoteDraft> }) {
  const rows = useWatch({ control, name: "seaRates" });
  return <div data-testid="sea-rates-debug">{JSON.stringify(rows)}</div>;
}

function Harness({
  seededCharges,
  defaultValues,
  mode,
  withDebug = false,
}: {
  seededCharges: FfPortalSeededCharge[];
  defaultValues: QuoteDraft;
  mode: FreightMode | null;
  withDebug?: boolean;
}) {
  const form = useForm<QuoteDraft>({ defaultValues });
  return (
    <FormProvider {...form}>
      <ChargeMatrix seededCharges={seededCharges} mode={mode} />
      {withDebug && (
        <>
          <ChargesDebug control={form.control} />
          <TruckingDebug control={form.control} />
          <SeaRatesDebug control={form.control} />
        </>
      )}
    </FormProvider>
  );
}

function chargesFrom(debug: HTMLElement): QuoteDraft["charges"] {
  return JSON.parse(debug.textContent ?? "[]") as QuoteDraft["charges"];
}
function truckingFrom(debug: HTMLElement): QuoteDraft["trucking"] {
  return JSON.parse(debug.textContent ?? "[]") as QuoteDraft["trucking"];
}

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────
describe("ChargeMatrix — Road (Dedicated/Groupage columns)", () => {
  it("renders the header row, one row per seeded line, and the freight row", () => {
    render(<Harness seededCharges={ROAD_LINES} defaultValues={roadDraft()} mode="ROAD" />);
    expect(screen.getByRole("columnheader", { name: "Charge" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Dedicated" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Groupage" })).toBeInTheDocument();
    expect(screen.getByText("Tail-lift / lift-gate")).toBeInTheDocument();
    expect(screen.getByText("Insurance")).toBeInTheDocument();
    expect(screen.getByText("Road Freight")).toBeInTheDocument();
  });

  // design D1 / Step-1(a): every common charge row is now ONE field spanning the variant
  // columns, not one field per column — the core visual/structural change of this task.
  it("renders each common charge as a SINGLE amount input, not one per variant column", () => {
    render(<Harness seededCharges={ROAD_LINES} defaultValues={roadDraft()} mode="ROAD" />);
    expect(screen.getAllByLabelText(/^insurance$/i)).toHaveLength(1);
    expect(screen.getAllByLabelText(/^tail-lift \/ lift-gate$/i)).toHaveLength(1);
  });

  it("still renders the freight row with SEPARATE Dedicated/Groupage inputs (freight stays per-variant)", () => {
    render(<Harness seededCharges={ROAD_LINES} defaultValues={roadDraft()} mode="ROAD" />);
    expect(screen.getByLabelText(/^road freight — dedicated$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^road freight — groupage$/i)).toBeInTheDocument();
  });

  it("entering an amount updates only that charge line's cell, not a sibling line's", async () => {
    render(
      <Harness seededCharges={ROAD_LINES} defaultValues={roadDraft()} mode="ROAD" withDebug />,
    );
    // Anchored (^...$): the per-cell "Note for Insurance" sibling field would also match an
    // unanchored /insurance/i query, making it ambiguous.
    await userEvent.type(screen.getByLabelText(/^insurance$/i), "75");

    const charges = chargesFrom(screen.getByTestId("charges-debug"));
    const insurance = charges.find((c) => c.definitionKey === "ROAD_STD_INSURANCE");
    const tailLift = charges.find((c) => c.definitionKey === "ROAD_STD_TAIL_LIFT");
    expect(insurance?.amount).toBe(75);
    expect(tailLift?.amount).toBeNull();
  });

  it("binds the freight row to trucking[] with a Tonnage Select on the Dedicated cell only", async () => {
    render(
      <Harness seededCharges={ROAD_LINES} defaultValues={roadDraft()} mode="ROAD" withDebug />,
    );
    expect(screen.getByRole("combobox", { name: /tonnage — dedicated/i })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /tonnage — groupage/i })).toBeNull();

    await userEvent.type(screen.getByLabelText(/road freight — dedicated/i), "5000");
    let trucking = truckingFrom(screen.getByTestId("trucking-debug"));
    expect(trucking.find((t) => t.rateVariant === "DEDICATED")?.amount).toBe(5000);
    expect(trucking.find((t) => t.rateVariant === "GROUPAGE")?.amount).toBeNull();

    await selectOption(/tonnage — dedicated/i, "5 T");

    trucking = truckingFrom(screen.getByTestId("trucking-debug"));
    expect(trucking.find((t) => t.rateVariant === "DEDICATED")?.tonnage).toBe("T_5");
  });

  it("greys out a common charge row entirely when the draft has no matching charges entry (stale/legacy draft)", () => {
    const draft = roadDraft();
    // Simulate a stale/legacy draft: the Insurance line was added to the catalogue after this
    // draft was created, so `draft.charges` carries no entry for it at all (unlike v3, there's no
    // per-variant cell to drop — the whole row is either present once or missing).
    draft.charges = draft.charges.filter((c) => c.definitionKey !== "ROAD_STD_INSURANCE");
    render(<Harness seededCharges={ROAD_LINES} defaultValues={draft} mode="ROAD" />);
    expect(screen.getByLabelText(/^insurance$/i)).toBeDisabled();
    expect(screen.getByLabelText(/^tail-lift \/ lift-gate$/i)).toBeEnabled();
  });

  it("keeps the Grand total row's cell count aligned with the column headers (finding #6)", () => {
    render(<Harness seededCharges={ROAD_LINES} defaultValues={roadDraft()} mode="ROAD" />);
    const headerCells = screen.getAllByRole("columnheader");
    const totalRow = screen.getByTestId("chargematrix-total-DEDICATED").closest("tr");
    expect(totalRow).not.toBeNull();
    expect(within(totalRow!).getAllByRole("cell").length).toBe(headerCells.length);
  });
});

// ── finding #1: the matrix must render EDITABLE freight cells from the REAL shared seed shape ──
// The regression was that the SERVER seed (ff-portal.service.ts) returned trucking:[]/seaRates:[],
// so once resolveScope always returned it, ChargeMatrix rendered every freight cell as a disabled
// NotApplicableCell (trucking.findIndex(...) === -1). These render from `seedQuoteDraftPricing` —
// the exact seed both the server and draftFromDto now produce (one common row/line, v4) — instead
// of a hand-seeded fixture.
describe("ChargeMatrix — renders the shared seed shape with editable freight cells (finding #1)", () => {
  it("ROAD: seedQuoteDraftPricing yields editable Road Freight cells for both variants", () => {
    const draft = { ...baseDraft("ROAD"), ...seedQuoteDraftPricing(ROAD_LINES, "ROAD", "p1") };
    render(<Harness seededCharges={ROAD_LINES} defaultValues={draft} mode="ROAD" />);
    expect(screen.getByLabelText(/road freight — dedicated/i)).toBeEnabled();
    expect(screen.getByLabelText(/road freight — groupage/i)).toBeEnabled();
  });

  it("SEA: seedQuoteDraftPricing yields editable Sea Freight cells for both variants", () => {
    const draft = { ...baseDraft("SEA"), ...seedQuoteDraftPricing(SEA_LINES, "SEA", "p1") };
    render(<Harness seededCharges={SEA_LINES} defaultValues={draft} mode="SEA" />);
    expect(screen.getByLabelText(/sea freight — fcl/i)).toBeEnabled();
    expect(screen.getByLabelText(/sea freight — lcl/i)).toBeEnabled();
  });

  it("negative control: the OLD empty-trucking seed disables the freight cell (the finding #1 bug)", () => {
    const draft = {
      ...baseDraft("ROAD"),
      charges: seedQuoteDraftPricing(ROAD_LINES, "ROAD", "p1").charges,
      trucking: [], // the pre-fix server seed
    };
    render(<Harness seededCharges={ROAD_LINES} defaultValues={draft} mode="ROAD" />);
    expect(screen.getByLabelText(/road freight — dedicated/i)).toBeDisabled();
  });

  it("the seed produces exactly ONE common charges row per line, not one per variant (v4)", () => {
    const { charges } = seedQuoteDraftPricing(ROAD_LINES, "ROAD", "p1");
    expect(charges).toHaveLength(ROAD_LINES.length);
    expect(charges.every((c) => c.rateVariant === null)).toBe(true);
  });
});

describe("ChargeMatrix — Sea (FCL/LCL columns)", () => {
  it("renders FCL/LCL columns with a container-size Select only on FCL's freight cell", () => {
    render(<Harness seededCharges={SEA_LINES} defaultValues={seaDraft()} mode="SEA" />);
    expect(screen.getByRole("columnheader", { name: "FCL" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "LCL" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /container size — fcl/i })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /container size — lcl/i })).toBeNull();
  });

  it("renders a SINGLE Bill of Lading type Select on the common SEA_ORIGIN_BILL_OF_LADING row", () => {
    render(<Harness seededCharges={SEA_LINES} defaultValues={seaDraft()} mode="SEA" />);
    expect(screen.getAllByRole("combobox", { name: /bill of lading type/i })).toHaveLength(1);
  });

  it("selecting a container size writes only seaRates[FCL].containerSize", async () => {
    render(<Harness seededCharges={SEA_LINES} defaultValues={seaDraft()} mode="SEA" withDebug />);
    await selectOption(/container size — fcl/i, "20'");

    const seaRates = JSON.parse(
      screen.getByTestId("sea-rates-debug").textContent ?? "[]",
    ) as QuoteDraft["seaRates"];
    expect(seaRates.find((r) => r.rateVariant === "FCL")?.containerSize).toBe("TWENTY");
    expect(seaRates.find((r) => r.rateVariant === "LCL")?.containerSize).toBeNull();
  });

  it("selecting a Bill of Lading type writes the ONE common charge cell", async () => {
    render(<Harness seededCharges={SEA_LINES} defaultValues={seaDraft()} mode="SEA" withDebug />);
    await selectOption(/bill of lading type/i, "Telex Release");

    const charges = chargesFrom(screen.getByTestId("charges-debug"));
    const bl = charges.find((c) => c.definitionKey === "SEA_ORIGIN_BILL_OF_LADING");
    expect(bl?.billOfLadingType).toBe("TELEX");
  });
});

describe("ChargeMatrix — Air (single column)", () => {
  it("renders a single Air column with no separate synthetic freight row", () => {
    render(<Harness seededCharges={AIR_LINES} defaultValues={airDraft()} mode="AIR" />);
    expect(screen.getByRole("columnheader", { name: "Air" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Dedicated" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "FCL" })).toBeNull();
    // Air Freight appears exactly once — it's a normal (common) seeded row, not duplicated by a
    // synthetic freight row (design §3.1: "Air ← the AIR_MAIN_FREIGHT charge line").
    expect(screen.getAllByText("Air Freight")).toHaveLength(1);
    expect(screen.queryByTestId("chargematrix-row-freight")).toBeNull();
  });

  it("renders the HEAVY_WEIGHT_CALC line via HeavyWeightCalcRow, not a plain amount field", () => {
    render(<Harness seededCharges={AIR_LINES} defaultValues={airDraft()} mode="AIR" />);
    expect(screen.getByLabelText(/piece weight.*heavy weight surcharge$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/airline limit.*heavy weight surcharge$/i)).toBeInTheDocument();
    expect(
      screen.getByLabelText(/rate per excess kg.*heavy weight surcharge$/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/^heavy weight surcharge$/i)).toBeNull();
  });

  // design D4/#11: ChargeMatrix computes Σ draft.cargo[].grossWtKg and forwards it to
  // HeavyWeightCalcRow — proves the wiring end-to-end (HeavyWeightCalcRow.test.tsx covers the
  // component's own piece-vs-gross logic in isolation).
  it("passes the leg's total cargo gross weight down to HeavyWeightCalcRow (design D4/#11)", async () => {
    const draft = airDraft();
    draft.cargo = [
      { packageId: "p1", grossWtKg: 600, cbm: 1 },
      { packageId: "p2", grossWtKg: 400, cbm: 1 },
    ];
    render(<Harness seededCharges={AIR_LINES} defaultValues={draft} mode="AIR" />);
    await userEvent.type(screen.getByLabelText(/piece weight.*heavy weight surcharge$/i), "1500");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("1500");
    expect(alert).toHaveTextContent("1000"); // 600 + 400
  });

  it("the single column's grand total reflects the Air Freight cell (no separate rate cell)", async () => {
    render(<Harness seededCharges={AIR_LINES} defaultValues={airDraft()} mode="AIR" />);
    // Air has no separate freight-rate cell (variantRate() is always null for Air — see
    // quote-engine.ts), so the blank-rate convention never applies to it: the total starts at
    // 0.00 (not "–"), same as QuoteSummary's existing v.key !== "AIR" carve-out.
    expect(screen.getByTestId("chargematrix-total-AIR")).toHaveTextContent("0.00");
    await userEvent.type(screen.getByLabelText(/^air freight$/i), "2000");
    expect(screen.getByTestId("chargematrix-total-AIR")).toHaveTextContent("2,000.00");
  });
});

// ── design D1: Additional-charges subtotal + Grand total per variant ────────────────────────────
describe("ChargeMatrix — Additional charges subtotal + Grand total per variant (design D1)", () => {
  it("the Additional-charges subtotal sums every common charge row, independent of variant", async () => {
    render(<Harness seededCharges={ROAD_LINES} defaultValues={roadDraft()} mode="ROAD" />);
    expect(screen.getByTestId("chargematrix-additional-subtotal")).toHaveTextContent("0.00");

    await userEvent.type(screen.getByLabelText(/^insurance$/i), "50");
    await userEvent.type(screen.getByLabelText(/^tail-lift \/ lift-gate$/i), "25");
    expect(screen.getByTestId("chargematrix-additional-subtotal")).toHaveTextContent("75.00");
  });

  it("a variant's Grand total = ITS OWN freight rate + the Additional-charges subtotal + warehouse", async () => {
    render(<Harness seededCharges={ROAD_LINES} defaultValues={roadDraft()} mode="ROAD" />);
    // Fully untouched (no freight, no common charge, no warehouse anywhere): both columns blank.
    expect(screen.getByTestId("chargematrix-total-DEDICATED")).toHaveTextContent("–");
    expect(screen.getByTestId("chargematrix-total-GROUPAGE")).toHaveTextContent("–");

    await userEvent.type(screen.getByLabelText(/^road freight — dedicated$/i), "1000");
    await userEvent.type(screen.getByLabelText(/^insurance$/i), "50");

    // Dedicated: 1000 (own freight) + 50 (common charge) = 1050.
    expect(screen.getByTestId("chargematrix-total-DEDICATED")).toHaveTextContent("1,050.00");
    // Round 4: Groupage's OWN freight rate is still unset, but the SAME common Insurance charge
    // (50) DOES apply to it — the Grand total now reflects ANY priced input (freight, a common
    // charge, or warehouse), not just the variant's own rate, so Groupage shows its real total
    // (0 + 50 + 0), not a blank "–". Contrast with the fully-untouched assertion above.
    expect(screen.getByTestId("chargematrix-total-GROUPAGE")).toHaveTextContent("50.00");

    await userEvent.type(screen.getByLabelText(/^road freight — groupage$/i), "800");
    expect(screen.getByTestId("chargematrix-total-GROUPAGE")).toHaveTextContent("850.00");
  });
});

// ── design D1/#6: "Add Charge Line" restores custom lines, now as COMMON rows ───────────────────
describe('ChargeMatrix — "Add Charge Line" (design D1/#6)', () => {
  it("clicking Add Charge Line appends an editable common custom row (label + amount + remark)", async () => {
    render(
      <Harness seededCharges={ROAD_LINES} defaultValues={roadDraft()} mode="ROAD" withDebug />,
    );
    await userEvent.click(screen.getByRole("button", { name: /add charge line/i }));

    await userEvent.type(screen.getByLabelText(/custom charge 1 label/i), "Fuel surcharge");
    await userEvent.type(screen.getByLabelText(/custom charge 1 amount/i), "40");
    await userEvent.type(screen.getByLabelText(/custom charge 1 remark/i), "Peak season");

    const charges = chargesFrom(screen.getByTestId("charges-debug"));
    const custom = charges.find((c) => c.label === "Fuel surcharge");
    expect(custom).toBeDefined();
    expect(custom?.definitionKey ?? null).toBeNull();
    expect(custom?.presetKey ?? null).toBeNull();
    expect(custom?.rateVariant).toBeNull();
    expect(custom?.amount).toBe(40);
    expect(custom?.note).toBe("Peak season");
  });

  it("a custom row's amount folds into the Additional-charges subtotal and every variant's Grand total", async () => {
    render(<Harness seededCharges={ROAD_LINES} defaultValues={roadDraft()} mode="ROAD" />);
    await userEvent.type(screen.getByLabelText(/^road freight — dedicated$/i), "500");
    await userEvent.type(screen.getByLabelText(/^road freight — groupage$/i), "300");

    await userEvent.click(screen.getByRole("button", { name: /add charge line/i }));
    await userEvent.type(screen.getByLabelText(/custom charge 1 amount/i), "60");

    expect(screen.getByTestId("chargematrix-additional-subtotal")).toHaveTextContent("60.00");
    expect(screen.getByTestId("chargematrix-total-DEDICATED")).toHaveTextContent("560.00");
    expect(screen.getByTestId("chargematrix-total-GROUPAGE")).toHaveTextContent("360.00");
  });

  it("adding a second custom row keeps both independently editable (no cross-talk)", async () => {
    render(
      <Harness seededCharges={ROAD_LINES} defaultValues={roadDraft()} mode="ROAD" withDebug />,
    );
    await userEvent.click(screen.getByRole("button", { name: /add charge line/i }));
    await userEvent.type(screen.getByLabelText(/custom charge 1 label/i), "First custom");
    await userEvent.type(screen.getByLabelText(/custom charge 1 amount/i), "10");

    await userEvent.click(screen.getByRole("button", { name: /add charge line/i }));
    await userEvent.type(screen.getByLabelText(/custom charge 2 label/i), "Second custom");
    await userEvent.type(screen.getByLabelText(/custom charge 2 amount/i), "20");

    const charges = chargesFrom(screen.getByTestId("charges-debug"));
    const first = charges.find((c) => c.label === "First custom");
    const second = charges.find((c) => c.label === "Second custom");
    expect(first?.amount).toBe(10);
    expect(second?.amount).toBe(20);
  });

  it("Remove deletes exactly the clicked custom row, leaving catalogue rows and the other custom row intact", async () => {
    render(
      <Harness seededCharges={ROAD_LINES} defaultValues={roadDraft()} mode="ROAD" withDebug />,
    );
    await userEvent.click(screen.getByRole("button", { name: /add charge line/i }));
    await userEvent.type(screen.getByLabelText(/custom charge 1 label/i), "First custom");
    await userEvent.click(screen.getByRole("button", { name: /add charge line/i }));
    await userEvent.type(screen.getByLabelText(/custom charge 2 label/i), "Second custom");

    await userEvent.click(screen.getByRole("button", { name: /remove custom charge 1/i }));

    const charges = chargesFrom(screen.getByTestId("charges-debug"));
    expect(charges.some((c) => c.label === "First custom")).toBe(false);
    expect(charges.some((c) => c.label === "Second custom")).toBe(true);
    expect(charges.some((c) => c.definitionKey === "ROAD_STD_INSURANCE")).toBe(true);
    expect(charges.some((c) => c.definitionKey === "ROAD_STD_TAIL_LIFT")).toBe(true);
    // The removed row's own fields are gone from the DOM too, not just hidden.
    expect(screen.queryByLabelText(/custom charge 2 label/i)).toBeNull();
  });

  // The Q_CUSTOM_* gate (quote-engine.ts) is unconditional on every custom line — mirrors the
  // existing "per-cell note vs. $0-price gate" tests below, proving the NEW custom-row UI produces
  // a draft shape the REAL shared gate accepts/rejects exactly as designed.
  it("an unpriced, unremarked custom line fires Q_CUSTOM_AMOUNT + Q_CUSTOM_REMARK; filling both clears them", async () => {
    render(
      <Harness seededCharges={ROAD_LINES} defaultValues={roadDraft()} mode="ROAD" withDebug />,
    );
    await userEvent.click(screen.getByRole("button", { name: /add charge line/i }));
    await userEvent.type(screen.getByLabelText(/custom charge 1 label/i), "Fuel surcharge");

    let charges = chargesFrom(screen.getByTestId("charges-debug"));
    let findings = validateQuote(
      { ...roadDraft(), charges },
      FAR_FUTURE_DEADLINE,
      NOW,
      activeLinesFrom(ROAD_LINES),
    );
    expect(findings.some((f) => f.rule === "Q_CUSTOM_AMOUNT")).toBe(true);
    expect(findings.some((f) => f.rule === "Q_CUSTOM_REMARK")).toBe(true);

    await userEvent.type(screen.getByLabelText(/custom charge 1 amount/i), "40");
    await userEvent.type(screen.getByLabelText(/custom charge 1 remark/i), "Peak season");

    charges = chargesFrom(screen.getByTestId("charges-debug"));
    findings = validateQuote(
      { ...roadDraft(), charges },
      FAR_FUTURE_DEADLINE,
      NOW,
      activeLinesFrom(ROAD_LINES),
    );
    expect(findings.some((f) => f.rule === "Q_CUSTOM_AMOUNT")).toBe(false);
    expect(findings.some((f) => f.rule === "Q_CUSTOM_REMARK")).toBe(false);
  });
});

// ── Per-cell note vs. the $0-price gate (review round 1; v4: message dropped its variant suffix) ──
// Retiring ChargeZonePanel/RoadChargesPanel dropped their "Note (optional)" field, but
// validateQuote's Q_PRICED still requires a note to price a PLAIN catalogue line at exactly 0
// (quote-engine.ts: `c.amount === 0 && !c.note?.trim()`) — with no note surface, an FF pricing a
// line at 0 would hit a finding they could never clear. `activeLines` below mirrors how
// LegSectionForm derives it from `leg.seededCharges` for the real client-side gate.
function activeLinesFrom(seeded: FfPortalSeededCharge[]): ResolvedChargeLine[] {
  return seeded
    .filter((s): s is typeof s & { definitionKey: string } => s.definitionKey != null)
    .map((s) => ({
      definitionKey: s.definitionKey,
      role: "CORE" as const,
      inputType: s.inputType ?? "PLAIN",
      zone: s.zone,
      label: s.label,
    }));
}
const FAR_FUTURE_DEADLINE = "2999-01-01T00:00:00.000Z";
const NOW = "2026-01-01T00:00:00.000Z";
// v4: the engine dropped the "(Dedicated)"/"(Groupage)" suffix from this message — there's
// nothing left to disambiguate once a charge is common (quote-engine.ts, Task 1).
const ZERO_REMARK_MESSAGE = 'A remark is required to quote "Insurance" at 0';

// Round 4: Road freight is now REQUIRED to "start" the leg (the old charges-alone carve-out is
// gone) — these two tests care about the $0/no-note Q_PRICED rule specifically, not Q_RATE, so
// give DEDICATED a real trucking rate to reach a legitimately-started leg.
function startedRoadDraft(): QuoteDraft {
  const d = roadDraft();
  d.trucking = d.trucking.map((t) => (t.rateVariant === "DEDICATED" ? { ...t, amount: 500 } : t));
  return d;
}

describe("ChargeMatrix — the charge Note field clears the $0-price Q_PRICED gate", () => {
  it("binds the note to exactly the Insurance cell — not Tail-lift's — and a note clears the zero-price finding", async () => {
    render(
      <Harness seededCharges={ROAD_LINES} defaultValues={roadDraft()} mode="ROAD" withDebug />,
    );

    await userEvent.type(screen.getByLabelText(/^insurance$/i), "0");
    await userEvent.type(
      screen.getByLabelText(/^note for insurance$/i),
      "Waived per customer request",
    );

    const charges = chargesFrom(screen.getByTestId("charges-debug"));
    const insurance = charges.find((c) => c.definitionKey === "ROAD_STD_INSURANCE");
    const tailLift = charges.find((c) => c.definitionKey === "ROAD_STD_TAIL_LIFT");
    // The note landed on exactly the cell it was typed into — not the sibling catalogue line.
    expect(insurance?.amount).toBe(0);
    expect(insurance?.note).toBe("Waived per customer request");
    expect(tailLift?.note ?? "").toBe("");

    // Run the REAL gate (unchanged — this test doesn't touch validateQuote) against the draft the
    // matrix just produced, merged onto a legitimately-started Road leg (Round 4).
    const findings = validateQuote(
      { ...startedRoadDraft(), charges },
      FAR_FUTURE_DEADLINE,
      NOW,
      activeLinesFrom(ROAD_LINES),
    );
    expect(findings.some((f) => f.rule === "Q_PRICED" && f.message === ZERO_REMARK_MESSAGE)).toBe(
      false,
    );
  });

  it("still blocks a $0 line with no note (negative control — proves the note, not the zero amount, clears the gate)", () => {
    const draft = startedRoadDraft();
    draft.charges = draft.charges.map((c) =>
      c.definitionKey === "ROAD_STD_INSURANCE" ? { ...c, amount: 0 } : c,
    );
    const findings = validateQuote(draft, FAR_FUTURE_DEADLINE, NOW, activeLinesFrom(ROAD_LINES));
    expect(findings.some((f) => f.rule === "Q_PRICED" && f.message === ZERO_REMARK_MESSAGE)).toBe(
      true,
    );
  });
});
