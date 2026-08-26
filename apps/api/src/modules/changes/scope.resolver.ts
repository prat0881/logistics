import { Injectable } from "@nestjs/common";
import { type FindingScope } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { LIVE_QUOTE_WHERE } from "./live-quotes";

// legId is `@db.Uuid`. Postgres parses `legId IN (...)` as ONE typed uuid[] literal, so a
// single non-UUID element (e.g. a synthetic pre-Prisma test id like "leg-a") fails the cast for
// the WHOLE query — not just that element. Pre-filtering to valid UUIDs confines a bad id to
// itself instead of silently dropping live-quote hits on the OTHER, valid legs in the same
// (multi-leg) scope. Version-agnostic on purpose: matches whatever `@default(uuid())` emits.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "Does anything downstream (RFQs/quotes) depend on this scope?" (§7.3). TRUE iff a Quote on a
// scope-leg is "live" — the ONE definition of that now lives in `live-quotes.ts`
// (`LIVE_QUOTE_WHERE`), shared with change-order.strategy.ts's own quote load so the two halves
// of the fork cannot disagree about what a live commitment is. Read that file for which statuses
// count, and for why EXPIRED counts only when it carries a `draftJson` (S5.9.5).
//
// SB6 (Task 3) makes this real; previously (Stage 3, no downstream artifacts yet) this was
// hardcoded false so every change stayed Free-path.
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
      where: { legId: { in: validLegIds }, ...LIVE_QUOTE_WHERE },
    });
    return live > 0;
  }
}
