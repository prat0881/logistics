import { describe, expect, it } from "vitest";
import {
  buildComparisonRowModel,
  METRICS,
  offerKey,
  pendingKey,
  type GridCell,
  type OfferCell,
} from "./comparisonRowModel";
import type { LegComparisonDto, OfferDto, PendingForwarderDto } from "@svyft/shared";

// GridCell is a discriminated union (S5.9.5 D7) so every existing test written before Task 8 —
// which only ever built offer cells — must narrow before touching an `OfferCell`-only field.
// Throwing rather than silently widening the return type keeps a genuinely mis-typed fixture
// (a pending cell where a test expected an offer) loud instead of producing `undefined` reads.
function asOffer(cell: GridCell): OfferCell {
  if (cell.kind !== "offer") throw new Error(`expected an offer cell, got "${cell.kind}"`);
  return cell;
}

const offer = (o: Partial<OfferDto>): OfferDto => ({
  quoteId: "q1",
  freightForwarderId: "ff1",
  freightForwarderName: "Bridge",
  variant: "DEDICATED",
  variantLabel: "Dedicated",
  priced: true,
  nativeTotal: 6700,
  currency: "AED",
  unitsPerUsd: 3.6725,
  usdTotal: 1824.37,
  transitDays: 3,
  chargeableWeightKg: 100,
  validUntil: "2026-09-16T00:00:00.000Z",
  quoteStatus: "QUOTED",
  charges: [],
  ...o,
});

const leg = (offers: OfferDto[], recommendation: LegComparisonDto["recommendation"] = null) =>
  ({
    legId: "l1",
    legCode: "L1",
    mode: "ROAD",
    origin: "A",
    destination: "B",
    offers,
    pendingForwarders: [],
    awaitingReQuote: false,
    recommendation,
    decision: null,
    timeline: [],
  }) as LegComparisonDto;

