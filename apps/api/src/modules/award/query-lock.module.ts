// apps/api/src/modules/award/query-lock.module.ts
import { Module } from "@nestjs/common";
import { QueryLockService } from "./query-lock.service";

/**
 * S5.9.5 (design D6) — QueryLockService lives in its OWN module rather than being provided and
 * exported by `award.module.ts` as the task brief proposed.
 *
 * Reason, traced: `award.module.ts` imports `RfqModule` (AwardService/NegotiationService need
 * RfqService). D6 gates the four RFQ writes too, so `RfqService` needs `QueryLockService`; if that
 * provider lived in `AwardModule`, `RfqModule` would have to import `AwardModule` and Nest would
 * see a genuine module cycle needing `forwardRef` on both sides. A leaf module with no imports of
 * its own has no such edge from anyone. `PrismaModule` is `@Global()`, so `PrismaService` resolves
 * here without an import.
 */
@Module({ providers: [QueryLockService], exports: [QueryLockService] })
export class QueryLockModule {}
