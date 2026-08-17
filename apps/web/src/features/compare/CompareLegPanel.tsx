import { useState } from "react";
import type { LegComparisonDto, LegStatus } from "@svyft/shared";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LegStatusBadge } from "@/features/rfq-workspace/statusBadges";
import { ComparisonGrid, offerKey } from "./ComparisonGrid";
import { OfferDetail } from "./OfferDetail";
import { MakerPanel } from "./MakerPanel";
import { CheckerPanel } from "./CheckerPanel";
import { DecisionTimeline } from "./DecisionTimeline";
import { useViewMode, type ViewMode } from "./useViewMode";

type BadgeVariant =
  | "default" | "secondary" | "success" | "warning"
  | "accent" | "destructive" | "outline" | "pending";

type AwardDecision = NonNullable<LegComparisonDto["decision"]>;

interface DecisionBadge {
  label: string;
  variant: BadgeVariant;
}

/**
 * The collapsed card's decision chip. `AwardDecisionStatus.REJECTED` exists in the Prisma enum (and
 * so in the DTO union) but is NEVER persisted: `reject()` writes DRAFT + `rejectionReason` in a
 * single update (award.service.ts:319-331, design §9.5 "REJECTED -> back to DRAFT"), keeping the
 * rejection as audit intent on the event log rather than as a decision state. So a rejected leg is
 * a DRAFT that carries a reason — and labelling that "Shortlisted" hid the rework signal entirely
 * (final review I2). The `REJECTED` case is folded in with DRAFT rather than kept as a dead map
 * entry: were the server ever to start persisting it, it would carry the same reason and should
 * read the same way.
 */
function decisionBadge(decision: AwardDecision): DecisionBadge {
  switch (decision.status) {
    case "PENDING_APPROVAL":
      return { label: "Pending approval", variant: "warning" };
    case "APPROVED":
      return { label: "Approved", variant: "success" };
    default:
      return decision.rejectionReason
        ? { label: "Rejected — revise", variant: "destructive" }
        : { label: "Shortlisted", variant: "secondary" };
  }
}

interface CompareLegPanelProps {
  queryId: string;
  leg: LegComparisonDto;
  /** The leg's own workflow status (`QueryLegDto.status`) — not part of `LegComparisonDto`, so the
   *  page cross-references `useQueryDetail`'s legs by id and passes it through when available. */
  legStatus?: LegStatus;
  open: boolean;
  onToggle: () => void;
  /** S5.6 Task 6, ambiguity resolution #2 — `true` once `comparison.awardSnapshot != null` (the
   *  query is QUOTING_CLIENT). `MakerPanel`/`CheckerPanel` are NOT MOUNTED at all while locked
   *  (not merely disabled) — `CompareQuotesPage` computes this ONE boolean and threads it straight
   *  through, so no child re-derives the condition. `OfferDetail`/`DecisionTimeline` stay mounted
   *  and read-only either way. The grid stays too, but not untouched: Task 6 originally judged the
   *  whole read-only half `locked`-agnostic, and the final review overturned that for the
   *  RECOMMENDATION specifically. Once the client quote is generated the winning quote is
   *  `APPROVED`, which `COMPARABLE_STATUSES` excludes from `offers` (comparison.service.ts), so
   *  `buildRecommendation` ranks only the offers that LOST — the column tint/badge would name a
   *  different forwarder than the award panel immediately below them. It is therefore suppressed
   *  while locked, at the model layer (`buildComparisonRowModel`, S5.7 T1) — final review M1. */
  locked: boolean;
}

