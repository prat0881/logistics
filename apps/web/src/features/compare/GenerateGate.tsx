import type { LegComparisonDto } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { useGenerateClientQuote } from "./useAwardActions";
import { errorMessage } from "./errorMessage";

export interface GenerateGateProps {
  queryId: string;
  legs: LegComparisonDto[];
}

const READINESS_ID = "generate-gate-readiness";

/**
 * GenerateGate — the query-level "Generate quotation for client" action (S5.6 Task 5, design
 * §16 O4). Query-scoped, not per-leg, so it lives at `CompareQuotesPage` level (ambiguity
 * resolution #2) rather than inside `CompareLegPanel` — mounted only when the viewer is
 * Manager+ (`canCheck`, computed by the page the same way `CompareLegPanel`'s action bar computes
 * its own `isChecker`). Enabled
 * only once EVERY leg's `decision.status === "APPROVED"` (and there's at least one leg); when
 * disabled, the "N of M approved" progress note that used to sit inside a bordered card now sits
 * as plain muted text next to the button AND is wired to it via `aria-describedby` (S5.9.2 T4,
 * PO ruling #5 — "remove the box … just keep the button after all legs on the right hand side").
 * A bare disabled button with no visible reason would leave an exec guessing what's missing, so
 * the readiness note is dropped only once `ready` (the button's own label is enough then), never
 * hidden while still the reason for the disable. Deliberately has NO four-eyes check — per-leg
 * four-eyes is already enforced at each leg's approve(), and this is just committing what's
 * already been approved, not a fresh decision needing a second approver.
 */
export function GenerateGate({ queryId, legs }: GenerateGateProps) {
  const generate = useGenerateClientQuote(queryId);
  const total = legs.length;
  const approvedCount = legs.filter((l) => l.decision?.status === "APPROVED").length;
  const ready = total > 0 && approvedCount === total;

  // Same belt-and-suspenders guard as the maker/checker handlers above — closes the double-fire
  // window at the handler level, not just via the button's own `disabled`.
  function onGenerate() {
    if (generate.isPending || !ready) return;
    generate.mutate();
  }

  return (
    <div data-testid="generate-gate" className="flex flex-col items-end gap-2">
      {generate.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(generate.error, "Failed to generate the client quote.")}
        </p>
      )}

      <div className="flex items-center gap-3">
        {!ready && (
          <p id={READINESS_ID} className="text-sm text-muted-foreground">
            {total === 0
              ? "No legs to approve yet."
              : `${approvedCount} of ${total} leg${total === 1 ? "" : "s"} approved.`}
          </p>
        )}

        <Button
          type="button"
          onClick={onGenerate}
          disabled={!ready || generate.isPending}
          aria-describedby={!ready ? READINESS_ID : undefined}
        >
          {generate.isPending ? "Generating…" : "Generate quotation for client"}
        </Button>
      </div>
    </div>
  );
}
