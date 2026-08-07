import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  classifyWarehousePositions,
  validateQuote,
  computeQuoteTotals,
  computeHeavyWeightAmount,
  variantsForMode,
  AIR_VARIANT_KEY,
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
} from "@svyft/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { StatusService } from "../status/status.service";
import { NotificationDispatcher } from "../comms/notification-dispatcher.service";
import { ScheduledEventService } from "../comms/scheduled-event.service";
import type { FfScope } from "../rfq/rfq-token.service";

/** Calc line amount (design §7): HEAVY_WEIGHT_CALC lines compute from the FF-entered piece
 *  weight / airline limit / excess rate; every other charge line carries its own amount. */
const chargeAmount = (c: QuoteDraftCharge): number =>
  c.pieceWeightKg != null && c.airlineLimitKg != null && c.ratePerExcessKg != null
    ? computeHeavyWeightAmount(c.pieceWeightKg, c.airlineLimitKg, c.ratePerExcessKg)
    : c.amount!;

// ── v3 per-variant helpers (design §3.1/§5) ──────────────────────────────────────────────────
// The three functions below mirror quote-engine.ts's private chargeCellPriced/variantRate/
// isVariantPriced EXACTLY (same rules validateQuote used to decide which variant columns are
// "priced" and therefore required full charge pricing + a transit-days value). They're
// duplicated locally — same pattern as chargeAmount() above mirroring effectiveChargeAmount() —
// because materialize (submit(), below) needs the identical "priced variant" verdict for two
// purposes: (a) drop any charge cell that isn't priced before force-unwrapping its amount (an
// untouched variant's cells are legitimately null post-gate — same reasoning as the existing
// trucking/seaRates amount!=null filters), and (b) write exactly one TransitPlan row per priced
// variant, no more, no fewer.

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

/** Has variant `v` had *anything* entered against it — its freight-rate cell or any charge cell?
 *  An untouched variant materializes NO ChargeLine cells and gets NO TransitPlan row. */
function isVariantPriced(draft: QuoteDraft, v: ChargeRateVariant | null): boolean {
  if (variantRate(draft, v) != null) return true;
  return draft.charges.some((c) => c.rateVariant === v && chargeCellPriced(c));
}

/** resolveScope seed (design §5): when a leg has no saved draftJson yet, GET returns a starter
 *  QuoteDraft instead of null — the full per-variant charge matrix (every active chargeConfig
 *  line × the mode's rate-variant columns, one QuoteDraftCharge per cell, `amount: null`; Air's
 *  single implicit column seeds `rateVariant: null` for free via variantsForMode("AIR") ===
 *  [null]) plus a blank leg-level chargeable weight, notes, and per-variant transit-days map —
 *  so the portal always has an addressable cell for every (line, variant) pair rather than the
 *  client reconstructing the cross-product itself. Everything else starts empty/null; submit()
 *  re-derives currency/quoteValidityUntil/cargo from the RFQ/manifest regardless of what a client
 *  echoes back from here, so seeding them is unnecessary (kept null/empty, not guessed). */
function seedQuoteDraft(
  legId: string,
  mode: FreightMode | null,
  lines: ResolvedChargeLine[],
): QuoteDraft {
  const variants = variantsForMode(mode);
  return {
    legId,
    mode,
    currency: null,
    quoteValidityUntil: null,
    chargedWeightKg: null,
    notes: null,
    cargo: [],
    charges: lines.flatMap((l) =>
      variants.map((v) => ({
        zone: l.zone,
        definitionKey: l.definitionKey,
        presetKey: null,
        label: l.label,
        amount: null,
        rateVariant: v,
      })),
    ),
    trucking: [],
    seaRates: [],
    warehouse: [],
    transit: { departureDate: null, arrivalDate: null, guaranteedTransitDaysByVariant: {} },
    dgSurchargeNote: null,
    termsConditions: null,
  };
}

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
        // v3 (design §5): seed the per-variant matrix when there's no saved draft yet — see
        // seedQuoteDraft above — instead of returning null.
        draft: q.draftJson
          ? (q.draftJson as QuoteDraft)
          : seedQuoteDraft(q.legId, mode, snap.lines),
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

  private quoteForLeg(scope: FfScope, legId: string) {
    const q = scope.quotes.find((x) => x.legId === legId);
    if (!q) throw new ForbiddenException("This leg is not part of your RFQ");
    return q;
  }

  async saveDraft(scope: FfScope, legId: string, draft: QuoteDraft): Promise<{ savedAt: string }> {
    const q = this.quoteForLeg(scope, legId);
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

  async submit(scope: FfScope, legId: string): Promise<{ quoteId: string; status: "QUOTED" }> {
    const q = this.quoteForLeg(scope, legId);
    if (q.status !== "RFQ_SENT") {
      throw new ConflictException("This quote has already been submitted or is not open");
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

    // ── validate (design §3.2, submit-gate v3 — per-variant-column rules) ──
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

        // v3: charges are per-variant matrix cells (rateVariant null = Air's single implicit
        // column or a non-variant/custom line). An untouched variant's cells are legitimately
        // null post-gate (Q_PRICED only requires full pricing for a variant that's actually
        // priced) — filter them out here for the same reason the trucking/seaRates filters below
        // exist: so chargeAmount(c)'s `c.amount!` force-unwrap is always safe.
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
            rateVariant: c.rateVariant,
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

        // v3: one TransitPlan row per PRICED variant (was a single row per quote) — an untouched
        // variant has no data worth persisting and Q_TRANSIT never required a days value for it.
        // The Air transit-days bridge: the draft keys Air's days under AIR_VARIANT_KEY ("AIR")
        // since guaranteedTransitDaysByVariant needs a real object key, but Air's TransitPlan row
        // itself still gets `rateVariant: null` (v is null for Air — variantsForMode("AIR") ===
        // [null]) to match ChargeLine/TruckingCharge/SeaFreightRate's null-for-Air convention.
        if (draft.transit) {
          const transit = draft.transit;
          const pricedVariants = variantsForMode(draft.mode).filter((v) =>
            isVariantPriced(draft, v),
          );
          for (const v of pricedVariants) {
            await tx.transitPlan.create({
              data: {
                quoteId: q.id,
                rateVariant: v,
                carrier: transit.carrier ?? null,
                flightVoyageNo: transit.flightVoyageNo ?? null,
                departureDate: transit.departureDate ? new Date(transit.departureDate) : null,
                arrivalDate: transit.arrivalDate ? new Date(transit.arrivalDate) : null,
                carrierSurcharge: transit.carrierSurcharge ?? null,
                guaranteedTransitDays:
                  transit.guaranteedTransitDaysByVariant[v ?? AIR_VARIANT_KEY] ?? null,
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
            // Keep the SUBMITTED (re-derived, validated, materialized) draft as the record —
            // mirrors saveDraft()'s own write above, same column, same shape. Previously this
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
