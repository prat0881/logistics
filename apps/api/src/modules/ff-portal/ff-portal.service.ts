import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  classifyWarehousePositions,
  validateQuote,
  computeQuoteTotals,
  computeHeavyWeightAmount,
  seedQuoteDraftPricing,
  seedQuoteDraftWarehouse,
  variantsForMode,
  variantsForTransit,
  AIR_VARIANT_KEY,
  SEA_VARIANT_KEY,
  QuoteEvent,
  Role,
} from "@svyft/shared";
import type {
  FfPortalRfqDto,
  FfPortalLegDto,
  ManifestSnapshot,
  QuoteDraft,
  QuoteDraftCharge,
  Finding,
  ChargeConfigSnapshot,
  ResolvedChargeLine,
  FreightMode,
  ChargeRateVariant,
  TransitVariantKey,
  SeedEndpoint,
  SubmitQuoteInput,
} from "@svyft/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { StatusService } from "../status/status.service";
import { NotificationDispatcher } from "../comms/notification-dispatcher.service";
import { ScheduledEventService } from "../comms/scheduled-event.service";
import type { FfScope } from "../rfq/rfq-token.service";
import { closedLegReasons } from "./leg-closure";

/** Calc line amount (design §7): HEAVY_WEIGHT_CALC lines compute from the FF-entered piece
 *  weight / airline limit / excess rate; every other charge line carries its own amount. */
const chargeAmount = (c: QuoteDraftCharge): number =>
  c.pieceWeightKg != null && c.airlineLimitKg != null && c.ratePerExcessKg != null
    ? computeHeavyWeightAmount(c.pieceWeightKg, c.airlineLimitKg, c.ratePerExcessKg)
    : c.amount!;

// ── v4 per-variant helpers (design §3.1/§5, Round 4) ─────────────────────────────────────────
// The three functions below mirror quote-engine.ts's private chargeCellPriced/variantRate/
// isVariantPriced EXACTLY (re-synced for Round 4 — see the Task-2 handoff: they previously
// predated BOTH the common-charge change and the isVariantPriced/isLegStarted split, which could
// have silently re-imposed "Road freight required" at submit; validateQuote itself is imported
// from @svyft/shared wholesale — never mirrored — so the actual submit-gate can't drift, but
// materialize below still needs its own "which freight variant is priced" verdict). They're
// duplicated locally — same pattern as chargeAmount() above mirroring effectiveChargeAmount() —
// because materialize (submit(), below) needs that verdict for: writing exactly one TransitPlan
// row per priced Road variant (Sea/Air collapse to their one common/single row — see the
// transitKeys logic in submit()). Charges no longer carry a rateVariant at all (v4: every row is
// common — see QuoteDraftCharge), so unlike v3 there is nothing to filter by variant when
// materializing ChargeLines; every chargeCellPriced-passing row materializes once, full stop,
// with rateVariant forced to null (see the chargeLine.createMany call below).

/** A charge cell counts as "priced" once it carries a usable amount — a literal `amount`, or
 *  (for a HEAVY_WEIGHT_CALC line) all three calc inputs. Matches chargeAmount()'s own notion of
 *  "computable" so a cell this treats as priced never hits chargeAmount()'s `c.amount!`
 *  force-unwrap with a null. */
const chargeCellPriced = (c: QuoteDraftCharge): boolean =>
  c.amount != null ||
  (c.pieceWeightKg != null && c.airlineLimitKg != null && c.ratePerExcessKg != null);

/** The freight-rate cell for variant `v`: Road ← the matching `trucking` row, Sea ← the matching
 *  `seaRates` row, Air ← always null (Air prices its freight via the AIR_MAIN_FREIGHT charge
 *  line instead — see quote-engine.ts's variantRate for the full rationale). */
function variantRate(draft: QuoteDraft, v: ChargeRateVariant | null): number | null {
  if (draft.mode === "ROAD") return draft.trucking.find((t) => t.rateVariant === v)?.amount ?? null;
  if (draft.mode === "SEA") return draft.seaRates.find((r) => r.rateVariant === v)?.amount ?? null;
  return null;
}

/** Is variant `v` "priced" (v4, matching quote-engine.ts's isVariantPriced exactly)? Road/Sea:
 *  purely its OWN freight rate — charges no longer carry a rateVariant, so a charge cell can no
 *  longer establish which freight column it belongs to. Air (no freight-rate cell at all): any
 *  common charge. Feeds ONLY the TransitPlan materialize logic below (which Road variants get
 *  their own row, and whether Sea/Air's one common row gets written at all) — never the
 *  ChargeLine materialize, which no longer filters by variant. */
function isVariantPriced(draft: QuoteDraft, v: ChargeRateVariant | null): boolean {
  if (draft.mode === "ROAD" || draft.mode === "SEA") return variantRate(draft, v) != null;
  return draft.charges.some(chargeCellPriced);
}

