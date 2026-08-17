import type { LegComparisonDto } from "@svyft/shared";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useGenerateClientQuote } from "./useAwardActions";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export interface GenerateGateProps {
  queryId: string;
  legs: LegComparisonDto[];
}

/**
 * GenerateGate — the query-level "Generate quotation for client" action (S5.6 Task 5, design
 * §16 O4). Query-scoped, not per-leg, so it lives at `CompareQuotesPage` level (ambiguity
 * resolution #2) rather than inside `CompareLegPanel` — mounted only when the viewer is
 * Manager+ (`canCheck`, computed by the page the same way `CheckerPanel` computes it). Enabled
 * only once EVERY leg's `decision.status === "APPROVED"` (and there's at least one leg); when
 * disabled, shows an "N of M approved" progress note so it's clear why. Deliberately has NO
 * four-eyes check — per-leg four-eyes is already enforced at each leg's approve(), and this is
 * just committing what's already been approved, not a fresh decision needing a second approver.
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
    <div
      data-testid="generate-gate"
      className="space-y-2 rounded-lg border border-border bg-card p-4"
    >
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Generate quotation for client
      </h3>

      {!ready && (
        <p className="text-sm text-muted-foreground">
          {total === 0
            ? "No legs to approve yet."
            : `${approvedCount} of ${total} leg${total === 1 ? "" : "s"} approved.`}
        </p>
      )}

      {generate.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(generate.error, "Failed to generate the client quote.")}
        </p>
      )}

      <Button type="button" onClick={onGenerate} disabled={!ready || generate.isPending}>
        {generate.isPending ? "Generating…" : "Generate quotation for client"}
      </Button>
    </div>
  );
}
