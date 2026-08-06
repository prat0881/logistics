import type { Incoterms } from "@prisma/client";
import { effectiveTags } from "@svyft/shared";
import type { ManifestSnapshot } from "@svyft/shared";
import type { LegRfqContext } from "./leg-context";

export function buildManifestSnapshot(
  ctx: LegRfqContext,
  query: { incoterms: Incoterms | null },
  frozenAt: Date,
): ManifestSnapshot {
  const { leg } = ctx;
  return {
    legId: leg.id,
    legCode: leg.legCode,
    legName: leg.legName,
    mode: leg.mode,
    incoterms: query.incoterms,
    origin: leg.originPoint
      ? { country: leg.originPoint.country, name: leg.originPoint.name, city: leg.originPoint.city }
      : null,
    destination: leg.destinationPoint
      ? { country: leg.destinationPoint.country, name: leg.destinationPoint.name, city: leg.destinationPoint.city }
      : null,
    readyDate: leg.readyDate ? leg.readyDate.toISOString() : null,
    targetDelivery: leg.targetDelivery ? leg.targetDelivery.toISOString() : null,
    cargo: leg.legPackages.map((lp) => {
      const p = lp.package;
      return {
        packageId: p.id,
        packageNo: p.packageNo,
        packageType: p.packageType,
        packageCount: p.packageCount,
        dimL: p.dimL.toString(),
        dimW: p.dimW.toString(),
        dimH: p.dimH.toString(),
        netWt: p.netWt ? p.netWt.toString() : null,
        grossWt: p.grossWt.toString(),
        volumeCbm: p.volumeCbm ? p.volumeCbm.toString() : null,
        tags: effectiveTags({ tags: p.tags, items: p.items }),
      };
    }),
    frozenAt: frozenAt.toISOString(),
  };
}
