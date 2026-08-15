import { useState } from "react";
import type { LegComparisonDto, LegStatus } from "@svyft/shared";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LegStatusBadge } from "@/features/rfq-workspace/statusBadges";
import { ComparisonGrid, offerKey } from "./ComparisonGrid";
import { RecommendationBanner } from "./RecommendationBanner";
import { OfferDetail } from "./OfferDetail";

type BadgeVariant =
  | "default" | "secondary" | "success" | "warning"
  | "accent" | "destructive" | "outline" | "pending";

type DecisionStatus = NonNullable<LegComparisonDto["decision"]>["status"];

const DECISION_LABEL: Record<DecisionStatus, string> = {
  DRAFT: "Shortlisted",
  PENDING_APPROVAL: "Pending approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

const DECISION_VARIANT: Record<DecisionStatus, BadgeVariant> = {
  DRAFT: "secondary",
  PENDING_APPROVAL: "warning",
  APPROVED: "success",
  REJECTED: "destructive",
};

interface CompareLegPanelProps {
  leg: LegComparisonDto;
  /** The leg's own workflow status (`QueryLegDto.status`) — not part of `LegComparisonDto`, so the
   *  page cross-references `useQueryDetail`'s legs by id and passes it through when available. */
  legStatus?: LegStatus;
  open: boolean;
  onToggle: () => void;
}

/**
 * CompareLegPanel — the Compare Quotes leg accordion card (S5.6 §12). Mirrors
 * `rfq-workspace/LegPanel`'s controlled single-open shell (chevron + legCode chip + route + mode
 * badge), plus a decision-status chip derived from `leg.decision?.status` when a shortlist exists.
 * The body renders the read-only `(FF × variant)` comparison: a "N offers received" summary, the
 * `RecommendationBanner`, the `ComparisonGrid` itself, and — once a column header is clicked — that
 * offer's itemised `OfferDetail`. `selectedOfferKey` is local state (not lifted): nothing outside
 * this panel needs to know which offer is expanded yet. Tasks 4/5 add the maker/checker panels
 * alongside this same body.
 */
export function CompareLegPanel({ leg, legStatus, open, onToggle }: CompareLegPanelProps) {
  const route = `${leg.origin} → ${leg.destination}`;
  const offerCount = leg.offers.length;

  const [selectedOfferKey, setSelectedOfferKey] = useState<string | undefined>(undefined);
  const selectedOffer = leg.offers.find(
    (o) => offerKey(o.quoteId, o.variant) === selectedOfferKey,
  );

  function handleSelectOffer(quoteId: string, variant: string | null) {
    const key = offerKey(quoteId, variant);
    setSelectedOfferKey((cur) => (cur === key ? undefined : key));
  }

  return (
    <Card id={`legcard-${leg.legId}`} className="scroll-mt-4 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span className="rounded bg-primary/10 px-2 py-0.5 font-mono text-xs font-semibold text-primary">
          {leg.legCode}
        </span>
        <span className="font-medium">{route}</span>
        {leg.mode && <Badge variant="secondary">{leg.mode}</Badge>}
        <span className="ml-auto flex items-center gap-2">
          {leg.decision && (
            <Badge variant={DECISION_VARIANT[leg.decision.status]}>
              {DECISION_LABEL[leg.decision.status]}
            </Badge>
          )}
          {legStatus && <LegStatusBadge status={legStatus} />}
        </span>
      </button>

      {open && (
        <div data-testid="leg-body" className="space-y-4 border-t border-border p-4">
          <p className="text-sm text-muted-foreground">
            {offerCount} offer{offerCount === 1 ? "" : "s"} received
          </p>
          <RecommendationBanner recommendation={leg.recommendation} offers={leg.offers} />
          <ComparisonGrid
            leg={leg}
            selectedOfferKey={selectedOfferKey}
            onSelectOffer={handleSelectOffer}
          />
          {selectedOffer && <OfferDetail offer={selectedOffer} />}
        </div>
      )}
    </Card>
  );
}
