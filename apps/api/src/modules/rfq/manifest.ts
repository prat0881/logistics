import type { Incoterms } from "@prisma/client";
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
    cargo: leg.legCargo.map((lc) => ({
      cargoItemId: lc.cargoItem.id,
      poReference: lc.cargoItem.poReference,
      productName: lc.cargoItem.productName,
      hsCode: lc.cargoItem.hsCode,
      packageType: lc.cargoItem.packageType,
      isDangerous: lc.cargoItem.isDangerous,
      qty: lc.cargoItem.qty,
      dimL: lc.cargoItem.dimL.toString(),
      dimW: lc.cargoItem.dimW.toString(),
      dimH: lc.cargoItem.dimH.toString(),
      netWt: lc.cargoItem.netWt ? lc.cargoItem.netWt.toString() : null,
      grossWt: lc.cargoItem.grossWt.toString(),
      volumeCbm: lc.cargoItem.volumeCbm ? lc.cargoItem.volumeCbm.toString() : null,
    })),
    frozenAt: frozenAt.toISOString(),
  };
}
