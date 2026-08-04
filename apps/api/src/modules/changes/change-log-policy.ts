import { Injectable } from "@nestjs/common";
import type { ImpactPath } from "@svyft/shared";

// Which paths get a durable ChangeLog row (§10). Change-order only for now — the free path is
// intentionally silent (see FreePathStrategy's guard); expandable later without touching callers.
@Injectable()
export class ChangeLogPolicy {
  shouldRecord(path: ImpactPath): boolean {
    return path === "change-order";
  }
}