/**
 * CompareLegPanel — the Compare Quotes leg accordion card (S5.6 §12). Mirrors
 * `rfq-workspace/LegPanel`'s controlled single-open shell (chevron + legCode chip + route + mode
 * badge), plus a decision-status chip derived from `leg.decision?.status` when a shortlist exists.
 * The body renders the read-only `(FF × variant)` comparison — a "N offers received" summary, the
 * `ComparisonGrid` itself (the recommendation now reads by column colour, not a separate banner —
 * S5.7 T1), and — once a column header is clicked — that offer's itemised `OfferDetail` — followed
 * by Task 4's `MakerPanel` (shortlist / send-for-approval / negotiate). Task 5 adds the checker
 * panel alongside this same body.
 *
 * Two pieces of "which offer" state are lifted here, not one, despite both being keyed the same
 * way (`offerKey(quoteId, variant)`) — they answer genuinely different questions with different
 * defaults, and collapsing them into a single variable would make one of the two wrong:
 *   - `selectedOfferKey` — which offer's charge breakdown is expanded below the grid. Defaults to
 *     `undefined` (nothing expanded) and TOGGLES off on a second click of the same header; both
 *     behaviours are pinned by `ComparisonGrid.test.tsx` and must not change.
 *   - `shortlistKey` — the maker's current candidate pick. Defaults (inside `MakerPanel`, via
 *     `defaultShortlistKey`) to the leg's existing shortlist or the recommendation, and a radio
 *     group can never legitimately go back to "nothing picked" the way a toggle can.
 * They're kept from diverging in the one direction that's safe and matches the brief ("wire it so
 * the grid's `onSelectOffer` and this selector stay in sync"): clicking a grid column header both
 * toggles that offer's detail AND moves the maker's candidate pick to it (a natural "inspect this
 * one → it's my pick" gesture). The reverse does NOT happen — picking a maker radio does not
 * force the grid's detail open — so `MakerPanel` never touches `selectedOfferKey`, and the
 * independently-tested expand/collapse toggle above is untouched by this task. `MakerPanel` is a
 * strictly controlled component for `shortlistKey` (it owns no competing local copy of "which
 * offer is picked"), so there is exactly one place this can diverge from — this component — and it
 * doesn't.
 */
export function CompareLegPanel({
  queryId,
  leg,
  legStatus,
  open,
  onToggle,
  locked,
}: CompareLegPanelProps) {
  const route = `${leg.origin} → ${leg.destination}`;
  const offerCount = leg.offers.length;

  // S5.7 T2 — a single global (not per-leg) columns/rows preference; ambiguity resolution #3.
  const [viewMode, setViewMode] = useViewMode();

  const [selectedOfferKey, setSelectedOfferKey] = useState<string | undefined>(undefined);
  const [shortlistKey, setShortlistKey] = useState<string | undefined>(undefined);
  const selectedOffer = leg.offers.find(
    (o) => offerKey(o.quoteId, o.variant) === selectedOfferKey,
  );

  function handleSelectOffer(quoteId: string, variant: string | null) {
    const key = offerKey(quoteId, variant);
    setSelectedOfferKey((cur) => (cur === key ? undefined : key));
    setShortlistKey(key);
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
            <Badge variant={decisionBadge(leg.decision).variant}>
              {decisionBadge(leg.decision).label}
            </Badge>
          )}
          {legStatus && <LegStatusBadge status={legStatus} />}
        </span>
      </button>

      {open && (
        <div data-testid="leg-body" className="space-y-4 border-t border-border p-4">
          {/* Left: offer count. Right: view-mode toggle, in a wrapper that leaves room for Task 5's
              "Negotiate…" button to sit alongside it — a layout only one control could live in
              would have to be reworked when that lands (ambiguity resolution #2). */}
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {offerCount} offer{offerCount === 1 ? "" : "s"} received
            </p>
            <div className="flex items-center gap-2">
              <ViewModeToggle mode={viewMode} onChange={setViewMode} />
            </div>
          </div>
          <ComparisonGrid
            leg={leg}
            selectedOfferKey={selectedOfferKey}
            onSelectOffer={handleSelectOffer}
            locked={locked}
            viewMode={viewMode}
          />
          {selectedOffer && <OfferDetail offer={selectedOffer} />}
          {!locked && (
            <MakerPanel
              queryId={queryId}
              leg={leg}
              shortlistKey={shortlistKey}
              onShortlistKeyChange={setShortlistKey}
            />
          )}
          {!locked && <CheckerPanel queryId={queryId} leg={leg} />}
          <DecisionTimeline timeline={leg.timeline} />
        </div>
      )}
    </Card>
  );
}

/**
 * ViewModeToggle — the two-way Columns/Rows switch on the leg's "N offers received" line (S5.7 T2,
 * ambiguity resolution #2). A plain two-button group rather than a new primitive: the repo has no
 * segmented-control/toggle-group component yet (checked `components/ui/`), and one binary switch
 * doesn't earn adding one.
 */
function ViewModeToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Comparison view"
      data-testid="view-mode-toggle"
      className="inline-flex items-center rounded-md border border-border p-0.5"
    >
      {(["columns", "rows"] as const).map((m) => (
        <Button
          key={m}
          type="button"
          size="sm"
          variant="ghost"
          aria-pressed={mode === m}
          data-testid={`view-mode-${m}`}
          onClick={() => onChange(m)}
          className={cn(
            "h-7 px-2.5 text-xs capitalize",
            mode === m && "bg-secondary text-secondary-foreground hover:bg-secondary/80",
          )}
        >
          {m}
        </Button>
      ))}
    </div>
  );
}
