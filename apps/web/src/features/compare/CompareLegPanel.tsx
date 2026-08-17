import { useState } from "react";
import type { LegComparisonDto, LegStatus } from "@svyft/shared";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LegStatusBadge } from "@/features/rfq-workspace/statusBadges";
import { ComparisonGrid, offerKey } from "./ComparisonGrid";
import { buildComparisonRowModel, type OfferCell } from "./comparisonRowModel";
import { ChargeBreakdownDialog } from "./ChargeBreakdownDialog";
import { ShortlistDialog } from "./ShortlistDialog";
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
   *  through, so no child re-derives the condition. `ChargeBreakdownDialog`/`DecisionTimeline` stay
   *  mounted and read-only either way. The grid stays too, but not untouched: Task 6 originally
   *  judged the whole read-only half `locked`-agnostic, and the final review overturned that for the
   *  RECOMMENDATION specifically. Once the client quote is generated the winning quote is
   *  `APPROVED`, which `COMPARABLE_STATUSES` excludes from `offers` (comparison.service.ts), so
   *  `buildRecommendation` ranks only the offers that LOST — the column tint/badge would name a
   *  different forwarder than the award panel immediately below them. It is therefore suppressed
   *  while locked, at the model layer (`buildComparisonRowModel`, S5.7 T1) — final review M1. */
  locked: boolean;
  /** `ComparisonDto.fxAsOf` (query-level) — threaded down from `CompareQuotesPage` so
   *  `ChargeBreakdownDialog`'s footer can state which FX snapshot an offer's rate came from.
   *  There's no leg- or offer-level equivalent; every offer on the query reads the same rate
   *  table (S5.7 T3, ambiguity resolution #5). */
  fxAsOf: string | null;
}

/**
 * CompareLegPanel — the Compare Quotes leg accordion card (S5.6 §12). Mirrors
 * `rfq-workspace/LegPanel`'s controlled single-open shell (chevron + legCode chip + route + mode
 * badge), plus a decision-status chip derived from `leg.decision?.status` when a shortlist exists.
 * The body renders the read-only `(FF × variant)` comparison — a "N offers received" summary, the
 * `ComparisonGrid` itself (the recommendation now reads by column colour, not a separate banner —
 * S5.7 T1), and — once a column header is clicked — that offer's itemised breakdown in a
 * `ChargeBreakdownDialog` modal (S5.7 T3; used to be an inline detail block). The maker's award
 * actions now split in two: shortlist + send-for-approval happen in `ShortlistDialog`, opened from
 * a per-offer `Select` button in the grid (S5.7 T4), while `MakerPanel` below keeps the leg's
 * status/rejection messaging and the per-forwarder Negotiate buttons. `CheckerPanel` sits alongside
 * in the same body.
 *
 * **The "which offer" state (S5.7 T4).** There used to be two lifted keys here — `selectedOfferKey`
 * (whose breakdown is open) and `shortlistKey` (the maker's candidate pick) — wired so that a grid
 * header click moved BOTH. That coupling was the S5.6 Critical: merely reading a rival offer's
 * charges re-pointed the maker's pick, and `POST /send-for-approval` carries no offer identity, so
 * Send then submitted the previously-SAVED offer under a UI showing a different one. `354236e`
 * patched it with an `unsavedPick` guard on the Send button.
 *
 * T4 removes the second key instead of guarding it. What remains:
 *   - `selectedOfferKey` — which offer's charge breakdown dialog is open. Defaults to `undefined`
 *     (closed) and TOGGLES closed on a second click of the same header, same as closing the dialog
 *     any other way (Escape, overlay click, its own close button); both behaviours are pinned by
 *     `ComparisonGrid.test.tsx` and must not change. It is now PURELY a read affordance — it no
 *     longer moves anything a mutation reads.
 *   - `shortlistCell` — the offer whose `Select` was clicked, i.e. which `ShortlistDialog` is open.
 *     Set only by that button, cleared when the dialog closes; the dialog acts on this exact cell,
 *     so there is no candidate-vs-persisted pair left to diverge.
 */
export function CompareLegPanel({
  queryId,
  leg,
  legStatus,
  open,
  onToggle,
  locked,
  fxAsOf,
}: CompareLegPanelProps) {
  const route = `${leg.origin} → ${leg.destination}`;
  const offerCount = leg.offers.length;

  // S5.7 T2 — a single global (not per-leg) columns/rows preference; ambiguity resolution #3.
  const [viewMode, setViewMode] = useViewMode();

  const [selectedOfferKey, setSelectedOfferKey] = useState<string | undefined>(undefined);
  // The KEY, not the `OfferCell` object: the cell is re-resolved from the current `leg` on every
  // render, so a background refetch (both maker mutations invalidate `["comparison", queryId]`)
  // can't leave the open dialog rendering a frozen snapshot of the offer — everything else in it
  // already reads the fresh read model. An offer that disappears from the read model entirely
  // resolves to `undefined` and closes the dialog rather than acting on a ghost.
  const [shortlistKey, setShortlistKey] = useState<string | undefined>(undefined);
  const shortlistCell: OfferCell | undefined = shortlistKey
    ? buildComparisonRowModel(leg, locked).cells.find((c) => c.key === shortlistKey)
    : undefined;
  const selectedOffer = leg.offers.find(
    (o) => offerKey(o.quoteId, o.variant) === selectedOfferKey,
  );

  // Once the leg's decision has left DRAFT the server 409s a re-shortlist (award.service.ts's
  // `shortlist` guard), so the Select affordance is withheld entirely rather than offered and
  // rejected. `REJECTED` is never persisted — `reject()` writes DRAFT + `rejectionReason` in one
  // update — so a returned leg is an editable DRAFT and keeps its Select buttons (final review I2).
  const decisionStatus = leg.decision?.status;
  const canShortlist =
    !locked && decisionStatus !== "PENDING_APPROVAL" && decisionStatus !== "APPROVED";

  function handleSelectOffer(quoteId: string, variant: string | null) {
    const key = offerKey(quoteId, variant);
    setSelectedOfferKey((cur) => (cur === key ? undefined : key));
  }

  // Radix funnels every close path (Escape, overlay click, the DialogContent corner X) through
  // `onOpenChange` — routing all of them back through the SAME `selectedOfferKey` state that a
  // second header click already toggles keeps "which offer's dialog is open" single-sourced, and
  // the grid header's `aria-expanded` (driven by `selectedOfferKey`) in sync with the dialog.
  function handleBreakdownOpenChange(next: boolean) {
    if (!next) setSelectedOfferKey(undefined);
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
            onShortlistOffer={canShortlist ? (cell) => setShortlistKey(cell.key) : undefined}
          />
          {shortlistCell && (
            <ShortlistDialog
              open
              onOpenChange={(next) => !next && setShortlistKey(undefined)}
              queryId={queryId}
              leg={leg}
              cell={shortlistCell}
            />
          )}
          {selectedOffer && (
            <ChargeBreakdownDialog
              open
              onOpenChange={handleBreakdownOpenChange}
              offer={selectedOffer}
              legLabel={`${leg.legCode} · ${route}`}
              fxAsOf={fxAsOf}
            />
          )}
          {!locked && <MakerPanel queryId={queryId} leg={leg} />}
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
