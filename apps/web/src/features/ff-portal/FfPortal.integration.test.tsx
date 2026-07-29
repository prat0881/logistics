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
import type { FfPortalRfqDto, FfPortalLegDto, QuoteDraft } from "@svyft/shared";

afterEach(() => vi.unstubAllGlobals());

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
// This lets the test price exactly ONE charge to pass Q1 validation.
// currency/quoteValidityUntil are intentionally null here; they are merged from page-level state
// (the RFQ top-level fields) by LegSectionForm — never typed into a per-leg field.
const sentDraft: QuoteDraft = {
  legId: "L1",
  mode: "AIR",
  currency: null,           // will be merged from rfq.currency by LegSectionForm
  quoteValidityUntil: null, // will be merged from rfq.quoteValidityUntil by LegSectionForm
  cargo: [
    {
      cargoItemId: "c1",
      grossWtT: 1,
      cbm: 1,
      isDangerous: false,
      freightDensity: 167, // seeded → Q2 passes
    },
  ],
  charges: [
    // 12 pre-priced at 0; only Air Freight (AIR_MAIN_FREIGHT) left unpriced → one input to fill
    { zone: "ORIGIN", presetKey: "AIR_ORIGIN_EXPORT_CLEARANCE", label: "Export Customs Clearance", amount: 0 },
    { zone: "ORIGIN", presetKey: "AIR_ORIGIN_DOCUMENTATION", label: "Documentation Charges", amount: 0 },
    { zone: "ORIGIN", presetKey: "AIR_ORIGIN_THC", label: "Origin THC / Airport Handling", amount: 0 },
    { zone: "ORIGIN", presetKey: "AIR_ORIGIN_SECURITY", label: "Security / Screening Charges", amount: 0 },
    { zone: "ORIGIN", presetKey: "AIR_ORIGIN_WAREHOUSE_PRESTORAGE", label: "Warehouse / Pre-storage at OAP", amount: 0 },
    { zone: "MAIN_FREIGHT", presetKey: "AIR_MAIN_FREIGHT", label: "Air Freight", amount: null }, // ← the one to price
    { zone: "MAIN_FREIGHT", presetKey: "AIR_MAIN_SEC", label: "Security Exchange (SEC)", amount: 0 },
    { zone: "MAIN_FREIGHT", presetKey: "AIR_MAIN_CARRIER_SURCHARGE", label: "Airline / Carrier Surcharge", amount: 0 },
    { zone: "MAIN_FREIGHT", presetKey: "AIR_MAIN_HEAVY_WEIGHT", label: "Heavy Weight Surcharge", amount: 0 },
    { zone: "DESTINATION", presetKey: "AIR_DEST_THC", label: "Destination THC / Airport Handling", amount: 0 },
    { zone: "DESTINATION", presetKey: "AIR_DEST_IMPORT_CLEARANCE", label: "Import Customs Clearance", amount: 0 },
    { zone: "DESTINATION", presetKey: "AIR_DEST_LAST_MILE", label: "Last Mile Handling / Lift Gate", amount: 0 },
    { zone: "DESTINATION", presetKey: "AIR_DEST_STORAGE", label: "Storage 1 Free Day Charges", amount: 0 },
  ],
  trucking: [],
  warehouse: [],
  transit: { departureDate: null, arrivalDate: null }, // Q6 requires these to be set in the test
  dgSurchargeNote: null,
  termsConditions: null,
};