describe("buildComparisonRowModel", () => {
  it("groups a forwarder's variants under one group", () => {
    const m = buildComparisonRowModel(
      leg([offer({}), offer({ variant: "GROUPAGE", variantLabel: "Groupage" })]),
      false,
    );
    expect(m.groups).toHaveLength(1);
    expect(m.groups[0].freightForwarderName).toBe("Bridge");
    expect(m.groups[0].cells).toHaveLength(2);
    expect(m.cells).toHaveLength(2);
  });

  it("marks the recommended cell by (quoteId, variant)", () => {
    const m = buildComparisonRowModel(
      leg([offer({}), offer({ variant: "GROUPAGE", variantLabel: "Groupage" })]),
      false,
    );
    expect(m.recommendedKey).toBeNull();

    const withRec = buildComparisonRowModel(
      leg([offer({})], { quoteId: "q1", variant: "DEDICATED", reason: "fastest" }),
      false,
    );
    expect(withRec.recommendedKey).toBe(offerKey("q1", "DEDICATED"));
    expect(asOffer(withRec.cells[0]).recommended).toBe(true);
  });

  it("suppresses the recommendation entirely when locked", () => {
    const m = buildComparisonRowModel(
      leg([offer({})], { quoteId: "q1", variant: "DEDICATED", reason: "fastest" }),
      true,
    );
    expect(m.recommendedKey).toBeNull();
    expect(asOffer(m.cells[0]).recommended).toBe(false);
  });

  // ── S5.9.1 R1 — the recommendation OF RECORD. S5.9 T9 suppressed the `★` entirely the moment a
  // leg's decision left DRAFT, reasoning that `buildRecommendation` (comparison.service.ts) ranks
  // only QUOTED offers, so sending an offer for approval drops IT OUT of the live ranking and
  // `leg.recommendation` can shift to a NAME A DIFFERENT forwarder on the very next fetch. That
  // reasoning was right but the fix was wrong: it left a checker reviewing a sent leg with no
  // recommendation on screen at all. `AwardDecisionDto` already snapshots `recommendedQuoteId`/
  // `recommendedVariant` at send time (award.ts:52-60) — stable, and exactly what the maker was
  // judged against — so this suite now proves the model reads THAT once a decision exists, instead
  // of suppressing. `decision()` fully populates every `AwardDecisionDto` field (not the brief's
  // abbreviated partials) so `pnpm run typecheck` stays honest about what a real decision row
  // looks like.
  describe("reads the recommendation of record (S5.9.1 R1)", () => {
    const decision = (
      overrides: Partial<NonNullable<LegComparisonDto["decision"]>> = {},
    ): NonNullable<LegComparisonDto["decision"]> => ({
      legId: "l1",
      status: "DRAFT",
      shortlistedQuoteId: null,
      shortlistedVariant: null,
      recommendedQuoteId: null,
      recommendedVariant: null,
      overrideReason: null,
      rejectionReason: null,
      sentByUserId: null,
      sentForApprovalAt: null,
      decidedByUserId: null,
      decidedAt: null,
      ...overrides,
    });

    it("marks the SNAPSHOTTED recommendation once a leg has been sent for approval", () => {
      // The live ranking has moved on — q1 left QUOTED when it was sent, so `leg.recommendation`
      // (the live value) now names q2. The mark must still point at q1: what the decision snapshot
      // says, not what the engine currently ranks.
      const m = buildComparisonRowModel(
        {
          ...leg(
            [offer({}), offer({ quoteId: "q2", variant: "GROUPAGE", variantLabel: "Groupage" })],
            { quoteId: "q2", variant: "GROUPAGE", reason: "cheapest now" },
          ),
          decision: decision({
            status: "PENDING_APPROVAL",
            recommendedQuoteId: "q1",
            recommendedVariant: "DEDICATED",
            shortlistedQuoteId: "q1",
            shortlistedVariant: "DEDICATED",
          }),
        },
        false,
      );
      expect(m.recommendedKey).toBe(offerKey("q1", "DEDICATED"));
      expect(asOffer(m.cells.find((c) => c.key === offerKey("q2", "GROUPAGE"))!).recommended).toBe(
        false,
      );
    });

    it("falls back to the live recommendation when no decision exists yet", () => {
      const m = buildComparisonRowModel(
        {
          ...leg(
            [offer({}), offer({ quoteId: "q2", variant: "GROUPAGE", variantLabel: "Groupage" })],
            { quoteId: "q2", variant: "GROUPAGE", reason: "cheapest" },
          ),
          decision: null,
        },
        false,
      );
      expect(m.recommendedKey).toBe(offerKey("q2", "GROUPAGE"));
    });

    it("prefers the snapshot even on a DRAFT decision, so a returned leg keeps the mark it was judged against", () => {
      // A rejected leg comes back as DRAFT carrying a rejectionReason (award.service.ts's
      // REJECTED -> DRAFT rule) — the snapshot must win here too, not just for PENDING_APPROVAL.
      const m = buildComparisonRowModel(
        {
          ...leg(
            [offer({}), offer({ quoteId: "q2", variant: "GROUPAGE", variantLabel: "Groupage" })],
            { quoteId: "q2", variant: "GROUPAGE", reason: "cheapest now" },
          ),
          decision: decision({
            status: "DRAFT",
            rejectionReason: "too slow",
            recommendedQuoteId: "q1",
            recommendedVariant: "DEDICATED",
          }),
        },
        false,
      );
      expect(m.recommendedKey).toBe(offerKey("q1", "DEDICATED"));
    });

    it("still suppresses the recommendation entirely once the award is locked", () => {
      const m = buildComparisonRowModel(
        {
          ...leg([offer({})], { quoteId: "q1", variant: "DEDICATED", reason: "cheapest" }),
          decision: decision({
            status: "APPROVED",
            recommendedQuoteId: "q1",
            recommendedVariant: "DEDICATED",
          }),
        },
        true,
      );
      expect(m.recommendedKey).toBeNull();
      expect(asOffer(m.cells[0]).recommended).toBe(false);
    });

    it("says nothing when a decision exists but snapshotted no recommendation", () => {
      // The maker shortlisted with NOTHING recommended on offer — falling back to the (unrelated)
      // live value here would invent a recommendation after the fact and misrepresent the record.
      const m = buildComparisonRowModel(
        {
          ...leg([offer({})], { quoteId: "q1", variant: "DEDICATED", reason: "cheapest" }),
          decision: decision({
            status: "PENDING_APPROVAL",
            recommendedQuoteId: null,
            recommendedVariant: null,
          }),
        },
        false,
      );
      expect(m.recommendedKey).toBeNull();
      expect(asOffer(m.cells[0]).recommended).toBe(false);
    });
  });

  // ── S5.9.1 Task 5 — the offer that went for approval, read straight from
  // `decision.shortlistedQuoteId`/`shortlistedVariant`, never from `offer.quoteStatus` (which is a
  // second-hand signal that can drift from the decision — observed live on `S56VIS-0001`:
  // `decision.status = PENDING_APPROVAL` naming a quote whose `quoteStatus` was still `QUOTED`).
  // Mirrors the "recommendation of record" block above: its own full-shape `decision()` helper
  // (every `AwardDecisionDto` field populated, not the brief's abbreviated partials) so
  // `pnpm run typecheck` stays honest about what a real decision row looks like.
  describe("sentForApproval — the offer that went for approval (S5.9.1 Task 5)", () => {
    const decision = (
      overrides: Partial<NonNullable<LegComparisonDto["decision"]>> = {},
    ): NonNullable<LegComparisonDto["decision"]> => ({
      legId: "l1",
      status: "PENDING_APPROVAL",
      shortlistedQuoteId: null,
      shortlistedVariant: null,
      recommendedQuoteId: null,
      recommendedVariant: null,
      overrideReason: null,
      rejectionReason: null,
      sentByUserId: "u1",
      sentForApprovalAt: "2026-08-14T09:00:00.000Z",
      decidedByUserId: null,
      decidedAt: null,
      ...overrides,
    });

    it("marks the offer the decision names", () => {
      const m = buildComparisonRowModel(
        {
          ...leg([
            offer({}),
            offer({ quoteId: "q2", variant: "GROUPAGE", variantLabel: "Groupage" }),
          ]),
          decision: decision({ shortlistedQuoteId: "q1", shortlistedVariant: "DEDICATED" }),
        },
        false,
      );
      expect(
        asOffer(m.cells.find((c) => c.key === offerKey("q1", "DEDICATED"))!).sentForApproval,
      ).toBe(true);
    });

    it("marks no offer other than the one the decision names", () => {
      const m = buildComparisonRowModel(
        {
          ...leg([
            offer({}),
            offer({ quoteId: "q2", variant: "GROUPAGE", variantLabel: "Groupage" }),
          ]),
          decision: decision({ shortlistedQuoteId: "q1", shortlistedVariant: "DEDICATED" }),
        },
        false,
      );
      expect(
        asOffer(m.cells.find((c) => c.key === offerKey("q2", "GROUPAGE"))!).sentForApproval,
      ).toBe(false);
    });

    // ── THE test that matters most — the drift case observed live. A naive implementation that
    // derives "sent for approval" from `offer.quoteStatus === "PENDING_APPROVAL"` (rather than the
    // decision) passes every other test in this block but fails this one: the quote status stayed
    // QUOTED (stale/unflipped) while the decision has already moved on to PENDING_APPROVAL, and the
    // decision is what must win.
    it("marks the offer even when its own quoteStatus is still QUOTED — the decision moved, the quote status didn't (the drift case)", () => {
      const m = buildComparisonRowModel(
        {
          ...leg([offer({ quoteStatus: "QUOTED" })]),
          decision: decision({ shortlistedQuoteId: "q1", shortlistedVariant: "DEDICATED" }),
        },
        false,
      );
      expect(asOffer(m.cells[0]).offer.quoteStatus).toBe("QUOTED"); // sanity: the drift precondition holds
      expect(asOffer(m.cells[0]).sentForApproval).toBe(true);
    });

    it("reads as both when the same offer is also the recommendation of record", () => {
      const m = buildComparisonRowModel(
        {
          ...leg([offer({})]),
          decision: decision({
            shortlistedQuoteId: "q1",
            shortlistedVariant: "DEDICATED",
            recommendedQuoteId: "q1",
            recommendedVariant: "DEDICATED",
          }),
        },
        false,
      );
      expect(asOffer(m.cells[0]).recommended).toBe(true);
      expect(asOffer(m.cells[0]).sentForApproval).toBe(true);
    });

    it("marks nothing when there is no decision yet", () => {
      const m = buildComparisonRowModel(leg([offer({})]), false);
      expect(asOffer(m.cells[0]).sentForApproval).toBe(false);
    });

    it("marks nothing when a decision exists but names no shortlist", () => {
      const m = buildComparisonRowModel(
        {
          ...leg([offer({})]),
          decision: decision({ shortlistedQuoteId: null, shortlistedVariant: null }),
        },
        false,
      );
      expect(asOffer(m.cells[0]).sentForApproval).toBe(false);
    });

    it("suppresses the mark once locked, consistently with the recommendation", () => {
      const m = buildComparisonRowModel(
        {
          ...leg([offer({})]),
          decision: decision({ shortlistedQuoteId: "q1", shortlistedVariant: "DEDICATED" }),
        },
        true,
      );
      expect(asOffer(m.cells[0]).sentForApproval).toBe(false);
    });

    // ── Final whole-branch review, C1 — the one cell of the matrix neither Task 1's nor Task 5's
    // fixtures reached, and the reason the bug shipped: every Task-5 fixture defaults
    // `status: "PENDING_APPROVAL"`, and Task 1's DRAFT case leaves `shortlistedQuoteId` null, so
    // `DRAFT + shortlisted` — precisely what `reject()` writes — was never built. `reject()`
    // (award.service.ts) returns the decision to DRAFT and clears `sentByUserId` but deliberately
    // KEEPS `shortlistedQuoteId`/`shortlistedVariant` so `MakerPanel` can tell the maker which
    // shortlist to revise; the two sibling reset paths (`award-change-order.listener.ts`,
    // `negotiation.service.ts`) DO null those fields, so reject is the unique producer of this
    // state. Reading the shortlist regardless of status therefore made a rejected leg claim its
    // offer was "currently under checker review" a few rows above MakerPanel's "Returned by the
    // checker" alert on the same screen. ────────────────────────────────────────────────────────
    it("marks nothing once the checker has REJECTED it — a DRAFT decision still carrying its shortlist is the post-rejection state, not a live review", () => {
      const m = buildComparisonRowModel(
        {
          ...leg([offer({})]),
          decision: decision({
            status: "DRAFT",
            shortlistedQuoteId: "q1",
            shortlistedVariant: "DEDICATED",
            sentByUserId: null, // reject() clears this...
            rejectionReason: "Transit too long", // ...and writes this
          }),
        },
        false,
      );
      expect(asOffer(m.cells[0]).sentForApproval).toBe(false);
    });

    // The other half of the same fix: the `★` and the `⚑` are NOT interchangeable. `★`'s copy is
    // timeless ("recommended by the comparison engine"), so a returned leg keeps the mark it was
    // judged against (Task 1's deliberate behaviour); `⚑`'s copy is a present-tense claim, so it
    // must go. Pinning both on ONE post-rejection fixture is what stops a future "consistency"
    // refactor from collapsing them back into a single rule in either direction.
    it("keeps the RECOMMENDATION of record on that same rejected leg — only the live-status mark goes quiet", () => {
      const m = buildComparisonRowModel(
        {
          ...leg([offer({})]),
          decision: decision({
            status: "DRAFT",
            shortlistedQuoteId: "q1",
            shortlistedVariant: "DEDICATED",
            recommendedQuoteId: "q1",
            recommendedVariant: "DEDICATED",
            sentByUserId: null,
            rejectionReason: "Transit too long",
          }),
        },
        false,
      );
      expect(asOffer(m.cells[0]).recommended).toBe(true);
      expect(asOffer(m.cells[0]).sentForApproval).toBe(false);
    });

    // APPROVED is the other status that survives with a shortlist still on the row (approve()
    // never clears it — `generateClientQuote` reads it as the winner). A decided leg is not
    // "currently under checker review" either, and `locked` does not cover this: it only engages
    // once the WHOLE query reaches QUOTING_CLIENT, so one approved leg beside still-pending
    // siblings renders unlocked.
    it("marks nothing once the decision is APPROVED — decided is not 'under review', and `locked` hasn't engaged for a single approved leg", () => {
      const m = buildComparisonRowModel(
        {
          ...leg([offer({})]),
          decision: decision({
            status: "APPROVED",
            shortlistedQuoteId: "q1",
            shortlistedVariant: "DEDICATED",
            decidedByUserId: "u2",
            decidedAt: "2026-08-15T09:00:00.000Z",
          }),
        },
        false,
      );
      expect(asOffer(m.cells[0]).sentForApproval).toBe(false);
    });

    // `AwardDecisionDto.status`'s union allows REJECTED even though `reject()` writes straight to
    // DRAFT and never persists it (design §9.5). Covered so the mark is gated on "is it under
    // review", not on "is it not DRAFT" — an implementation that excluded DRAFT alone would pass
    // every test above and still mark a REJECTED row.
    it("marks nothing on the REJECTED status the DTO allows but the server never persists", () => {
      const m = buildComparisonRowModel(
        {
          ...leg([offer({})]),
          decision: decision({
            status: "REJECTED",
            shortlistedQuoteId: "q1",
            shortlistedVariant: "DEDICATED",
          }),
        },
        false,
      );
      expect(asOffer(m.cells[0]).sentForApproval).toBe(false);
    });
  });

  // ── S5.9.1 R1, Step 4 — the `★` mark's accessible name. `leg.recommendation.reason` is the LIVE
  // reason and, once a decision snapshot is in play, may describe a different offer entirely (the
  // whole point of the describe block above). `recommendedReason` is resolved in lock-step with
  // `recommendedKey` so a consumer never has to re-derive which source is in play.
  describe("recommendedReason — the mark's accessible-name text", () => {
    it("is the live recommendation's reason before any decision exists", () => {
      const m = buildComparisonRowModel(
        leg([offer({})], { quoteId: "q1", variant: "DEDICATED", reason: "fastest transit" }),
        false,
      );
      expect(m.recommendedReason).toBe("fastest transit");
    });

    it("falls back to a generic on-record sentence once a decision snapshot is in play, rather than reusing a reason that may no longer describe it", () => {
      const m = buildComparisonRowModel(
        {
          ...leg(
            [offer({}), offer({ quoteId: "q2", variant: "GROUPAGE", variantLabel: "Groupage" })],
            { quoteId: "q2", variant: "GROUPAGE", reason: "cheapest now" },
          ),
          decision: {
            legId: "l1",
            status: "PENDING_APPROVAL",
            shortlistedQuoteId: "q1",
            shortlistedVariant: "DEDICATED",
            recommendedQuoteId: "q1",
            recommendedVariant: "DEDICATED",
            overrideReason: null,
            rejectionReason: null,
            sentByUserId: "u1",
            sentForApprovalAt: "2026-08-14T09:00:00.000Z",
            decidedByUserId: null,
            decidedAt: null,
          },
        },
        false,
      );
      expect(m.recommendedReason).not.toBe("cheapest now");
      expect(m.recommendedReason).toMatch(/recommend/i);
    });

    it("is null when there is no recommendation to explain", () => {
      const m = buildComparisonRowModel(leg([offer({})]), false);
      expect(m.recommendedKey).toBeNull();
      expect(m.recommendedReason).toBeNull();
    });
  });

  // ── S5.9.5 (design D7/D8) — pending cells IN the grid, and the approved offer's own mark.
  describe("S5.9.5 — pending cells and the approved mark", () => {
    const PENDING_FF_ID = "ff-pending";
    const FF_ID = "ff1"; // matches offer()'s default freightForwarderId
    const WINNER_QUOTE = "q-winner";

    const pendingForwarder = (o: Partial<PendingForwarderDto> = {}): PendingForwarderDto => ({
      freightForwarderId: PENDING_FF_ID,
      freightForwarderName: "Waiting Co",
      quoteStatus: "RFQ_SENT",
      ...o,
    });

    const decision = (
      overrides: Partial<NonNullable<LegComparisonDto["decision"]>> = {},
    ): NonNullable<LegComparisonDto["decision"]> => ({
      legId: "l1",
      status: "PENDING_APPROVAL",
      shortlistedQuoteId: null,
      shortlistedVariant: null,
      recommendedQuoteId: null,
      recommendedVariant: null,
      overrideReason: null,
      rejectionReason: null,
      sentByUserId: "u1",
      sentForApprovalAt: "2026-08-14T09:00:00.000Z",
      decidedByUserId: null,
      decidedAt: null,
      ...overrides,
    });

    const legWithOneOfferAndOnePending: LegComparisonDto = {
      ...leg([offer({})]),
      pendingForwarders: [pendingForwarder()],
    };

    // Defensive fixture only — Task 1's server-side subtraction of any quote that produced an
    // offer from `pendingForwarders` should make this payload shape unreachable in production.
    // It is built anyway because the model must not double-render a forwarder if a stale or
    // hand-built payload ever carries both.
    const legWhereFfAppearsInBothLists: LegComparisonDto = {
      ...leg([offer({ freightForwarderId: FF_ID, freightForwarderName: "Bridge" })]),
      pendingForwarders: [
        pendingForwarder({ freightForwarderId: FF_ID, freightForwarderName: "Bridge" }),
      ],
    };

    const legWithApprovedDecision: LegComparisonDto = {
      ...leg([offer({ quoteId: WINNER_QUOTE, variant: "FCL", variantLabel: "FCL" })]),
      decision: decision({
        status: "APPROVED",
        shortlistedQuoteId: WINNER_QUOTE,
        shortlistedVariant: "FCL",
        decidedByUserId: "u2",
        decidedAt: "2026-08-15T09:00:00.000Z",
      }),
    };

    const legWithPendingDecision: LegComparisonDto = {
      ...leg([offer({ quoteId: WINNER_QUOTE, variant: "FCL", variantLabel: "FCL" })]),
      decision: decision({
        status: "PENDING_APPROVAL",
        shortlistedQuoteId: WINNER_QUOTE,
        shortlistedVariant: "FCL",
      }),
    };

    it("S5.9.5 — a pendingForwarder becomes its own group with one pending cell", () => {
      const model = buildComparisonRowModel(legWithOneOfferAndOnePending, false);
      expect(model.groups).toHaveLength(2);
      const pendingGroup = model.groups.find((g) => g.freightForwarderId === PENDING_FF_ID)!;
      expect(pendingGroup.cells).toHaveLength(1);
      expect(pendingGroup.cells[0]!.kind).toBe("pending");
      expect(pendingGroup.cells[0]!.key).toBe(pendingKey(PENDING_FF_ID));
      expect(model.cells.filter((c) => c.kind === "offer")).toHaveLength(1);
    });

    it("S5.9.5 — a forwarder that already has an offer never gains a second, pending group", () => {
      // Defensive: Task 1's server-side subtraction should make this impossible, but the model
      // must not double-render if a stale payload ever carries both.
      const model = buildComparisonRowModel(legWhereFfAppearsInBothLists, false);
      expect(model.groups.filter((g) => g.freightForwarderId === FF_ID)).toHaveLength(1);
    });

    it("S5.9.5 — the approved offer is marked, and the sent-for-approval flag is not", () => {
      const model = buildComparisonRowModel(legWithApprovedDecision, false);
      const cell = asOffer(model.cells.find((c) => c.key === offerKey(WINNER_QUOTE, "FCL"))!);
      expect(cell.approved).toBe(true);
      expect(cell.sentForApproval).toBe(false);
    });

    it("S5.9.5 — approved and sentForApproval can never both be true", () => {
      // Positive control: the PENDING_APPROVAL fixture must produce the mirror image.
      const pending = buildComparisonRowModel(legWithPendingDecision, false);
      const cell = asOffer(pending.cells.find((c) => c.key === offerKey(WINNER_QUOTE, "FCL"))!);
      expect(cell.sentForApproval).toBe(true);
      expect(cell.approved).toBe(false);
    });

    it("S5.9.5 — `locked` suppresses the star and the flag but NOT the approved mark", () => {
      const model = buildComparisonRowModel(legWithApprovedDecision, true);
      const cell = asOffer(model.cells.find((c) => c.key === offerKey(WINNER_QUOTE, "FCL"))!);
      expect(cell.approved).toBe(true);
      expect(cell.recommended).toBe(false);
      expect(cell.sentForApproval).toBe(false);
      expect(model.recommendedKey).toBeNull();
    });
  });

  // ── S5.9.5 (D4) — a `describe("stale — widened to REQUOTED || EXPIRED")` block lived here,
  // asserting `OfferCell.stale` for a REQUOTED and a price-carrying EXPIRED offer. It went with the
  // field itself in Task 10's review round 1 (MINOR 5): once `SendForApprovalDialog` had to tell the
  // two causes APART — different badge, different copy, and only REQUOTED unselectable — a flag that
  // deliberately spanned both was useless to its only consumer, which reads `offer.quoteStatus`
  // instead. `stale` then had zero production readers, so these assertions were pinning a value
  // nothing rendered. The behaviour they were really about is covered where it is now visible:
  // `SendForApprovalDialog.test.tsx`'s "a priced EXPIRED offer is selectable and labelled
  // 'Re-quote unanswered'; a REQUOTED one is neither".


  it("renders the conversion rate metric, and an em-dash when absent", () => {
    const rate = METRICS.find((x) => x.id === "rate")!;
    const m = buildComparisonRowModel(
      leg([offer({}), offer({ quoteId: "q2", unitsPerUsd: null, variant: "GROUPAGE" })]),
      false,
    );
    expect(rate.render(asOffer(m.cells[0]))).toBe("3.67250");
    expect(rate.render(asOffer(m.cells[1]))).toBe("—");
  });

  it("never renders a money figure for an unpriced offer", () => {
    const usd = METRICS.find((x) => x.id === "usdTotal")!;
    const m = buildComparisonRowModel(
      leg([offer({ priced: false, usdTotal: null, nativeTotal: 0 })]),
      false,
    );
    expect(usd.render(asOffer(m.cells[0]))).toBe("—");
    expect(usd.render(asOffer(m.cells[0]))).not.toContain("$0");
  });

  // ── S5.9 T8, product item 1 — the product owner's exact column order. Both grid orientations
  // read this one array (columns view's row labels, rows view's column headers), so pinning the
  // order here is what keeps them from drifting apart.
  it("orders the metrics as the product owner specified", () => {
    expect(METRICS.map((m) => m.label)).toEqual([
      "Total (native)",
      "Rate (per USD)",
      "Total (USD)",
      "Transit",
      "Valid until",
    ]);
  });
});
