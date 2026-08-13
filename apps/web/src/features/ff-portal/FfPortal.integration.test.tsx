/**
 * FfPortal.integration.test.tsx
 *
 * End-to-end integration tests for the FF Portal happy path and error cases.
 * Drives the real FfPortalPage through a route so useParams resolves.
 * Uses a STATEFUL fetch stub to capture request bodies and flip state after submit.
 *
 * Tests:
 * 1. Happy path + currency/validity MERGE — submit a valid quote, assert PATCH-before-POST,
 *    assert currency/quoteValidityUntil in PATCH body (RFQ-level merge), assert "Quote submitted" summary.
 * 2. 422 server-findings surfacing — POST /submit returns 422, assert role="alert" with server message.
 * 3. Invalid submit makes ZERO network calls — client gate blocks network before validation passes.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { renderWithProviders } from "@/test/renderWithProviders";
import { FfPortalPage } from "./FfPortalPage";
import { toDatetimeLocal } from "./format";
import type { FfPortalRfqDto, FfPortalLegDto, QuoteDraft } from "@svyft/shared";

afterEach(() => vi.unstubAllGlobals());

// Relative-to-now datetime-local strings for the transit fields typed during the happy-path test
// below — Round 4's Q_PAST_DATE (design D3, quote-engine.ts) is unconditional and reads the real
// wall clock, so a hardcoded absolute date (e.g. a literal "2026-09-05T10:00") would eventually
// fall into the past and turn that submit test red. DAY matches the ms-per-day this file's own
// leg fixtures don't otherwise need to name.
const DAY = 24 * 60 * 60 * 1000;
const FUTURE_DEPARTURE = toDatetimeLocal(new Date(Date.now() + 30 * DAY).toISOString());
const FUTURE_ARRIVAL = toDatetimeLocal(new Date(Date.now() + 32 * DAY).toISOString());

// ── Render helper ─────────────────────────────────────────────────────────────
const renderAt = (token: string) =>
  renderWithProviders(
    <Routes>
      <Route path="/ff/rfq/:token" element={<FfPortalPage />} />
    </Routes>,
    { route: `/ff/rfq/${token}` },
  );

// ── Fixtures ──────────────────────────────────────────────────────────────────

// A pre-built draft with all AIR charges priced EXCEPT Air Freight (amount: null).
// This lets the test price exactly ONE charge to pass the Q_PRICED gate (validateQuote's
// activeLines-driven catalogue-line check — only Air Freight carries a definitionKey in
// sentLeg.seededCharges below, so it's the only line the client-side gate tracks).
// currency/quoteValidityUntil are intentionally null here; they are merged from page-level state
// (the RFQ top-level fields) by LegSectionForm — never typed into a per-leg field.
const sentDraft: QuoteDraft = {
  legId: "L1",
  mode: "AIR",
  currency: null, // will be merged from rfq.currency by LegSectionForm
  quoteValidityUntil: null, // will be merged from rfq.quoteValidityUntil by LegSectionForm
  chargedWeightKg: 1000, // v3: leg-level (was per-package) → FF-entered → Q_WEIGHT passes
  notes: null,
  cargo: [
    {
      packageId: "c1",
      grossWtKg: 1000,
      cbm: 1,
    },
  ],
  // Air's single implicit column → every cell carries rateVariant: null (v3).
  // 12 pre-priced at 0; only Air Freight (AIR_MAIN_FREIGHT) left unpriced → one input to fill
  charges: [
    {
      zone: "ORIGIN",
      presetKey: "AIR_ORIGIN_EXPORT_CLEARANCE",
      label: "Export Customs Clearance",
      amount: 0,
      rateVariant: null,
    },
    {
      zone: "ORIGIN",
      presetKey: "AIR_ORIGIN_DOCUMENTATION",
      label: "Documentation Charges",
      amount: 0,
      rateVariant: null,
    },
    {
      zone: "ORIGIN",
      presetKey: "AIR_ORIGIN_THC",
      label: "Origin THC / Airport Handling",
      amount: 0,
      rateVariant: null,
    },
    {
      zone: "ORIGIN",
      presetKey: "AIR_ORIGIN_SECURITY",
      label: "Security / Screening Charges",
      amount: 0,
      rateVariant: null,
    },
    {
      zone: "ORIGIN",
      presetKey: "AIR_ORIGIN_WAREHOUSE_PRESTORAGE",
      label: "Warehouse / Pre-storage at OAP",
      amount: 0,
      rateVariant: null,
    },
    {
      zone: "MAIN_FREIGHT",
      definitionKey: "AIR_MAIN_FREIGHT",
      presetKey: "AIR_MAIN_FREIGHT",
      label: "Air Freight",
      amount: null,
      rateVariant: null,
    }, // ← the one to price
    {
      zone: "MAIN_FREIGHT",
      presetKey: "AIR_MAIN_SEC",
      label: "Security Exchange (SEC)",
      amount: 0,
      rateVariant: null,
    },
    {
      zone: "MAIN_FREIGHT",
      presetKey: "AIR_MAIN_CARRIER_SURCHARGE",
      label: "Airline / Carrier Surcharge",
      amount: 0,
      rateVariant: null,
    },
    {
      zone: "MAIN_FREIGHT",
      presetKey: "AIR_MAIN_HEAVY_WEIGHT",
      label: "Heavy Weight Surcharge",
      amount: 0,
      rateVariant: null,
    },
    {
      zone: "DESTINATION",
      presetKey: "AIR_DEST_THC",
      label: "Destination THC / Airport Handling",
      amount: 0,
      rateVariant: null,
    },
    {
      zone: "DESTINATION",
      presetKey: "AIR_DEST_IMPORT_CLEARANCE",
      label: "Import Customs Clearance",
      amount: 0,
      rateVariant: null,
    },
    {
      zone: "DESTINATION",
      presetKey: "AIR_DEST_LAST_MILE",
      label: "Last Mile Handling / Lift Gate",
      amount: 0,
      rateVariant: null,
    },
    {
      zone: "DESTINATION",
      presetKey: "AIR_DEST_STORAGE",
      label: "Storage 1 Free Day Charges",
      amount: 0,
      rateVariant: null,
    },
  ],
  trucking: [],
  seaRates: [],
  warehouse: [],
  // Q_TRANSIT requires guaranteedTransitDaysByVariant[AIR_VARIANT_KEY] (already 5, satisfied).
  // departureDate/arrivalDate are legacy fields — required by the QuoteDraftTransit shape but
  // ungated and no longer editable via TransitPlanForm (superseded by mode-specific
  // plannedDeparture/plannedArrival).
  transit: { departureDate: null, arrivalDate: null, guaranteedTransitDaysByVariant: { AIR: 5 } },
  dgSurchargeNote: null,
  termsConditions: null,
};

const sentLeg: FfPortalLegDto = {
  legId: "L1",
  quoteId: "Q1",
  status: "RFQ_SENT",
  mode: "AIR",
  manifest: {
    legId: "L1",
    legCode: "L1",
    legName: null,
    mode: "AIR",
    incoterms: null,
    origin: null,
    destination: null,
    readyDate: null,
    targetDelivery: null,
    cargo: [
      {
        packageId: "c1",
        packageNo: "PK-1",
        packageType: "BOX",
        packageCount: 1,
        dimL: "100",
        dimW: "100",
        dimH: "100",
        netWt: null,
        grossWt: "1000",
        volumeCbm: "1",
        tags: [],
      },
    ],
    frozenAt: "2026-08-01T00:00:00.000Z",
  },
  endpoints: [],
  // seededCharges — drives the client-side activeLines/Q_PRICED gate (LegSection.tsx); mirrors
  // the ONE deliberately-unpriced draft.charges line above (Air Freight) so the client gate
  // targets exactly it. Real production always carries definitionKey on catalogue lines (see
  // ff-portal.service.ts / resolveChargeConfig) — presetKey is threaded through only for shape
  // compatibility (FfPortalSeededCharge) and is asserted on directly by Test 1's PATCH-body check.
  seededCharges: [
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
  // Pre-built draft: 12 charges pre-priced, Air Freight at null → test only needs to price one
  draft: sentDraft,
};

const sentRfq: FfPortalRfqDto = {
  rfqNumber: "R-1",
  incoterms: "FOB",
  submissionDeadline: "2999-01-01T00:00:00.000Z",
  currency: "USD",
  quoteValidityUntil: "2999-02-01T00:00:00.000Z",
  freightForwarder: { companyName: "Acme" },
  legs: [sentLeg],
} as FfPortalRfqDto;

// A minimal QuoteDraft for the quoted leg's draft field
const quotedDraft: QuoteDraft = {
  legId: "L1",
  mode: "AIR",
  currency: "USD",
  quoteValidityUntil: "2999-02-01T00:00:00.000Z",
  chargedWeightKg: 1000, // v3: leg-level, not per-package
  notes: null,
  cargo: [
    {
      packageId: "c1",
      grossWtKg: 1000,
      cbm: 1,
    },
  ],
  charges: [
    {
      zone: "MAIN_FREIGHT",
      presetKey: "AIR_MAIN_FREIGHT",
      label: "Air Freight",
      amount: 2000,
      rateVariant: null, // Air's single implicit column
    },
  ],
  trucking: [],
  seaRates: [],
  warehouse: [],
  transit: {
    departureDate: "2026-08-05T10:00:00.000Z",
    arrivalDate: "2026-08-07T10:00:00.000Z",
    guaranteedTransitDaysByVariant: { AIR: 5 },
  },
  dgSurchargeNote: null,
  termsConditions: "Accepted",
};

const quotedLeg: FfPortalLegDto = {
  ...sentLeg,
  status: "QUOTED",
  draft: quotedDraft,
};

const quotedRfq: FfPortalRfqDto = {
  ...sentRfq,
  legs: [quotedLeg],
} as FfPortalRfqDto;

// ── Test 1: Happy path + currency/validity MERGE ──────────────────────────────
describe("FfPortal integration — happy path", () => {
  it("prices a charge, sets transit dates, submits, and shows 'Quote submitted' summary", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    let submitted = false;

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body as string) : undefined;

        // Record all /api/ff/rfq/tok calls for assertion
        if (url.includes("/api/ff/rfq/tok")) {
          calls.push({ url, method, body });
        }

        const ok = (status: number, b: unknown) =>
          Promise.resolve({
            ok: status < 300,
            status,
            json: () => Promise.resolve(b),
            text: () => Promise.resolve(JSON.stringify(b)),
          } as Response);

        // GET /api/ff/rfq/tok — returns QUOTED rfq after submit, sentRfq before
        if (url.endsWith("/api/ff/rfq/tok") && method === "GET") {
          return ok(200, submitted ? quotedRfq : sentRfq);
        }

        // POST /api/ff/rfq/tok/quotes/L1/submit
        if (url.includes("/quotes/L1/submit") && method === "POST") {
          submitted = true;
          return ok(201, { quoteId: "Q1", status: "QUOTED" });
        }

        // PATCH /api/ff/rfq/tok/quotes/L1
        if (url.includes("/quotes/L1") && method === "PATCH") {
          return ok(200, {});
        }

        // auth/me and others → 401 (harmless)
        return ok(401, {});
      }),
    );

    renderAt("tok");

    // Wait for the shell to load ("Acme" from PortalShell)
    await screen.findByText(/Acme/i);

    // 1. Price the "Air Freight" charge
    // v4 (design D1, Round 4): every `charges` row (Air's included) is COMMON now — ONE amount
    // input labeled with just the row's own label, no "— Air" variant suffix (there's nothing
    // left to disambiguate once a charge isn't per-variant). Anchored so it doesn't also match
    // the per-cell "Note for Air Freight" sibling field.
    const amountInput = screen.getByLabelText(/^air freight$/i);
    await userEvent.clear(amountInput);
    await userEvent.type(amountInput, "2000");

    // 2. Set transit departure date
    // Q_PAST_DATE (design D3, Task 1 of this round) unconditionally rejects any FF datetime
    // earlier than "now" — FUTURE_DEPARTURE/FUTURE_ARRIVAL (module scope, above) are computed
    // relative to Date.now() so this stays valid as real time advances, rather than a hardcoded
    // absolute date that would eventually expire (the CI-time-bomb fix applied across the e2e
    // specs it touched — see its report's collateral-fallout note).
    const departureInput = screen.getByLabelText(/departure/i);
    fireEvent.change(departureInput, { target: { value: FUTURE_DEPARTURE } });

    // 3. Set transit arrival date
    const arrivalInput = screen.getByLabelText(/arrival/i);
    fireEvent.change(arrivalInput, { target: { value: FUTURE_ARRIVAL } });

    // 4. Check the T&C checkbox
    const checkbox = screen.getByRole("checkbox");
    await userEvent.click(checkbox);

    // 5. Click "Submit quote"
    await userEvent.click(screen.getByRole("button", { name: /submit quote/i }));

    // Assert: "Quote submitted" summary appears after refetch
    await screen.findByText(/quote submitted/i);

    // Assert: a PATCH occurred BEFORE a POST (ordering)
    const patchIdx = calls.findIndex((c) => c.url.includes("/quotes/L1") && c.method === "PATCH");
    const postIdx = calls.findIndex(
      (c) => c.url.includes("/quotes/L1/submit") && c.method === "POST",
    );
    expect(patchIdx).toBeGreaterThanOrEqual(0);
    expect(postIdx).toBeGreaterThanOrEqual(0);
    expect(patchIdx).toBeLessThan(postIdx);

    // Assert: PATCH body carries RFQ-level currency and quoteValidityUntil (the merge)
    // These were NEVER typed into a per-leg field — they come from page-level state seeded from the RFQ
    const patchCall = calls[patchIdx];
    const patchBody = patchCall.body as Record<string, unknown>;
    expect(patchBody?.currency).toBe("USD");
    expect(patchBody?.quoteValidityUntil).toBe("2999-02-01T00:00:00.000Z");

    // Assert: the user-typed amount (2000) for "Air Freight" serialized into PATCH body charges
    const patchCharges = patchBody?.charges as Array<Record<string, unknown>> | undefined;
    const airFreightCharge = patchCharges?.find((c) => c.presetKey === "AIR_MAIN_FREIGHT");
    expect(airFreightCharge).toBeDefined();
    expect(airFreightCharge?.amount).toBe(2000);
  });
});

// ── Test 2: 422 server-findings surfacing ────────────────────────────────────
describe("FfPortal integration — 422 surfacing", () => {
  it("shows server finding message in role=alert when /submit returns 422", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";

        const ok = (status: number, b: unknown) =>
          Promise.resolve({
            ok: status < 300,
            status,
            json: () => Promise.resolve(b),
            text: () => Promise.resolve(JSON.stringify(b)),
          } as Response);

        if (url.endsWith("/api/ff/rfq/tok") && method === "GET") {
          return ok(200, sentRfq);
        }

        // PATCH succeeds
        if (url.includes("/quotes/L1") && !url.includes("/submit") && method === "PATCH") {
          return ok(200, {});
        }

        // POST /submit → 422 with server findings
        if (url.includes("/quotes/L1/submit") && method === "POST") {
          return ok(422, {
            findings: [
              {
                rule: "Q1",
                severity: "blocking",
                scope: { type: "leg", id: "L1" },
                message: 'Charge line "Air Freight" must be priced',
              },
            ],
          });
        }

        return ok(401, {});
      }),
    );

    renderAt("tok");
    await screen.findByText(/Acme/i);

    // Fill in all the required fields so the CLIENT gate passes
    // (price the charge, set dates, check T&C — then server returns 422)
    // v4 (design D1, Round 4): common charge row → single amount input, no "— Air" suffix.
    const amountInput = screen.getByLabelText(/^air freight$/i);
    await userEvent.clear(amountInput);
    await userEvent.type(amountInput, "2000");

    const departureInput = screen.getByLabelText(/departure/i);
    fireEvent.change(departureInput, { target: { value: FUTURE_DEPARTURE } });

    const arrivalInput = screen.getByLabelText(/arrival/i);
    fireEvent.change(arrivalInput, { target: { value: FUTURE_ARRIVAL } });

    const checkbox = screen.getByRole("checkbox");
    await userEvent.click(checkbox);

    await userEvent.click(screen.getByRole("button", { name: /submit quote/i }));

    // Server 422 → alert shows server message text
    const alert = await screen.findByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).toMatch(/charge line.*air freight.*must be priced/i);
  });
});

// ── Test 3: Invalid submit makes ZERO network calls ──────────────────────────
// sentDraft/sentLeg are set up so every rule passes EXCEPT Q_PRICED on "Air Freight" (the one
// line in sentLeg.seededCharges, unpriced in sentDraft.charges) — this is the rule the
// activeLines wiring (LegSection.tsx) is responsible for firing client-side. Before that wiring,
// validateQuote's 4th arg defaulted to `[]`, the Q_PRICED-over-activeLines loop never ran, and
// this test failed (no finding fired, so the alert never appeared).
describe("FfPortal integration — client gate", () => {
  it("shows the Q_PRICED finding for the unpriced Air Freight line and makes zero network calls", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";

      const ok = (status: number, b: unknown) =>
        Promise.resolve({
          ok: status < 300,
          status,
          json: () => Promise.resolve(b),
          text: () => Promise.resolve(JSON.stringify(b)),
        } as Response);

      if (url.endsWith("/api/ff/rfq/tok") && method === "GET") {
        return ok(200, sentRfq);
      }
      // auth/me etc.
      return ok(401, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAt("tok");
    await screen.findByText(/Acme/i);

    // Click "Submit quote" WITHOUT pricing / filling anything
    await userEvent.click(screen.getByRole("button", { name: /submit quote/i }));

    // Client gate: findings alert appears, naming the specific unpriced catalogue line —
    // proves activeLines (built from leg.seededCharges) reached validateQuote's Q_PRICED check.
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByRole("alert").textContent).toMatch(
      /charge line.*air freight.*must be priced/i,
    );

    // Assert zero calls to any /quotes/ URL
    const quotesCalls = fetchMock.mock.calls.filter(
      (args) => typeof args[0] === "string" && (args[0] as string).includes("/quotes/"),
    );
    expect(quotesCalls).toHaveLength(0);
  });
});
