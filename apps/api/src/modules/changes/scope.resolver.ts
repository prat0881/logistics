import { Injectable } from "@nestjs/common";
import { QuoteStatus, type FindingScope } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

// legId is `@db.Uuid`. Postgres parses `legId IN (...)` as ONE typed uuid[] literal, so a
// single non-UUID element (e.g. a synthetic pre-Prisma test id like "leg-a") fails the cast for
// the WHOLE query — not just that element. Pre-filtering to valid UUIDs confines a bad id to
// itself instead of silently dropping live-quote hits on the OTHER, valid legs in the same
// (multi-leg) scope. Version-agnostic on purpose: matches whatever `@default(uuid())` emits.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "Does anything downstream (RFQs/quotes) depend on this scope?" (§7.3). TRUE iff a Quote on
// a scope-leg is "live" (distributed: RFQ_SENT, QUOTED, PENDING_APPROVAL, or — Stage 5 S5.5
// Task 3, §10.2 prereq — APPROVED, i.e. already awarded) — SELECT (pre-RFQ) and EXPIRED/INVALID
// (gone stale) don't count. SB6 (Task 3) makes this real; previously (Stage 3, no downstream
// artifacts yet) this was hardcoded false so every change stayed Free-path. APPROVED postdates
// SB6 (added in S5.3) — without it here, a field edit on an already-awarded leg silently took
// the Free path (no invalidation, no reopen), so the §10.2 award-reversal listener would never
// fire. PENDING_APPROVAL (S5.9 §4.4) is the same live commitment mid-review — without it here, a
// field edit on a leg under review would also silently free-path instead of raising a change
// order (see change-order.strategy.ts's mirrored "invalidating" group for the other half).
@Injectable()
export class ScopeResolver {
  constructor(private readonly prisma: PrismaService) {}

  async downstreamWork(scope: FindingScope[]): Promise<boolean> {
    // Narrow id along with type: FindingScope.id is optional on the shared type, but a
    // "leg" scope entry with no id is meaningless, so it's excluded the same as a non-leg one.
    const legIds = scope
      .filter((s): s is FindingScope & { id: string } => s.type === "leg" && s.id !== undefined)
      .map((s) => s.id);
    const validLegIds = legIds.filter((id) => UUID_RE.test(id));
    if (validLegIds.length === 0) return false;
    const live = await this.prisma.quote.count({
      where: {
        legId: { in: validLegIds },
        status: {
          in: [
            QuoteStatus.RFQ_SENT,
            QuoteStatus.QUOTED,
            QuoteStatus.PENDING_APPROVAL,
            QuoteStatus.APPROVED,
          ],
        },
      },
    });
    return live > 0;
  }
}
