import { ConflictException, ForbiddenException, Injectable, Logger, UnprocessableEntityException } from "@nestjs/common";
import {
  AIR_CHARGE_PRESETS,
  SEA_CHARGE_PRESETS,
  classifyWarehousePositions,
  validateQuote,
  computeQuoteTotals,
  computeChargeableWeight,
  QuoteEvent,
  Role,
} from "@svyft/shared";
import type { FfPortalRfqDto, FfPortalLegDto, ManifestSnapshot, QuoteDraft, Finding } from "@svyft/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ConfigDataService } from "../config/config-data.service";
import { StatusService } from "../status/status.service";
import { NotificationDispatcher } from "../comms/notification-dispatcher.service";
import { ScheduledEventService } from "../comms/scheduled-event.service";
import type { FfScope } from "../rfq/rfq-token.service";

@Injectable()
export class FfPortalService {
  private readonly logger = new Logger(FfPortalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigDataService,
    private readonly status: StatusService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly scheduled: ScheduledEventService,
  ) {}

  async resolveScope(scope: FfScope): Promise<FfPortalRfqDto> {
    const ff = await this.prisma.freightForwarder.findUnique({
      where: { id: scope.rfq.freightForwarderId },
      select: { companyName: true, defaultCurrency: true },
    });
    const densities = await this.config.densityFactors(); // [{ mode, kgPerCbm }]
    const densityOf = (mode: string | null) => densities.find((d) => d.mode === mode)?.kgPerCbm ?? null;

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
      const mode = q.leg.mode;
      const presets = mode === "AIR" ? AIR_CHARGE_PRESETS : mode === "SEA" ? SEA_CHARGE_PRESETS : [];
      const density = densityOf(mode);
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
        mode: mode as FfPortalLegDto["mode"],
        manifest,
        endpoints,
        seededCharges: presets.map((p) => ({
          zone: p.zone,
          presetKey: p.presetKey,
          label: p.label,
          isPreset: true as const,
          amount: null,
        })),
        seededDensity:
          density == null
            ? []
            : manifest.cargo.map((c) => ({ cargoItemId: c.cargoItemId, freightDensity: density })),
        draft: q.draftJson ? (q.draftJson as QuoteDraft) : null,
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
      this.prisma.quote.update({ where: { id: q.id }, data: { draftJson: draft as unknown as object } }),
      this.prisma.rfq.update({
        where: { id: scope.rfq.id },
        data: {
          currency: draft.currency ?? undefined,
          quoteValidityUntil: draft.quoteValidityUntil ? new Date(draft.quoteValidityUntil) : undefined,
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
    const stored = (
      (await this.prisma.quote.findUnique({ where: { id: q.id }, select: { draftJson: true } }))?.draftJson ?? {}
    ) as Partial<QuoteDraft>;

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

    const draft: QuoteDraft = {
      legId,
      mode: q.leg.mode as "AIR" | "SEA" | "ROAD",
      currency: scope.rfq.currency,
      quoteValidityUntil: scope.rfq.quoteValidityUntil?.toISOString() ?? null,
      cargo: manifest.cargo.map((c) => ({
        cargoItemId: c.cargoItemId,
        grossWtT: Number(c.grossWt) / 1000,
        cbm: Number(c.volumeCbm ?? 0),
        isDangerous: c.isDangerous,
        freightDensity: stored.cargo?.find((s) => s.cargoItemId === c.cargoItemId)?.freightDensity ?? null,
      })),
      charges: (stored.charges ?? []).map((c) => ({ ...c })),
      trucking: (stored.trucking ?? []).map((t) => ({ ...t })),
      warehouse: (stored.warehouse ?? []).map((w) => ({
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

    // ── validate (§10.4 Q1–Q8) ──
    const findings: Finding[] = validateQuote(
      draft,
      scope.rfq.submissionDeadline.toISOString(),
      new Date().toISOString(),
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
        await tx.warehouseStagingLine.deleteMany({ where: { quoteId: q.id } });
        await tx.transitPlan.deleteMany({ where: { quoteId: q.id } });

        // Create child rows
        await tx.quoteCargoLine.createMany({
          data: draft.cargo.map((c) => ({
            quoteId: q.id,
            cargoItemId: c.cargoItemId,
            freightDensity: c.freightDensity!,
            chargeableWeightT: computeChargeableWeight(c.grossWtT, c.cbm, c.freightDensity!),
          })),
        });

        await tx.chargeLine.createMany({
          data: draft.charges.map((c, i) => ({
            quoteId: q.id,
            zone: c.zone,
            label: c.label,
            isPreset: c.presetKey != null,
            presetKey: c.presetKey,
            amount: c.amount!,
            note: c.note,
            sortOrder: i,
          })),
        });

        for (const t of draft.trucking) {
          await tx.truckingCharge.create({
            data: {
              quoteId: q.id,
              legEndpointPointId: t.legEndpointPointId,
              truckingType: t.truckingType,
              basis: t.basis,
              amount: t.amount!,
              remarks: t.remarks,
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
            },
          });
        }

        if (draft.transit) {
          await tx.transitPlan.create({
            data: {
              quoteId: q.id,
              carrier: draft.transit.carrier ?? null,
              flightVoyageNo: draft.transit.flightVoyageNo ?? null,
              departureDate: new Date(draft.transit.departureDate!),
              arrivalDate: new Date(draft.transit.arrivalDate!),
              carrierSurcharge: draft.transit.carrierSurcharge ?? null,
              guaranteedTransitDays: draft.transit.guaranteedTransitDays ?? null,
            },
          });
        }

        await tx.quote.update({
          where: { id: q.id },
          data: {
            totalChargeableWeightT: totals.totalChargeableWeightT,
            grandTotal: totals.grandTotal,
            dgSurchargeNote: draft.dgSurchargeNote,
            termsConditions: draft.termsConditions,
            submittedAt: new Date(),
            draftJson: Prisma.DbNull,
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
        select: { rfqNumber: true, tenantId: true, freightForwarder: { select: { companyName: true, email: true } } },
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
