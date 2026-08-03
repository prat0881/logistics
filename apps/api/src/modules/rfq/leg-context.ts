import { NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { QuoteStatus } from "@svyft/shared";
import type { PrismaService } from "../../prisma/prisma.service";

export const LEG_RFQ_INCLUDE = {
  originPoint: { select: { country: true, name: true, city: true } },
  destinationPoint: { select: { country: true, name: true, city: true } },
  legCargo: { include: { cargoItem: true } },
  quotes: { select: { id: true, freightForwarderId: true, status: true } },
} satisfies Prisma.LegInclude;

export type LegRfqRow = Prisma.LegGetPayload<{ include: typeof LEG_RFQ_INCLUDE }>;

export interface LegRfqContext {
  leg: LegRfqRow;
  endpointCountries: string[];
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
  const leg = await prisma.leg.findFirst({ where: { id: legId, queryId }, include: LEG_RFQ_INCLUDE });
  if (!leg) throw new NotFoundException("Leg not found");
  const countries = [leg.originPoint?.country, leg.destinationPoint?.country].filter(
    (c): c is string => !!c,
  );
  const endpointCountries = [...new Set(countries)];
  const hasDg = leg.legCargo.some((lc) => lc.cargoItem.isDangerous);
  const freshQuotes = leg.quotes
    .filter((q) => q.status === QuoteStatus.SELECT)
    .map((q) => ({ id: q.id, freightForwarderId: q.freightForwarderId }));
  const invalidQuotes = leg.quotes
    .filter((q) => q.status === QuoteStatus.INVALID)
    .map((q) => ({ id: q.id, freightForwarderId: q.freightForwarderId }));
  const sentQuotes = leg.quotes
    .filter((q) => q.status !== QuoteStatus.SELECT)
    .map((q) => ({ id: q.id, freightForwarderId: q.freightForwarderId, status: q.status }));
  return { leg, endpointCountries, hasDg, freshQuotes, invalidQuotes, sentQuotes };
}
