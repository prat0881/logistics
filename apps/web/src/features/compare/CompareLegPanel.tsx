import { useEffect, useState } from "react";
import type { LegComparisonDto, LegStatus } from "@svyft/shared";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LegStatusBadge } from "@/features/rfq-workspace/statusBadges";
import { ComparisonGrid } from "./ComparisonGrid";
// Both from the leaf module they actually live in (final review MINOR #8): `offerKey` used to be
// imported from `./ComparisonGrid`'s re-export while `buildComparisonRowModel` came from here,
// which made one file read as if the two were unrelated.
import { buildComparisonRowModel, offerKey, type OfferCell } from "./comparisonRowModel";
import { ChargeBreakdownDialog } from "./ChargeBreakdownDialog";
import { ShortlistDialog } from "./ShortlistDialog";
import { NegotiateDialog } from "./NegotiateDialog";
import { MakerPanel } from "./MakerPanel";
import { CheckerPanel } from "./CheckerPanel";
import { DecisionTimeline } from "./DecisionTimeline";
import { type ViewMode } from "./useViewMode";

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
  /** The screen-wide columns/rows orientation and its setter, owned by `CompareQuotesPage`'s single
   *  `useViewMode()` call. REQUIRED (not defaulted) on purpose: the preference is global by design
   *  (§36), and when each panel called the hook itself every leg kept its own copy, so a toggle on
   *  one leg never reached the others (final review IMPORTANT #1). Threading it makes a second,
   *  divergent source of this state impossible to introduce by accident. */
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
}

/**
 * CompareLegPanel — the Compare Quotes leg accordion card (S5.6 §12). Mirrors
 * `rfq-workspace/LegPanel`'s controlled single-open shell (chevron + legCode chip + route + mode
 * badge), plus a decision-status chip derived from `leg.decision?.status` when a shortlist exists.
 * The body renders the read-only `(FF × variant)` comparison — a "N offers received" summary, the
 * `ComparisonGrid` itself (the recommendation now reads by column colour, not a separate banner —
 * S5.7 T1), and — once a column header is clicked — that offer's itemised breakdown in a
 * `ChargeBreakdownDialog` modal (S5.7 T3; used to be an inline detail block). The maker's award
 * actions now split three ways: shortlist + send-for-approval happen in `ShortlistDialog`, opened
 * from a per-offer `Select` button in the grid (S5.7 T4); negotiation is this component's own
 * leg-level "Negotiate…" button (next to the "N offers received" line) opening `NegotiateDialog`,
 * a multi-forwarder rewrite of what used to be per-forwarder buttons inside `MakerPanel` (S5.7 T5);
 * `MakerPanel` below keeps only the leg's status/rejection messaging. `CheckerPanel` sits alongside
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
  viewMode,
  onViewModeChange,
}: CompareLegPanelProps) {
  const route = `${leg.origin} → ${leg.destination}`;
  const offerCount = leg.offers.length;

  // S5.7 T5 — the leg-level "Negotiate…" trigger. Just an open/close flag: `NegotiateDialog`
  // re-derives its own eligibility list off `leg` on every render (see its own doc comment), so
  // there is no second piece of "which forwarders" state to keep in sync here.
  const [negotiateOpen, setNegotiateOpen] = useState(false);

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

  // `canShortlist` gates the OPEN DIALOG too, not just the Select button that opens it (final
  // review IMPORTANT #2). `shortlistCell` is resolved from `buildComparisonRowModel`, which knows
  // nothing about `locked` or the decision status, so without this the grid could drop the Select
  // affordance under the maker — another user generating the client quote, or a second maker
  // sending this leg for approval, both land via a background refetch — while an already-open
  // dialog stayed live and submittable. The server 409s that submit (award.service.ts's shortlist
  // guard), so it was a dead end rather than a bad award, but this component's own contract (see
  // the comment above) is that the affordance is WITHHELD, never offered-and-rejected.
  //
  // Clearing the key as well as hiding the dialog is the other half (it subsumes deferred minor
  // T4 F3): leaving `shortlistKey` set meant a later refetch that restored the offer — or
  // re-enabled shortlisting — silently re-opened a dialog the maker never re-requested.
  //
  // The two are deliberately BOTH here even though this effect alone would also unmount the dialog
  // (clearing the key empties `shortlistCell`). Passive effects run after paint, so without the
  // `canShortlist &&` guard on the JSX the dialog would render once more on the tick the window
  // closes — a visible flash of a control that is no longer valid. That one-frame difference is not
  // observable through RTL (every `render`/`rerender` flushes effects before returning), so the
  // mutation proof for the guard is green on its own and only this effect's removal reddens a test:
  // recorded in the final-review fix report rather than papered over with a test that can't fail.
  //
  // This deliberately does NOT fire inside `ShortlistDialog`'s own save→send sequence: `shortlist`
  // upserts the decision with `status: DRAFT` on both the create and update paths
  // (award.service.ts), so the refetch triggered between the PUT and the POST returns a DRAFT
  // decision and `canShortlist` stays true throughout. It flips only once the SEND has succeeded
  // (→ PENDING_APPROVAL), by which point the dialog has already closed itself.
  useEffect(() => {
    if (!canShortlist) setShortlistKey(undefined);
  }, [canShortlist]);

  // S5.7 T5 — this is a UI-only restriction (design consequence C1): the server still accepts a
  // re-quote on a PENDING_APPROVAL leg and resets its decision to DRAFT, it just isn't the flow the
  // maker should be steered through while a checker is already reviewing the current shortlist.
  const negotiateDisabledReason =
    decisionStatus === "PENDING_APPROVAL"
      ? "A checker must reject this leg before it can be re-negotiated."
      : null;

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
          {/* Left: offer count. Right: (S5.7 T5) the leg-level Negotiate button + its disabled
              reason, then the view-mode toggle — the wrapper Task 2 left room for. */}
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {offerCount} offer{offerCount === 1 ? "" : "s"} received
            </p>
            <div className="flex items-center gap-2">
              {/* A maker action, same as MakerPanel/CheckerPanel below — withheld entirely (not
                  merely disabled) once locked, per this component's own `locked` contract. */}
              {!locked && (
                <>
                  {negotiateDisabledReason && (
                    <span className="text-xs text-muted-foreground">{negotiateDisabledReason}</span>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="ml-auto"
                    disabled={negotiateDisabledReason != null}
                    onClick={() => setNegotiateOpen(true)}
                  >
                    Negotiate…
                  </Button>
                </>
              )}
              <ViewModeToggle mode={viewMode} onChange={onViewModeChange} />
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
          {canShortlist && shortlistCell && (
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
          {!locked && (
            <NegotiateDialog
              open={negotiateOpen}
              onOpenChange={setNegotiateOpen}
              queryId={queryId}
              legId={leg.legId}
              leg={leg}
            />
          )}
          {!locked && <MakerPanel leg={leg} />}
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
