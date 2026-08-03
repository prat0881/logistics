import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationDispatcher } from "../comms/notification-dispatcher.service";

type PointLabel = { name: string | null; city: string | null; country: string | null } | null;

// Prefer the point's own name (e.g. "Jebel Ali Port"); fall back to "city, country" when
// unnamed; "" when neither is set (renderTemplate blanks the token rather than printing
// "undefined" — see packages/shared/src/comms.ts).
function pointLabel(p: PointLabel): string {
  if (!p) return "";
  return p.name || [p.city, p.country].filter(Boolean).join(", ");
}

// One FF's slice of a reopen cascade: the legs THEY were invalidated on (a query-wide edit
// can reopen several legs, but not every invalidated FF necessarily touched all of them).
export type LegReopenedFfGroup = { freightForwarderId: string; legIds: string[] };

// Sub-build 6 (change-order cascade): a thin wrapper over the SB5 NotificationDispatcher for
// the one event the cascade fires — "a distributed leg was reopened, your quote was
// invalidated" (design §15). SB6 fires; SB5 composes/logs/sends. Consumed by
// ChangeOrderStrategy.apply (Task 8) right after it fires the quote INVALIDATE + leg REOPEN
// status transitions.
//
// dispatch() renders subject/body ONCE per call and sends that identical rendered content to
// every EMAIL recipient in that call (notification-dispatcher.service.ts) — it does not
// re-render per address. Rfq is @@unique([queryId, freightForwarderId]), so two invalidated
// FFs on the same query genuinely have two different rfqNumbers (and can have been
// invalidated on different legs). Sending one batched dispatch() across multiple FFs would
// leak FF-A's rfqNumber/legs into FF-B's email. So this loops dispatch() ONCE PER FF group —
// same shape as the existing precedent in rfq.service.ts's performDistribution, which loops
// dispatch() per FF for exactly this reason.
@Injectable()
export class RfqNotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  async legReopened(queryId: string, reason: string, perFf: LegReopenedFfGroup[]): Promise<void> {
    if (perFf.length === 0) return;

    const query = await this.prisma.query.findUnique({
      where: { id: queryId },
      select: { tenantId: true, assignedUserId: true },
    });
    if (!query) return; // nothing to notify against — defensive, not expected in practice

    const allLegIds = [...new Set(perFf.flatMap((p) => p.legIds))];
    const ffIds = [...new Set(perFf.map((p) => p.freightForwarderId))];

    const [legs, ffs, rfqs] = await Promise.all([
      this.prisma.leg.findMany({
        where: { id: { in: allLegIds } },
        select: {
          id: true,
          legCode: true,
          originPoint: { select: { name: true, city: true, country: true } },
          destinationPoint: { select: { name: true, city: true, country: true } },
        },
      }),
      this.prisma.freightForwarder.findMany({
        where: { id: { in: ffIds } },
        select: { id: true, email: true },
      }),
      // "the Rfq for this query+FF" — one row per FF (@@unique([queryId, freightForwarderId])).
      this.prisma.rfq.findMany({
        where: { queryId, freightForwarderId: { in: ffIds } },
        select: { freightForwarderId: true, rfqNumber: true },
      }),
    ]);

    const legById = new Map(legs.map((l) => [l.id, l]));
    const emailByFfId = new Map(ffs.map((f) => [f.id, f.email]));
    const rfqNumberByFfId = new Map(rfqs.map((r) => [r.freightForwarderId, r.rfqNumber]));
    const inApp = query.assignedUserId ? [query.assignedUserId] : [];

    for (const group of perFf) {
      const theseLegs = group.legIds
        .map((id) => legById.get(id))
        .filter((l): l is NonNullable<typeof l> => !!l)
        .sort((a, b) => a.legCode.localeCompare(b.legCode));

      const tokens = {
        rfqNumber: rfqNumberByFfId.get(group.freightForwarderId) ?? "",
        legCode: theseLegs.map((l) => l.legCode).join(", "),
        origin: theseLegs.map((l) => pointLabel(l.originPoint)).join(", "),
        destination: theseLegs.map((l) => pointLabel(l.destinationPoint)).join(", "),
        reason,
      };

      const email = emailByFfId.get(group.freightForwarderId);

      // One dispatch() per FF — its own EMAIL address + its own tokens (see class comment).
      // The Executive gets an IN_APP notification on every iteration (one per affected FF).
      await this.dispatcher.dispatch("rfq.leg.reopened", {
        scope: { entityType: "QUERY", entityId: queryId },
        tokens,
        recipients: {
          EMAIL: email ? [email] : [],
          IN_APP: inApp,
        },
        tenantId: query.tenantId,
      });
    }
  }
}