/** resolveScope seed (design §5; v4/Round 4: charges common, freight per-variant): when a leg has
 *  no saved draftJson yet, GET returns a starter QuoteDraft instead of null — ONE common row per
 *  active chargeConfig line (`rateVariant: null`, `amount: null` — every charge is priced once,
 *  full stop, not once per rate-variant column any more) PLUS the mode's blank freight-rate rows
 *  (Road → Dedicated/Groupage `trucking`, Sea → FCL/LCL `seaRates`, keyed off the leg's first
 *  endpoint for Road — freight is the one thing that STAYS per-variant) PLUS the shared warehouse
 *  rows (one per warehouse-positioned endpoint when handling is included) — so the portal always
 *  has an addressable, editable cell for every charge line, for the freight rate, AND for
 *  warehousing, rather than the client reconstructing them. Charges + trucking + seaRates come from
 *  `@svyft/shared`'s `seedQuoteDraftPricing`, warehouse from `seedQuoteDraftWarehouse` — the SAME
 *  helpers the client's draftFromDto calls, a single source of truth so the server and client seeds
 *  can never diverge (design §6 finding #1 + its warehouse sibling: the earlier
 *  `trucking:[]`/`seaRates:[]`/`warehouse:[]` server seed left every Road/Sea freight cell disabled
 *  and every warehouse row absent once resolveScope started always returning this seed).
 *  Everything else starts empty/null; submit() re-derives currency/quoteValidityUntil/cargo from
 *  the RFQ/manifest regardless of what a client echoes back, so seeding them is unnecessary. */
function seedQuoteDraft(
  legId: string,
  mode: FreightMode | null,
  lines: ResolvedChargeLine[],
  endpoints: SeedEndpoint[],
  warehouseIncluded: boolean,
): QuoteDraft {
  const { charges, trucking, seaRates } = seedQuoteDraftPricing(
    lines,
    mode,
    endpoints[0]?.pointId ?? "",
  );
  return {
    legId,
    mode,
    currency: null,
    quoteValidityUntil: null,
    chargedWeightKg: null,
    notes: null,
    cargo: [],
    charges,
    trucking,
    seaRates,
    warehouse: seedQuoteDraftWarehouse(warehouseIncluded, endpoints),
    transit: { departureDate: null, arrivalDate: null, guaranteedTransitDaysByVariant: {} },
    dgSurchargeNote: null,
    termsConditions: null,
  };
}

/** The quote-status refusal, shared VERBATIM by `submit` and `saveDraft` so the two cannot drift
 *  apart on which statuses accept a write (they must accept exactly the same set — see
 *  `saveDraft`). One string, one vocabulary. */
const QUOTE_NOT_OPEN_REASON = "This quote has already been submitted or is not open";

/** The only two quote statuses a forwarder may write against: their RFQ is open, or they have been
 *  asked to revise. Mirrors the portal UI, which renders every other status read-only. */
const WRITABLE_QUOTE_STATUSES: readonly string[] = ["RFQ_SENT", "REQUOTED"];

@Injectable()
export class FfPortalService {
  private readonly logger = new Logger(FfPortalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly status: StatusService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly scheduled: ScheduledEventService,
  ) {}

