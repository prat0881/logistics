import { Injectable } from "@nestjs/common";
import type { FindingScope } from "@svyft/shared";

// "Does anything downstream (RFQs/quotes) depend on this scope?" (§7.3). Stage 3
// has no downstream artifacts, so this is ALWAYS false → every change is Free-path.
// Plan 4+ overrides with "which RFQs/quotes reference these legs".
@Injectable()
export class ScopeResolver {
  async downstreamWork(_scope: FindingScope[]): Promise<boolean> {
    return false;
  }
}
