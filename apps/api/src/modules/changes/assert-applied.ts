import { ConflictException } from "@nestjs/common";
import type { ChangeResult } from "./free-path.strategy";

/**
 * The single "mediated write did not free-path" guard. Every mediated create/update/delete/copy
 * (cargo, package, item, leg, query) runs the same check after `ChangeMediator.apply`: if the
 * change needs change-order confirmation, surface it as a 409 carrying the preview so the client
 * can prompt for a reason and re-submit with one. Collapses the identical block that was
 * duplicated across the mediated workflow-write services.
 */
export function assertApplied(result: Pick<ChangeResult, "needsConfirmation" | "preview">): void {
  if (result.needsConfirmation) {
    throw new ConflictException({
      message: "Change requires confirmation",
      needsChangeOrder: true,
      preview: result.preview,
    });
  }
}