  async resolveScope(scope: FfScope): Promise<FfPortalRfqDto> {
    const ff = await this.prisma.freightForwarder.findUnique({
      where: { id: scope.rfq.freightForwarderId },
      select: { companyName: true, defaultCurrency: true },
    });
    // Warehouse positions across the FF's WHOLE leg set (§6.4)
    const whLegs = scope.quotes.map((q) => ({
      originPointId: q.leg.originPoint?.id ?? null,
      destinationPointId: q.leg.destinationPoint?.id ?? null,
      mode: (q.leg.mode ?? null) as "AIR" | "SEA" | "ROAD" | null,
    }));
    const whPointIds = scope.quotes.flatMap((q) =>
      [q.leg.originPoint, q.leg.destinationPoint]
        .filter((p): p is NonNullable<typeof p> => !!p && p.type === "WAREHOUSE")
        .map((p) => p.id),
    );
    const whPos = classifyWarehousePositions(whLegs, whPointIds);
    // S5.9.5 (D5) — one batched read for the whole scope; see closedReasons for the rule.
    const closed = await this.closedReasons(scope.quotes);

    const legs: FfPortalLegDto[] = scope.quotes.map((q) => {
      const manifest = q.manifestSnapshot as ManifestSnapshot;
      const mode = q.leg.mode as FfPortalLegDto["mode"]; // FreightMode | null
      const snap = (q.chargeConfigSnapshot as ChargeConfigSnapshot | null) ?? {
        lines: [],
        warehouseIncluded: false,
      };
      const endpoints = [q.leg.originPoint, q.leg.destinationPoint]
        .filter((p): p is NonNullable<typeof p> => !!p)
        .map((p) => ({
          pointId: p.id,
          type: p.type,
          name: p.name,
          country: p.country,
          // Non-sensitive location code, live-resolved off the current point (not the frozen
          // manifestSnapshot) — same precedence as the executive RouteDiagram.tsx (query-wizard/
          // steps/legs/RouteDiagram.tsx): unLocode ?? iataCode ?? icaoCode ?? terminal.
          code: p.unLocode ?? p.iataCode ?? p.icaoCode ?? p.terminal ?? null,
          warehousePosition: p.type === "WAREHOUSE" ? (whPos[p.id] ?? null) : null,
        }));
      return {
        legId: q.legId,
        quoteId: q.id,
        status: q.status as FfPortalLegDto["status"],
        mode,
        manifest,
        endpoints,
        // snap.lines is already PLAIN | HEAVY_WEIGHT_CALC only (resolveChargeConfig excludes
        // TRUCKING/WAREHOUSE_STAGING, which seed via `endpoints` instead) — seed every resolved
        // line onto the portal unfiltered; the FF prices HEAVY_WEIGHT_CALC lines via
        // piece/limit/rate inputs client-side rather than a flat amount.
        seededCharges: snap.lines.map((l) => ({
          zone: l.zone,
          definitionKey: l.definitionKey,
          inputType: l.inputType,
          presetKey: null,
          label: l.label,
          isPreset: true as const,
          amount: null,
        })),
        warehouseIncluded: snap.warehouseIncluded,
        // v3 (design §5): seed the per-variant matrix + the mode's freight-rate rows + the shared
        // warehouse rows when there's no saved draft yet — see seedQuoteDraft above — instead of
        // returning null. `endpoints` (with each warehouse endpoint's classified `warehousePosition`)
        // and `snap.warehouseIncluded` are the SAME inputs the client's draftFromDto seeds from;
        // Road's trucking rows key off `endpoints[0]` (the first endpoint), exactly as it does.
        draft: q.draftJson
          ? (q.draftJson as QuoteDraft)
          : seedQuoteDraft(q.legId, mode, snap.lines, endpoints, snap.warehouseIncluded),
        closedReason: closed.get(q.legId) ?? null,
        version: this.legVersion(q, scope.rfq.submissionDeadline),
      };
    });

    return {
      rfqNumber: scope.rfq.rfqNumber,
      incoterms: scope.rfq.incoterms,
      submissionDeadline: scope.rfq.submissionDeadline.toISOString(),
      currency: scope.rfq.currency ?? ff?.defaultCurrency ?? null,
      quoteValidityUntil: scope.rfq.quoteValidityUntil?.toISOString() ?? null,
      freightForwarder: { companyName: ff?.companyName ?? "" },
      legs,
    };
  }

  /**
   * S5.9.5 (D5) — which of the given quotes sit on a leg CLOSED to their forwarder.
   *
   * The rule itself lives in `leg-closure.ts`, NOT here: the deadline-reminder listener
   * (`rfq-schedule.listener.ts`) has to answer the same question — a forwarder with no leg still
   * open to them on an RFQ must stop being nudged to submit — and a second copy of "is this leg
   * still open?" is exactly the drift D5 warns about. This wrapper stays so the three call sites
   * below read unchanged.
   */
  private closedReasons(quotes: { id: string; legId: string }[]): Promise<Map<string, string>> {
    return closedLegReasons(this.prisma, quotes);
  }

  private quoteForLeg(scope: FfScope, legId: string) {
    const q = scope.quotes.find((x) => x.legId === legId);
    if (!q) throw new ForbiddenException("This leg is not part of your RFQ");
    return q;
  }

