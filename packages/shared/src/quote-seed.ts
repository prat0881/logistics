import {
  type ChargeZone,
  type QuoteDraft,
  type QuoteDraftCharge,
  type QuoteDraftTrucking,
  type QuoteDraftSeaRate,
  type QuoteDraftWarehouse,
  type WarehousePosition,
} from "./quote";
import type { FreightMode } from "./config";

// ── The ONE pricing seed (FF Portal, design §3.1/§5; v4 — charges common, freight per-variant) ──
// A fresh leg's starter QuoteDraft is seeded in TWO places — the server (ff-portal.service.ts's
// `seedQuoteDraft`, returned by resolveScope's GET when a leg has no `draftJson` yet) and the
// client (draftFromDto's non-`leg.draft` fallback). Those two used to duplicate the seed logic
// and DIVERGED: the server seeded `trucking: []` / `seaRates: []`, so once resolveScope started
// ALWAYS returning a server seed for a fresh leg, the client's own (correct) trucking/seaRates
// seeding became dead code and every Road-/Sea-freight matrix cell rendered as a disabled
// "not applicable" cell — the FF literally could not enter the freight rate. This module is the
// single source of truth both sites now call, so the seed can never drift again.

/** The charge lines a matrix seeds its cells from — the intersection of what BOTH seed sites
 *  carry (server: `ResolvedChargeLine`; client: `FfPortalSeededCharge`). */
export interface SeedChargeLine {
  zone: ChargeZone | null;
  definitionKey?: string | null;
  presetKey?: string | null;
  label: string;
}

/** The pricing arrays of a fresh QuoteDraft — the common charge set plus the mode's per-variant
 *  freight-rate rows (Road → `trucking`, Sea → `seaRates`; Air seeds neither — its freight is the
 *  AIR_MAIN_FREIGHT charge line inside `charges`, common like every other line). Everything else
 *  on the draft (currency/validity/cargo/warehouse/transit/…) is seeded by each caller from its
 *  own sources. */
export type QuoteDraftPricingSeed = Pick<QuoteDraft, "charges" | "trucking" | "seaRates">;

/**
 * Seed the pricing of a fresh QuoteDraft (design §3.1, v4 — partially reverses v3): ONE common
 * `amount: null` row per seeded charge line (`rateVariant: null`, regardless of mode — v4 dropped
 * the per-rate-variant fan-out; every charge is priced once, not once per column), plus the
 * mode's blank freight-rate rows (Road → Dedicated+Groupage `trucking`, Sea → FCL+LCL `seaRates`,
 * keyed off the leg's first endpoint for Road) — freight is the one thing that STAYS per-variant,
 * and it was never seeded from `lines`/`charges` to begin with. Pure — no I/O, no dates.
 */
export function seedQuoteDraftPricing(
  lines: SeedChargeLine[],
  mode: FreightMode | null,
  firstEndpointPointId: string,
): QuoteDraftPricingSeed {
  const charges: QuoteDraftCharge[] = lines.map((l) => ({
    zone: l.zone,
    definitionKey: l.definitionKey ?? null,
    presetKey: l.presetKey ?? null,
    label: l.label,
    amount: null,
    rateVariant: null,
  }));

  // Road is dual-rate (design §7): seed both Dedicated + Groupage rows up front so the FF can
  // price either or both — an unpriced row stays `amount: null` (blank rate → "–",
  // computeQuoteTotals). Both rows key off the same leg endpoint (Road legs quote at the leg
  // level, not per-endpoint).
  const trucking: QuoteDraftTrucking[] =
    mode === "ROAD"
      ? (["DEDICATED", "GROUPAGE"] as const).map((rv) => ({
          legEndpointPointId: firstEndpointPointId,
          truckingType: rv,
          basis: "PER_TRUCK" as const,
          amount: null,
          rateVariant: rv,
          tonnage: null,
        }))
      : [];

  // Sea is dual-rate too (design §7): seed both FCL/LCL rows up front, same pattern as Road's
  // Dedicated/Groupage — an unpriced row stays `amount: null`.
  const seaRates: QuoteDraftSeaRate[] =
    mode === "SEA"
      ? (["FCL", "LCL"] as const).map((rv) => ({
          rateVariant: rv,
          containerSize: null,
          amount: null,
        }))
      : [];

  return { charges, trucking, seaRates };
}

/** A leg endpoint as far as warehouse seeding cares — the intersection of what BOTH seed sites
 *  carry (server resolveScope's `endpoints`, client `FfPortalLegDto.endpoints`). */
export interface SeedEndpoint {
  pointId: string;
  warehousePosition: WarehousePosition | null;
}

/** Human label for a seeded warehouse row (design D4) — matches the client's historical
 *  `warehouseLabel`, now the single source of truth. */
function warehouseLabel(position: WarehousePosition): string {
  return position === "ORIGIN" ? "Origin warehouse" : "Destination warehouse";
}

/**
 * Seed the shared (non-per-variant, design D4) warehouse rows of a fresh QuoteDraft: when the leg
 * has warehouse handling, one blank (`amount: null`) row per endpoint that classified to a
 * warehouse position (`classifyWarehousePositions`, §6.4). Pure — no I/O. The SAME helper the
 * server's ff-portal.service.ts `seedQuoteDraft` and the client's draftFromDto call, so (like
 * `seedQuoteDraftPricing`) the two seeds can't diverge — the divergence that left the SERVER seed
 * with `warehouse: []`, so a fresh `warehouseIncluded` leg rendered no WarehouseStaging rows and
 * the FF could not price warehousing at all (the finding #1 sibling — same go-live class).
 */
export function seedQuoteDraftWarehouse(
  warehouseIncluded: boolean,
  endpoints: SeedEndpoint[],
): QuoteDraftWarehouse[] {
  if (!warehouseIncluded) return [];
  return endpoints
    .filter((e) => e.warehousePosition != null)
    .map((e) => ({
      warehousePointId: e.pointId,
      position: e.warehousePosition!,
      label: warehouseLabel(e.warehousePosition!),
      amount: null,
      cfsCode: null,
      side: null,
    }));
}
