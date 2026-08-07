import { NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { QuoteStatus, resolveCountryCode, effectiveTags } from "@svyft/shared";
import type { PrismaService } from "../../prisma/prisma.service";

export const LEG_RFQ_INCLUDE = {
  originPoint: { select: { id: true, type: true, country: true, name: true, city: true } },
  destinationPoint: { select: { id: true, type: true, country: true, name: true, city: true } },
  legPackages: { include: { package: { include: { items: true } } } },
  quotes: { select: { id: true, freightForwarderId: true, status: true } },
  chargeSelections: { select: { definition: { select: { key: true } } } },
} satisfies Prisma.LegInclude;

export type LegRfqRow = Prisma.LegGetPayload<{ include: typeof LEG_RFQ_INCLUDE }>;

export interface LegRfqContext {
  leg: LegRfqRow;
  endpointCountries: string[];
  // True only when BOTH the origin and destination endpoints have a resolvable
  // country. When false, RFQ eligibility shows no FFs — the leg's endpoints must
  // be given valid countries before forwarders can be matched.
  endpointCountriesComplete: boolean;
  hasDg: boolean;
  freshQuotes: { id: string; freightForwarderId: string }[];
  // SB6 Task 11 — quotes a change-order invalidated (QUOTED→INVALID, Task 8) on a since-
  // reopened leg. Distinct from `freshQuotes`: these were already sent once, so re-sending
  // them REACTIVATES the same row (INVALID→RFQ_SENT, the Task 5 edge) instead of minting.
  // A subset of `sentQuotes` below (kept there too — additive, not a behavior change for any
  // existing consumer of `sentQuotes`).
  invalidQuotes: { id: string; freightForwarderId: string }[];
  sentQuotes: { id: string; freightForwarderId: string; status: string }[];
}

// Accepts either the root PrismaService or a $transaction client, so the change-order cascade
// (SB6) can reload a leg from the SAME tx AFTER its field edit lands — the re-frozen manifest
// must reflect the just-applied data, not the pre-edit rows.
export async function loadLegForRfq(
  prisma: PrismaService | Prisma.TransactionClient,
  queryId: string,
  legId: string,
): Promise<LegRfqContext> {
  const leg = await prisma.leg.findFirst({
    where: { id: legId, queryId },
    include: LEG_RFQ_INCLUDE,
  });
  if (!leg) throw new NotFoundException("Leg not found");
  // Resolve each endpoint's free-text country (a name OR code, any case) to its ISO
  // code, so it can be compared against FF `availableCountries` (which are ISO codes).
  // A leg is only "complete" for matching when BOTH endpoints resolve; otherwise
  // eligibility shows none (the endpoints need valid countries first).
  const originCountry: string | null = resolveCountryCode(leg.originPoint?.country);
  const destinationCountry: string | null = resolveCountryCode(leg.destinationPoint?.country);
  const endpointCountriesComplete = originCountry !== null && destinationCountry !== null;
  const endpointCountries = [
    ...new Set([originCountry, destinationCountry].filter((c): c is string => !!c)),
  ];
  const hasDg = leg.legPackages.some((lp) =>
    effectiveTags({ tags: lp.package.tags, items: lp.package.items }).includes("DG"),
  );
  const freshQuotes = leg.quotes
    .filter((q) => q.status === QuoteStatus.SELECT)
    .map((q) => ({ id: q.id, freightForwarderId: q.freightForwarderId }));
  const invalidQuotes = leg.quotes
    .filter((q) => q.status === QuoteStatus.INVALID)
    .map((q) => ({ id: q.id, freightForwarderId: q.freightForwarderId }));
  const sentQuotes = leg.quotes
    .filter((q) => q.status !== QuoteStatus.SELECT)
    .map((q) => ({ id: q.id, freightForwarderId: q.freightForwarderId, status: q.status }));
  return {
    leg,
    endpointCountries,
    endpointCountriesComplete,
    hasDg,
    freshQuotes,
    invalidQuotes,
    sentQuotes,
  };
}