  /** Opaque fingerprint of everything a submit is priced against (S5.9 D10) — quote status,
   *  submission deadline, manifest snapshot, charge-config snapshot. Deliberately NOT
   *  `Quote.updatedAt`: the portal autosaves drafts, which bumps `@updatedAt` on every keystroke
   *  — that would invalidate the forwarder's own open page while they're still typing. Every
   *  input here is Prisma-parsed JSON/plain values (never a Decimal/Date instance), so
   *  JSON.stringify's output — and therefore this hash — is deterministic across reads and across
   *  processes for the same row content; see the Task-7 report for how this was verified.
   *  Deterministic across processes — plain sha256 over a stable field order. */
  private legVersion(
    q: { status: string; manifestSnapshot: unknown; chargeConfigSnapshot: unknown },
    submissionDeadline: Date,
  ): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          q.status,
          submissionDeadline.toISOString(),
          q.manifestSnapshot,
          q.chargeConfigSnapshot,
        ]),
      )
      .digest("hex")
      .slice(0, 16);
  }

  async saveDraft(scope: FfScope, legId: string, draft: QuoteDraft): Promise<{ savedAt: string }> {
    const q = this.quoteForLeg(scope, legId);
    // ── write guards (S5.9.5 D5) — `saveDraft` accepts EXACTLY what `submit` accepts, in the same
    // order. The brief for that task specified `submit` only; guarding this second call site too
    // is a deliberate widening, because this write is not confined to the leg it names: alongside
    // `Quote.draftJson` it upserts `Rfq.currency` and `Rfq.quoteValidityUntil` (below).
    //
    // S5.9.6 NARROWED THE REASON, TWICE — and this note has been rewritten to say what actually
    // survives, because the previous two versions of it are now both false. The first said
    // `quotation.service.ts`'s `buildInitialDraft` prices the client letter off the winner's
    // `draftJson`; it reads `submittedJson` now, which this method never writes. The second said
    // `comparison.service.ts` takes every offer's `currency` from `rfq.currency` on every read of
    // the compare grid; it reads `submitted.currency ?? rfq.currency` now. Do NOT read either as
    // a live reason. What the guards are still worth, in three verified limbs:
    //
    // (a) LEGACY ROWS. Every pricing reader is now `submittedJson` FIRST and the live `Rfq` row
    //     as a fallback — `comparison.service.ts` (:328 currency, :366 validUntil),
    //     `award.service.ts` (:1363 currency, frozen verbatim into `Query.awardSnapshot`) and
    //     `quotation.service.ts`'s `buildInitialDraft` (validUntil). `validateQuote` hard-blocks a
    //     submit with no currency (`Q_CURRENCY`) or no validity (`Q_VALIDITY`), so on any row
    //     submitted since S5.9.6 the fallback is dead. It is LIVE on a pre-S5.9.6 row, whose
    //     `submittedJson` was backfilled from a `draftJson` that could carry either field blank.
    //     On exactly those rows this write still re-denominates and re-dates a price it did not
    //     produce — the old defect, narrowed to one row vintage rather than repealed.
    //
    // (b) THE `Rfq` ROW IS SHARED, so this write reaches legs it does not name. `Rfq` is
    //     `@@unique([queryId, freightForwarderId])` (schema.prisma), and `submit` below freezes
    //     `currency`/`quoteValidityUntil` from `scope.rfq` into the authoritative draft. So a save
    //     arriving through a SETTLED leg moves the unit and the validity that this forwarder's
    //     OTHER, still-open legs on the same query will freeze at their next submit. To be exact
    //     about what this does NOT do: it never stops a forwarder moving those fields through a
    //     leg that is genuinely open — the portal's currency control is page-level and query-wide
    //     by design. It stops them arriving through one that is closed or settled. On a LOCKED
    //     query that difference is total: `generateClientQuote` requires every leg APPROVED with a
    //     shortlisted winner (award.service.ts's A6), so every quote fails the status check below
    //     and every non-winner leg fails `closedReasons` as well — and `closedReasons` deliberately
    //     excludes the winner's own leg (S5.9 D9), so the status check is the ONLY thing standing
    //     between that winner and the `Rfq` row their own legacy-vintage letter may still read.
    //
    // (c) CLOSED-LEG HYGIENE — the `closedReason` check below, unchanged from S5.9.5 D5.
    //
    // Together the two guards are what make S5.9.5 D6's blanket FF-portal exemption from the
    // query-wide lock safe.
    //
    // Nothing legitimate loses anything: the portal renders every non-RFQ_SENT/REQUOTED leg
    // read-only and has no autosave timer, so only a stale page or a hand-crafted request lands here.
    //
    // SCOPE, precisely: this admits `REQUOTED`, exactly as `submit` does — a forwarder asked to
    // revise must be able to type. `draftJson` on a REQUOTED quote is therefore the forwarder's
    // last SAVED state, never provably their submitted price — which was register A6, the open
    // issue this comment used to say "stands unchanged".
    //
    // S5.9.6 CLOSED IT, and not by constraining this write: `Quote.submittedJson` now carries the
    // offer, written by `submit` alone (below), while `draftJson` stays exactly what this call
    // makes it — the scratchpad. So this save may keep overwriting it freely; provenance is a
    // different column's job now, and anything asking "what did they actually submit?" must read
    // that one.
    const closedReason = (await this.closedReasons([q])).get(legId);
    if (closedReason) throw new ConflictException(closedReason);
    if (!WRITABLE_QUOTE_STATUSES.includes(q.status)) {
      throw new ConflictException(QUOTE_NOT_OPEN_REASON);
    }
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.quote.update({
        where: { id: q.id },
        data: { draftJson: draft as unknown as object },
      }),
      this.prisma.rfq.update({
        where: { id: scope.rfq.id },
        data: {
          currency: draft.currency ?? undefined,
          quoteValidityUntil: draft.quoteValidityUntil
            ? new Date(draft.quoteValidityUntil)
            : undefined,
        },
      }),
    ]);
    return { savedAt: now.toISOString() };
  }

  async submit(
    scope: FfScope,
    legId: string,
    input: SubmitQuoteInput,
  ): Promise<{ quoteId: string; status: "QUOTED" }> {
    const q = this.quoteForLeg(scope, legId);

    // ── stale-page guard (S5.9 D10) — MUST run before the status guard below: a page that went
    // stale because the basis moved (e.g. a requote landed, the RFQ was re-frozen) needs the
    // actionable "please refresh" message, not the generic "already submitted or is not open" one
    // the status guard would otherwise produce for the very same stale request. ──
    if (this.legVersion(q, scope.rfq.submissionDeadline) !== input.version) {
      throw new ConflictException(
        "This RFQ has been updated — please refresh the page before submitting.",
      );
    }

    // ── leg-closed guard (S5.9.5 D5) — AFTER the stale-page guard above and BEFORE the
    // quote-status guard below, for the same reason the stale-page guard states: the most
    // actionable message wins. A stale page's "please refresh" still outranks this one (refreshing
    // is what surfaces the closed leg in the first place); and this one outranks the generic
    // "already submitted or is not open", which is the wrong story for a forwarder whose own quote
    // is perfectly open and whose LEG is what closed. ──
    const closedReason = (await this.closedReasons([q])).get(legId);
    if (closedReason) throw new ConflictException(closedReason);

    if (!WRITABLE_QUOTE_STATUSES.includes(q.status)) {
      throw new ConflictException(QUOTE_NOT_OPEN_REASON);
    }

    const manifest = q.manifestSnapshot as ManifestSnapshot;
    const snap = (q.chargeConfigSnapshot as ChargeConfigSnapshot | null) ?? {
      lines: [],
      warehouseIncluded: false,
    };
    const stored = ((
      await this.prisma.quote.findUnique({ where: { id: q.id }, select: { draftJson: true } })
    )?.draftJson ?? {}) as Partial<QuoteDraft>;

    // ── re-derive the AUTHORITATIVE draft: immutables from the manifest/classifier, editable from the stored draft ──
    const whLegs = scope.quotes.map((x) => ({
      originPointId: x.leg.originPoint?.id ?? null,
      destinationPointId: x.leg.destinationPoint?.id ?? null,
      mode: (x.leg.mode ?? null) as "AIR" | "SEA" | "ROAD" | null,
    }));
    const whPointIds = scope.quotes.flatMap((x) =>
      [x.leg.originPoint, x.leg.destinationPoint]
        .filter((p): p is NonNullable<typeof p> => !!p && p.type === "WAREHOUSE")
        .map((p) => p.id),
    );
    const whPos = classifyWarehousePositions(whLegs, whPointIds);

    // Drop stale catalogue charges from the stored draft before they reach validation/
    // materialization — defense-in-depth alongside change-order.strategy.ts's draftJson-clear on
    // re-freeze (which is the primary fix; this covers any stale/unexpected charge that still
    // reaches submit regardless). A charge survives only if it's (a) a catalogue line whose
    // definitionKey is still present in the FROZEN chargeConfigSnapshot, or (b) a genuine custom
    // [+ Add Charge] line (neither definitionKey nor presetKey). Without this, a stale charge
    // whose definitionKey was removed from the config is "custom" to NEITHER validateQuote path
    // (it isn't in `activeLines` for Q_PRICED, and it has a definitionKey so it isn't the
    // !definitionKey && !presetKey custom check either) — it silently rides through unvalidated
    // into chargeAmount(c)'s `c.amount!` force-unwrap (NOT NULL crash if never priced, or a
    // phantom charge summed into grandTotal if it was).
    const validKeys = new Set(snap.lines.map((l) => l.definitionKey));
    const staleFilteredCharges = (stored.charges ?? []).filter(
      (c) =>
        (c.definitionKey && validKeys.has(c.definitionKey)) || (!c.definitionKey && !c.presetKey),
    );

    const draft: QuoteDraft = {
      legId,
      mode: q.leg.mode as "AIR" | "SEA" | "ROAD",
      currency: scope.rfq.currency,
      quoteValidityUntil: scope.rfq.quoteValidityUntil?.toISOString() ?? null,
      // v3: one leg-level chargeable weight + notes (was per-QuoteCargoLine chargedWeightKg).
      chargedWeightKg: stored.chargedWeightKg ?? null,
      notes: stored.notes ?? null,
      cargo: manifest.cargo.map((c) => ({
        packageId: c.packageId,
        grossWtKg: Number(c.grossWt),
        cbm: Number(c.volumeCbm ?? 0),
      })),
      charges: staleFilteredCharges.map((c) => ({ ...c })),
      trucking: (stored.trucking ?? []).map((t) => ({ ...t })),
      seaRates: (stored.seaRates ?? []).map((r) => ({ ...r })),
      warehouse: (snap.warehouseIncluded ? (stored.warehouse ?? []) : []).map((w) => ({
        ...w,
        position: whPos[w.warehousePointId] ?? w.position,
      })),
      transit: stored.transit ?? null,
      dgSurchargeNote: stored.dgSurchargeNote ?? null,
      termsConditions: stored.termsConditions ?? null,
    };

    // ── scope-check: every trucking/warehouse point must belong to this FF's legs ──
    const scopedPointIds = new Set(
      scope.quotes
        .flatMap((x) => [x.leg.originPoint?.id, x.leg.destinationPoint?.id])
        .filter((id): id is string => !!id),
    );
    const badPoint =
      draft.trucking.find((t) => !scopedPointIds.has(t.legEndpointPointId))?.legEndpointPointId ??
      draft.warehouse.find((w) => !scopedPointIds.has(w.warehousePointId))?.warehousePointId;
    if (badPoint)
      throw new UnprocessableEntityException({
        findings: [
          {
            rule: "SCOPE",
            severity: "blocking",
            scope: { type: "point", id: badPoint },
            message: "A priced point is not part of this RFQ's legs.",
          },
        ],
      });

    // ── validate (design §3.2, submit-gate v4/Round 4 — common charges gated once, freight
    // per-variant, every dual-rate mode requires its freight — Round-4 D6 made Road mandatory
    // too) — imported wholesale from @svyft/shared, never mirrored, so this gate can't drift. ──
    const findings: Finding[] = validateQuote(
      draft,
      scope.rfq.submissionDeadline.toISOString(),
      new Date().toISOString(),
      snap.lines,
    );
    if (findings.length) throw new UnprocessableEntityException({ findings });

    // ── materialize (one tx) ──
    const totals = computeQuoteTotals(draft);
    try {
      await this.prisma.$transaction(async (tx) => {
        // Delete existing child rows
        await tx.quoteCargoLine.deleteMany({ where: { quoteId: q.id } });
        await tx.chargeLine.deleteMany({ where: { quoteId: q.id } });
        await tx.truckingCharge.deleteMany({ where: { quoteId: q.id } });
        await tx.seaFreightRate.deleteMany({ where: { quoteId: q.id } });
        await tx.warehouseStagingLine.deleteMany({ where: { quoteId: q.id } });
        await tx.transitPlan.deleteMany({ where: { quoteId: q.id } });

        // Create child rows
        // v3: chargedWeightKg moved off QuoteCargoLine onto Quote (leg-level) — see the
        // quote.update below.
        await tx.quoteCargoLine.createMany({
          data: draft.cargo.map((c) => ({
            quoteId: q.id,
            packageId: c.packageId,
          })),
        });

        // v4 (Round 4): every charge is COMMON — one row per definitionKey (or one row per ad-hoc
        // [+ Add Charge] custom line), priced ONCE, not once per rate-variant column. An unpriced
        // row is legitimately null post-gate only when the leg was never "started" at all (Q_RATE
        // would have blocked otherwise) — filter it out here for the same reason the trucking/
        // seaRates filters below exist: so chargeAmount(c)'s `c.amount!` force-unwrap is always
        // safe. `rateVariant` is force-written to `null` rather than forwarded from `c.rateVariant`
        // — the QuoteDraftCharge TYPE already narrows it to the literal `null` (Task 1), but this
        // is the wire boundary: a stale/legacy client could still technically PATCH a real
        // ChargeRateVariant past the (shape-only) Zod schema, and nothing here should ever let a
        // charge materialize as anything but common.
        await tx.chargeLine.createMany({
          data: draft.charges.filter(chargeCellPriced).map((c, i) => ({
            quoteId: q.id,
            zone: c.zone,
            definitionKey: c.definitionKey ?? null,
            label: c.label,
            isPreset: c.presetKey != null,
            presetKey: c.presetKey,
            amount: chargeAmount(c),
            note: c.note,
            sortOrder: i,
            pieceWeightKg: c.pieceWeightKg ?? null,
            airlineLimitKg: c.airlineLimitKg ?? null,
            ratePerExcessKg: c.ratePerExcessKg ?? null,
            billOfLadingType: c.billOfLadingType ?? null,
            rateVariant: null,
          })),
        });

        // Q_RATE only requires >=1 of the two rate variants filled — a dual-rate draft can
        // legitimately carry the other as amount=null (blank rate → "–" for that variant, per
        // computeQuoteTotals). Filter here so `amount!` below is safe and an unpriced variant
        // never hits the NOT NULL `amount` column.
        for (const t of draft.trucking.filter((t) => t.amount != null)) {
          await tx.truckingCharge.create({
            data: {
              quoteId: q.id,
              legEndpointPointId: t.legEndpointPointId,
              truckingType: t.truckingType,
              basis: t.basis,
              amount: t.amount!,
              remarks: t.remarks,
              rateVariant: t.rateVariant,
              tonnage: t.tonnage,
            },
          });
        }

        for (const r of draft.seaRates.filter((r) => r.amount != null)) {
          await tx.seaFreightRate.create({
            data: {
              quoteId: q.id,
              rateVariant: r.rateVariant,
              containerSize: r.containerSize,
              amount: r.amount!,
              remarks: r.remarks,
            },
          });
        }

        for (const w of draft.warehouse) {
          await tx.warehouseStagingLine.create({
            data: {
              quoteId: q.id,
              warehousePointId: w.warehousePointId,
              position: w.position,
              label: w.label,
              isPreset: false,
              amount: w.amount!,
              cargoAcceptanceWindow: w.cargoAcceptanceWindow,
              cfsCode: w.cfsCode ?? null,
              side: w.side ?? null,
            },
          });
        }

        // v4 (Round 4, design D2): Road stays one TransitPlan row PER PRICED variant (DEDICATED
        // and GROUPAGE can genuinely commit to different transit times); Sea/Air collapse to
        // exactly ONE common TransitPlan (`rateVariant: null`) the moment ANY freight variant is
        // priced — a single vessel/voyage (Sea) or the one implicit column (Air) never arrives
        // twice, so pricing both Sea columns (FCL+LCL) still writes only one row, not two. This
        // mirrors quote-engine.ts's private requiredTransitKeys/variantsForTransit (the Q_TRANSIT
        // gate) so materialize can never write a row the gate wouldn't have required a days value
        // for, or skip one it would have. `transitKeys` are the technical keys into
        // `guaranteedTransitDaysByVariant`: Road's are its own real ChargeRateVariant (DEDICATED/
        // GROUPAGE, unchanged from v3); Sea/Air's are the SEA_VARIANT_KEY/AIR_VARIANT_KEY
        // sentinels, which both materialize as `rateVariant: null` (matching ChargeLine/
        // TruckingCharge/SeaFreightRate's null-for-no-real-variant convention).
        if (draft.transit) {
          const transit = draft.transit;
          const pricedVariants = variantsForMode(draft.mode).filter((v) =>
            isVariantPriced(draft, v),
          );
          const transitKeys: TransitVariantKey[] =
            pricedVariants.length === 0
              ? []
              : draft.mode === "ROAD"
                ? pricedVariants.filter((v): v is ChargeRateVariant => v != null)
                : variantsForTransit(draft.mode); // SEA -> [SEA_VARIANT_KEY], AIR/unresolved -> [AIR_VARIANT_KEY]
          for (const key of transitKeys) {
            const rateVariantColumn =
              key === AIR_VARIANT_KEY || key === SEA_VARIANT_KEY ? null : key;
            await tx.transitPlan.create({
              data: {
                quoteId: q.id,
                rateVariant: rateVariantColumn,
                carrier: transit.carrier ?? null,
                flightVoyageNo: transit.flightVoyageNo ?? null,
                departureDate: transit.departureDate ? new Date(transit.departureDate) : null,
                arrivalDate: transit.arrivalDate ? new Date(transit.arrivalDate) : null,
                carrierSurcharge: transit.carrierSurcharge ?? null,
                guaranteedTransitDays: transit.guaranteedTransitDaysByVariant[key] ?? null,
                plannedPickupDate: transit.plannedPickupDate
                  ? new Date(transit.plannedPickupDate)
                  : null,
                airline: transit.airline ?? null,
                flightNumber: transit.flightNumber ?? null,
                plannedDeparture: transit.plannedDeparture
                  ? new Date(transit.plannedDeparture)
                  : null,
                plannedArrival: transit.plannedArrival ? new Date(transit.plannedArrival) : null,
                shippingLine: transit.shippingLine ?? null,
                vesselVoyage: transit.vesselVoyage ?? null,
                etd: transit.etd ? new Date(transit.etd) : null,
                eta: transit.eta ? new Date(transit.eta) : null,
              },
            });
          }
        }

        await tx.quote.update({
          where: { id: q.id },
          data: {
            grandTotal: Math.max(...totals.variants.map((v) => v.grandTotal), 0),
            totalChargeableWeightT: null, // column kept for now; unused (kg lives on Quote.chargedWeightKg)
            chargedWeightKg: draft.chargedWeightKg,
            notes: draft.notes,
            dgSurchargeNote: draft.dgSurchargeNote,
            termsConditions: draft.termsConditions,
            submittedAt: new Date(),
            // Seed the scratchpad with what was just submitted — mirrors saveDraft()'s own write
            // above, same column, same shape. This column is NO LONGER "the record" of the offer:
            // S5.9.6 gave that job to `submittedJson` just below, because a later saveDraft can
            // overwrite this one. It is written here so the forwarder's own portal re-reads
            // (resolveScope's GET → pre-fill/preview/print) show what they sent, and so a
            // re-quote opens on their previous numbers rather than a blank matrix. Previously this
            // wrote `Prisma.DbNull`, which made `resolveScope`'s GET (below) fall back to
            // `seedQuoteDraft` — a blank per-variant matrix indistinguishable from a leg nobody
            // had touched — for every QUOTED leg, so the FF-portal preview/print/
            // AlreadySubmittedSummary all showed empty charges post-submission (design §6 finding
            // #8). Safe to keep: a change-order re-freeze only clears `draftJson` for the
            // REFRESHING (RFQ_SENT) quotes on a leg (change-order.strategy.ts) — a QUOTED quote is
            // INVALIDATED instead, and its `draftJson` (like the rest of its snapshot) is left
            // alone as history, never re-frozen. `draft` here (not the client-echoed `stored`) —
            // the re-derived/validated/materialized object — so what's persisted always agrees
            // with what actually got written to ChargeLine/TruckingCharge/SeaFreightRate/
            // TransitPlan/Quote, never a stale or since-filtered client draft.
            draftJson: draft as unknown as object,
            // S5.9.6 (register A6) — THE OFFER. Same `draft` object, same write, so the two can
            // never disagree at submit time; they diverge only afterwards, when `saveDraft`
            // overwrites the scratchpad above with whatever the forwarder types next (it has no
            // version hash and admits REQUOTED, so a half-typed revision lands there and used to
            // be indistinguishable from a submitted price). Written HERE and nowhere else: this
            // is the only site in the codebase that stamps `submittedAt`, and the two belong to
            // the same event.
            submittedJson: draft as unknown as object,
          },
        });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") {
        throw new UnprocessableEntityException({
          findings: [
            {
              rule: "FK",
              severity: "blocking",
              scope: { type: "leg", id: legId },
              message: "A priced pickup/warehouse point no longer exists — refresh and re-price.",
            },
          ],
        });
      }
      throw e;
    }

    // ── fire AFTER the tx (the one door) → RFQ_SENT→QUOTED → leg/query rollups ──
    await this.status.fire("quote", q.id, QuoteEvent.SUBMIT, { queryId: scope.rfq.queryId });

    // ── comms (post-commit; compose-&-log) — the submit is already committed (quote is
    // QUOTED); a comms failure here must NOT turn a successful submit into a 500
    // (mirrors the Task-9 post-commit hardening in RfqService.distribute). ──
    try {
      const rfq = await this.prisma.rfq.findUnique({
        where: { id: scope.rfq.id },
        select: {
          rfqNumber: true,
          tenantId: true,
          freightForwarder: { select: { companyName: true, email: true } },
        },
      });
      const query = await this.prisma.query.findUnique({
        where: { id: scope.rfq.queryId },
        select: { assignedUserId: true },
      });
      let execIds: string[] = query?.assignedUserId ? [query.assignedUserId] : [];
      if (execIds.length === 0) {
        const execs = await this.prisma.user.findMany({
          where: { role: Role.EXECUTIVE, isActive: true },
          select: { id: true },
        });
        execIds = execs.map((u) => u.id);
      }
      const tokens = {
        RFQ_Number: rfq?.rfqNumber ?? "",
        FF_Name: rfq?.freightForwarder?.companyName ?? "",
        Leg_Name: q.leg.legCode ?? "",
      };
      // Cancel the RFQ's remaining reminders FIRST — a dispatch throw below must not skip it.
      await this.scheduled.cancel("RFQ", scope.rfq.id, "rfq.reminder");
      await this.dispatcher.dispatch("rfq.submission_ack", {
        scope: { entityType: "QUERY", entityId: scope.rfq.queryId },
        tokens,
        recipients: { EMAIL: rfq?.freightForwarder?.email ? [rfq.freightForwarder.email] : [] },
        tenantId: rfq?.tenantId ?? null,
      });
      await this.dispatcher.dispatch("quote.received", {
        scope: { entityType: "QUERY", entityId: scope.rfq.queryId },
        tokens,
        recipients: { IN_APP: execIds },
        tenantId: rfq?.tenantId ?? null,
      });
    } catch (err) {
      this.logger.error(`post-submit comms failed for quote ${q.id}`, err as Error);
    }

    return { quoteId: q.id, status: "QUOTED" };
  }
}
