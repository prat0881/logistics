import { Injectable } from "@nestjs/common";
import { AIR_CHARGE_PRESETS, SEA_CHARGE_PRESETS, classifyWarehousePositions } from "@svyft/shared";
import type { FfPortalRfqDto, FfPortalLegDto, ManifestSnapshot, QuoteDraft } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { ConfigDataService } from "../config/config-data.service";
import type { FfScope } from "../rfq/rfq-token.service";

@Injectable()
export class FfPortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigDataService,
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
}
