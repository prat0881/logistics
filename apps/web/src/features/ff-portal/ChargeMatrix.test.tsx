import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider, useWatch, type Control } from "react-hook-form";
import type { QuoteDraft, FfPortalSeededCharge, FreightMode, ResolvedChargeLine } from "@svyft/shared";
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

function roadDraft(): QuoteDraft {
  const d = baseDraft("ROAD");
  d.charges = ROAD_LINES.flatMap((s) =>
    (["DEDICATED", "GROUPAGE"] as const).map((rv) => ({
      zone: s.zone,
      definitionKey: s.definitionKey,
      presetKey: null,
      label: s.label,
      amount: null,
      rateVariant: rv,
    })),
  );
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
  d.charges = SEA_LINES.flatMap((s) =>
    (["FCL", "LCL"] as const).map((rv) => ({
      zone: s.zone,
      definitionKey: s.definitionKey,
      presetKey: null,
      label: s.label,
      amount: null,
      rateVariant: rv,
      billOfLadingType: null,
    })),
  );
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

  it("entering an amount updates only that (line, variant) charge cell", async () => {
    render(
      <Harness seededCharges={ROAD_LINES} defaultValues={roadDraft()} mode="ROAD" withDebug />,
    );
    // Anchored (^...$): "Insurance — Groupage" is the amount field; the new per-cell note field
    // (added review round 1) is aria-labelled "Note for Insurance — Groupage", which an
    // unanchored /insurance — groupage/i would also match, making the query ambiguous.
    await userEvent.type(screen.getByLabelText(/^insurance — groupage$/i), "75");

    const charges = chargesFrom(screen.getByTestId("charges-debug"));
    const insuranceGroupage = charges.find(
      (c) => c.definitionKey === "ROAD_STD_INSURANCE" && c.rateVariant === "GROUPAGE",
    );
    const insuranceDedicated = charges.find(
      (c) => c.definitionKey === "ROAD_STD_INSURANCE" && c.rateVariant === "DEDICATED",
    );
    const tailLiftDedicated = charges.find(
      (c) => c.definitionKey === "ROAD_STD_TAIL_LIFT" && c.rateVariant === "DEDICATED",
    );
    expect(insuranceGroupage?.amount).toBe(75);
    expect(insuranceDedicated?.amount).toBeNull();
    expect(tailLiftDedicated?.amount).toBeNull();
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

  it("greys out a cell with no matching seeded charge for that (line, variant) pair", () => {
    const draft = roadDraft();
    // Simulate a stale/legacy draft: drop the GROUPAGE cell for Insurance.
    draft.charges = draft.charges.filter(
      (c) => !(c.definitionKey === "ROAD_STD_INSURANCE" && c.rateVariant === "GROUPAGE"),
    );
    render(<Harness seededCharges={ROAD_LINES} defaultValues={draft} mode="ROAD" />);
    // Groupage is the N/A cell here — NotApplicableCell renders a single disabled field with no
    // note sibling, so the unanchored query stays unambiguous; Dedicated is anchored (^...$)
    // since it IS a normal editable cell and now also carries a "Note for ..." sibling field.
    expect(screen.getByLabelText(/insurance — groupage/i)).toBeDisabled();
    expect(screen.getByLabelText(/^insurance — dedicated$/i)).toBeEnabled();
  });

  it("shows a per-column grand total aligned under each column, en-dash while a variant's rate is blank", async () => {
    render(<Harness seededCharges={ROAD_LINES} defaultValues={roadDraft()} mode="ROAD" />);
    // Nothing priced yet — neither variant has a freight rate → both totals blank.
    expect(screen.getByTestId("chargematrix-total-DEDICATED")).toHaveTextContent("–");
    expect(screen.getByTestId("chargematrix-total-GROUPAGE")).toHaveTextContent("–");

    await userEvent.type(screen.getByLabelText(/road freight — dedicated/i), "1000");
    await userEvent.type(screen.getByLabelText(/^insurance — dedicated$/i), "50");
    expect(screen.getByTestId("chargematrix-total-DEDICATED")).toHaveTextContent("1,050.00");
    // Groupage's freight rate is still unset — stays blank even though it has no charges either.
    expect(screen.getByTestId("chargematrix-total-GROUPAGE")).toHaveTextContent("–");
  });

  it("keeps the totals row's cell count aligned with the column headers (finding #6)", () => {
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
// the exact seed both the server and draftFromDto now produce — instead of a hand-seeded fixture.
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
});

describe("ChargeMatrix — Sea (FCL/LCL columns)", () => {
  it("renders FCL/LCL columns with a container-size Select only on FCL's freight cell", () => {
    render(<Harness seededCharges={SEA_LINES} defaultValues={seaDraft()} mode="SEA" />);
    expect(screen.getByRole("columnheader", { name: "FCL" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "LCL" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /container size — fcl/i })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /container size — lcl/i })).toBeNull();
  });

  it("renders a Bill of Lading type Select on the SEA_ORIGIN_BILL_OF_LADING row's cells only", () => {
    render(<Harness seededCharges={SEA_LINES} defaultValues={seaDraft()} mode="SEA" />);
    expect(
      screen.getByRole("combobox", { name: /bill of lading type — fcl/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: /bill of lading type — lcl/i }),
    ).toBeInTheDocument();
    // Origin THC (the other seeded line) gets no B/L dropdown at all.
    expect(screen.getAllByRole("combobox", { name: /bill of lading type/i })).toHaveLength(2);
  });

  it("selecting a container size writes only seaRates[FCL].containerSize", async () => {
    render(
      <Harness seededCharges={SEA_LINES} defaultValues={seaDraft()} mode="SEA" withDebug />,
    );
    await selectOption(/container size — fcl/i, "20'");

    const seaRates = JSON.parse(
      screen.getByTestId("sea-rates-debug").textContent ?? "[]",
    ) as QuoteDraft["seaRates"];
    expect(seaRates.find((r) => r.rateVariant === "FCL")?.containerSize).toBe("TWENTY");
    expect(seaRates.find((r) => r.rateVariant === "LCL")?.containerSize).toBeNull();
  });

  it("selecting a Bill of Lading type writes only that column's charge cell", async () => {
    render(
      <Harness seededCharges={SEA_LINES} defaultValues={seaDraft()} mode="SEA" withDebug />,
    );
    await selectOption(/bill of lading type — fcl/i, "Telex Release");

    const charges = chargesFrom(screen.getByTestId("charges-debug"));
    const blFcl = charges.find(
      (c) => c.definitionKey === "SEA_ORIGIN_BILL_OF_LADING" && c.rateVariant === "FCL",
    );
    const blLcl = charges.find(
      (c) => c.definitionKey === "SEA_ORIGIN_BILL_OF_LADING" && c.rateVariant === "LCL",
    );
    expect(blFcl?.billOfLadingType).toBe("TELEX");
    expect(blLcl?.billOfLadingType ?? null).toBeNull();
  });
});

describe("ChargeMatrix — Air (single column)", () => {
  it("renders a single Air column with no separate synthetic freight row", () => {
    render(<Harness seededCharges={AIR_LINES} defaultValues={airDraft()} mode="AIR" />);
    expect(screen.getByRole("columnheader", { name: "Air" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Dedicated" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "FCL" })).toBeNull();
    // Air Freight appears exactly once — it's a normal seeded row, not duplicated by a synthetic
    // freight row (design §3.1: "Air ← the AIR_MAIN_FREIGHT charge line").
    expect(screen.getAllByText("Air Freight")).toHaveLength(1);
    expect(screen.queryByTestId("chargematrix-row-freight")).toBeNull();
  });

  it("renders the HEAVY_WEIGHT_CALC line via HeavyWeightCalcRow, not a plain amount field", () => {
    render(<Harness seededCharges={AIR_LINES} defaultValues={airDraft()} mode="AIR" />);
    expect(
      screen.getByLabelText(/piece weight.*heavy weight surcharge — air/i),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/airline limit.*heavy weight surcharge — air/i),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/rate per excess kg.*heavy weight surcharge — air/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/^heavy weight surcharge — air$/i)).toBeNull();
  });

  it("the single column's grand total reflects the Air Freight cell (no separate rate cell)", async () => {
    render(<Harness seededCharges={AIR_LINES} defaultValues={airDraft()} mode="AIR" />);
    // Air has no separate freight-rate cell (variantRate() is always null for Air — see
    // quote-engine.ts), so the blank-rate convention never applies to it: the total starts at
    // 0.00 (not "–"), same as QuoteSummary's existing v.key !== "AIR" carve-out.
    expect(screen.getByTestId("chargematrix-total-AIR")).toHaveTextContent("0.00");
    await userEvent.type(screen.getByLabelText(/^air freight — air$/i), "2000");
    expect(screen.getByTestId("chargematrix-total-AIR")).toHaveTextContent("2,000.00");
  });
});

// ── Per-cell note vs. the $0-price gate (review round 1) ────────────────────────────────────────
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
const ZERO_REMARK_MESSAGE = 'A remark is required to quote "Insurance" (Dedicated) at 0';

describe("ChargeMatrix — per-cell note clears the $0-price Q_PRICED gate", () => {
  it("binds the note to exactly the (Insurance, Dedicated) cell — not its Groupage sibling or another line — and a note clears the zero-price finding", async () => {
    render(
      <Harness seededCharges={ROAD_LINES} defaultValues={roadDraft()} mode="ROAD" withDebug />,
    );

    await userEvent.type(screen.getByLabelText(/^insurance — dedicated$/i), "0");
    await userEvent.type(
      screen.getByLabelText(/note for insurance — dedicated/i),
      "Waived per customer request",
    );

    const charges = chargesFrom(screen.getByTestId("charges-debug"));
    const insuranceDedicated = charges.find(
      (c) => c.definitionKey === "ROAD_STD_INSURANCE" && c.rateVariant === "DEDICATED",
    );
    const insuranceGroupage = charges.find(
      (c) => c.definitionKey === "ROAD_STD_INSURANCE" && c.rateVariant === "GROUPAGE",
    );
    const tailLiftDedicated = charges.find(
      (c) => c.definitionKey === "ROAD_STD_TAIL_LIFT" && c.rateVariant === "DEDICATED",
    );
    // The note landed on exactly the cell it was typed into — not the Groupage sibling sharing
    // the same definitionKey, and not a different charge line sharing the same rateVariant.
    expect(insuranceDedicated?.amount).toBe(0);
    expect(insuranceDedicated?.note).toBe("Waived per customer request");
    expect(insuranceGroupage?.note ?? "").toBe("");
    expect(tailLiftDedicated?.note ?? "").toBe("");

    // Run the REAL gate (unchanged — this test doesn't touch validateQuote) against the draft the
    // matrix just produced.
    const findings = validateQuote(
      { ...roadDraft(), charges },
      FAR_FUTURE_DEADLINE,
      NOW,
      activeLinesFrom(ROAD_LINES),
    );
    expect(findings.some((f) => f.rule === "Q_PRICED" && f.message === ZERO_REMARK_MESSAGE)).toBe(
      false,
    );
  });

  it("still blocks a $0 line with no note (negative control — proves the note, not the zero amount, clears the gate)", () => {
    const draft = roadDraft();
    draft.charges = draft.charges.map((c) =>
      c.definitionKey === "ROAD_STD_INSURANCE" && c.rateVariant === "DEDICATED"
        ? { ...c, amount: 0 } // priced at 0, no note
        : c,
    );
    const findings = validateQuote(draft, FAR_FUTURE_DEADLINE, NOW, activeLinesFrom(ROAD_LINES));
    expect(findings.some((f) => f.rule === "Q_PRICED" && f.message === ZERO_REMARK_MESSAGE)).toBe(
      true,
    );
  });
});