const sentLeg: FfPortalLegDto = {
  legId: "L1",
  quoteId: "Q1",
  status: "RFQ_SENT",
  mode: "AIR",
  manifest: {
    cargo: [
      {
        cargoItemId: "c1",
        poReference: "PO-1",
        productName: "Pumps",
        packageType: "Box",
        isDangerous: false,
        qty: 1,
        dimL: "1",
        dimW: "1",
        dimH: "1",
        grossWt: "1000",
        volumeCbm: "1",
        hsCode: null,
        netWt: null,
      },
    ],
  },
  endpoints: [],
  // seededCharges/seededDensity — only used when draft is null; here draft is set
  seededCharges: [
    { zone: "MAIN_FREIGHT", presetKey: "AIR_MAIN_FREIGHT", label: "Air Freight", isPreset: true, amount: null },
  ] as unknown as FfPortalLegDto["seededCharges"],
  seededDensity: [{ cargoItemId: "c1", freightDensity: 167 }],
  // Pre-built draft: 12 charges pre-priced, Air Freight at null → test only needs to price one
  draft: sentDraft,
} as unknown as FfPortalLegDto;

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
  cargo: [
    {
      cargoItemId: "c1",
      grossWtT: 1,
      cbm: 1,
      isDangerous: false,
      freightDensity: 167,
    },
  ],
  charges: [
    {
      zone: "MAIN_FREIGHT",
      presetKey: "AIR_MAIN_FREIGHT",
      label: "Air Freight",
      amount: 2000,
    },
  ],
  trucking: [],
  warehouse: [],
  transit: {
    departureDate: "2026-08-05T10:00:00.000Z",
    arrivalDate: "2026-08-07T10:00:00.000Z",
  },
  dgSurchargeNote: null,
  termsConditions: "Accepted",
};

const quotedLeg: FfPortalLegDto = {
  ...sentLeg,
  status: "QUOTED",
  draft: quotedDraft,
} as unknown as FfPortalLegDto;

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
        const body =
          init?.body ? JSON.parse(init.body as string) : undefined;

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
    // NumberField renders an <input type="number"> with aria-label "Amount for Air Freight"
    const amountInput = screen.getByLabelText(/amount for air freight/i);
    await userEvent.clear(amountInput);
    await userEvent.type(amountInput, "2000");

    // 2. Set transit departure date
    const departureInput = screen.getByLabelText(/departure/i);
    fireEvent.change(departureInput, { target: { value: "2026-08-05T10:00" } });

    // 3. Set transit arrival date
    const arrivalInput = screen.getByLabelText(/arrival/i);
    fireEvent.change(arrivalInput, { target: { value: "2026-08-07T10:00" } });

    // 4. Check the T&C checkbox
    const checkbox = screen.getByRole("checkbox");
    await userEvent.click(checkbox);

    // 5. Click "Submit quote"
    await userEvent.click(screen.getByRole("button", { name: /submit quote/i }));

    // Assert: "Quote submitted" summary appears after refetch
    await screen.findByText(/quote submitted/i);

    // Assert: a PATCH occurred BEFORE a POST (ordering)
    const patchIdx = calls.findIndex(
      (c) => c.url.includes("/quotes/L1") && c.method === "PATCH",
    );
    const postIdx = calls.findIndex(
      (c) => c.url.includes("/quotes/L1/submit") && c.method === "POST",
    );
    expect(patchIdx).toBeGreaterThanOrEqual(0);
    expect(postIdx).toBeGreaterThanOrEqual(0);
    expect(patchIdx).toBeLessThan(postIdx);

    // Assert: PATCH body carries RFQ-level currency and quoteValidityUntil (the merge)
    // These were NEVER typed into a per-leg field — they come from page-level state seeded from the RFQ
    const patchCall = calls[patchIdx];
    expect((patchCall.body as Record<string, unknown>)?.currency).toBe("USD");
    expect((patchCall.body as Record<string, unknown>)?.quoteValidityUntil).toBe(
      "2999-02-01T00:00:00.000Z",
    );
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
    const amountInput = screen.getByLabelText(/amount for air freight/i);
    await userEvent.clear(amountInput);
    await userEvent.type(amountInput, "2000");

    const departureInput = screen.getByLabelText(/departure/i);
    fireEvent.change(departureInput, { target: { value: "2026-08-05T10:00" } });

    const arrivalInput = screen.getByLabelText(/arrival/i);
    fireEvent.change(arrivalInput, { target: { value: "2026-08-07T10:00" } });

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
describe("FfPortal integration — client gate", () => {
  it("shows findings alert and makes zero network calls to /quotes/ when submit is invalid", async () => {
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

    // Client gate: findings alert appears
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    // Assert zero calls to any /quotes/ URL
    const quotesCalls = fetchMock.mock.calls.filter(
      (args) => typeof args[0] === "string" && (args[0] as string).includes("/quotes/"),
    );
    expect(quotesCalls).toHaveLength(0);
  });
});
