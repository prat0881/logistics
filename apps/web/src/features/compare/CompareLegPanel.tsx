import { useEffect, useState } from "react";
import type { LegComparisonDto, LegStatus } from "@svyft/shared";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LegStatusBadge } from "@/features/rfq-workspace/statusBadges";
import { ComparisonGrid } from "./ComparisonGrid";
// From the leaf module it actually lives in (final review MINOR #8), not `./ComparisonGrid`'s
// re-export.
import { offerKey } from "./comparisonRowModel";
import { ChargeBreakdownDialog } from "./ChargeBreakdownDialog";
import { SendForApprovalDialog } from "./SendForApprovalDialog";
import { NegotiateDialog } from "./NegotiateDialog";
import { MakerPanel } from "./MakerPanel";
import { CheckerPanel } from "./CheckerPanel";
import { DecisionTimeline } from "./DecisionTimeline";
import { type ViewMode } from "./useViewMode";

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
 * `rfq-workspace/LegPanel`'s controlled single-open shell exactly (chevron + legCode chip + route +
 * mode badge in one toggle `<button>`, `LegStatusBadge` pushed to the far end with `ml-auto`) — one
 * header, one status. S5.9 T10 used to split this into a toggle `<button>` plus a trailing,
 * non-toggling `DecisionChip` sibling, because that chip needed independent focus for its own
 * hover/focus tooltip; S5.9.1 (product item 4) removed the chip entirely — leg status now carries
 * the approval-flow states itself (`PENDING_APPROVAL`/`APPROVED`/…, see `@svyft/shared`'s
 * `LegStatus`), so showing both was two statuses for one leg ("Pending approval" beside "Pending
 * Approval"). With nothing left in the trailing area that needs its own focus stop, the split no
 * longer earns its keep — `LegStatusBadge` renders a plain, non-focusable `<div>` (`Badge`), so it
 * moved back inside the button with nothing "interactive inside interactive" to worry about.
 * The body renders the read-only `(FF × variant)` comparison — a "N offers received" summary, the
 * `ComparisonGrid` itself (the recommendation now reads by column colour, not a separate banner —
 * S5.7 T1), and — once a column header is clicked — that offer's itemised breakdown in a
 * `ChargeBreakdownDialog` modal (S5.7 T3; used to be an inline detail block). Below the grid sits
 * one action bar (S5.9 T9): "Negotiate…" opens `NegotiateDialog`, a multi-forwarder rewrite of
 * what used to be per-forwarder buttons inside `MakerPanel` (S5.7 T5); "Send for approval…" opens
 * `SendForApprovalDialog`, which lists every priced offer itself and picks + sends in one call —
 * there is no more per-offer `Select` button inside the grid (S5.7 T4's affordance, retired this
 * task). `MakerPanel` below keeps only the rejection alert (or renders nothing) — the two
 * locked-state explanations `DecisionChip` used to carry as tooltip copy are simply gone with it
 * (S5.9.1); `CheckerPanel` sits alongside in the same body.
 *
 * **The "which offer" state.** `selectedOfferKey` — which offer's charge breakdown dialog is open —
 * is the ONLY such state left here. Defaults to `undefined` (closed) and TOGGLES closed on a second
 * click of the same header, same as closing the dialog any other way (Escape, overlay click, its
 * own close button); both behaviours are pinned by `ComparisonGrid.test.tsx` and must not change.
 * It is now, and always was meant to be, PURELY a read affordance.
 *
 * S5.7 T4 used to lift a SECOND key here, `shortlistKey` (the maker's candidate pick), wired so
 * that a grid header click moved BOTH keys. That coupling was the S5.6 Critical: merely reading a
 * rival offer's charges re-pointed the maker's pick, and `POST /send-for-approval` carried no
 * offer identity, so Send then submitted the previously-SAVED offer under a UI showing a different
 * one (patched in `354236e` by an `unsavedPick` guard, later removed when T4 gave the dialog its
 * own single acted-on cell instead of guarding the drift). S5.9 T9 removes `shortlistKey` itself:
 * `SendForApprovalDialog` owns its own selection entirely — it is opened by a plain button below
 * the grid, not by a per-offer click, so there is no grid gesture left that could move it. `sendOpen`
 * below is nothing more than "is this dialog open", the same shape as `negotiateOpen`.
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
  // S5.9 T9 — same shape, for `SendForApprovalDialog`. It builds its own offer list (and owns its
  // own selection) off `leg` on every render, so there is likewise no "which offer" state to lift
  // here any more — see this component's doc comment for what used to live here instead.
  const [sendOpen, setSendOpen] = useState(false);

  const [selectedOfferKey, setSelectedOfferKey] = useState<string | undefined>(undefined);
  const selectedOffer = leg.offers.find(
    (o) => offerKey(o.quoteId, o.variant) === selectedOfferKey,
  );

  // Once the leg's decision has left DRAFT the server 409s a re-send (award.service.ts's B2 guard),
  // so the Send affordance is withheld entirely rather than offered and rejected. `REJECTED` is
  // never persisted — `reject()` writes DRAFT + `rejectionReason` in one update — so a returned leg
  // is an editable DRAFT and keeps Send available (final review I2).
  const decisionStatus = leg.decision?.status;
  const canSend = !locked && decisionStatus !== "PENDING_APPROVAL" && decisionStatus !== "APPROVED";

  // Review round IMPORTANT 3 — `{canSend && (<SendForApprovalDialog open={sendOpen} …>)}` below
  // unmounts the dialog the instant `canSend` goes false, but does NOT clear `sendOpen` itself:
  // that boolean lives here, not inside the dialog, so a later refetch that makes the leg sendable
  // AGAIN (e.g. a checker's Reject, which returns the decision to DRAFT) remounts a FRESH
  // `SendForApprovalDialog` instance whose `open` prop is still the stale `true` from before —
  // a silent reopen the maker never asked for. Reproduced: DRAFT (open the dialog) → PENDING_APPROVAL
  // (unmounts) → DRAFT + a rejection reason (remounts, open again).
  //
  // This is deliberately NOT the deleted `shortlistKey`-clearing effect restored verbatim — that
  // one resolved an `OfferCell` through `buildComparisonRowModel` on every `leg` change because the
  // in-grid `Select` button fed it a piece of drift-prone identity state. `sendOpen` is a plain
  // boolean with no identity to resolve; the dialog itself now owns `selectedKey` internally and
  // rebuilds it from scratch on every mount, so a stray remount can at worst reopen with nothing
  // selected (Send stays disabled — no wrong offer is reachable), never resubmit a stale pick. The
  // fix is still a one-line effect, just on different state for a different reason than the one the
  // brief told this task to delete.
  useEffect(() => {
    if (!canSend) setSendOpen(false);
  }, [canSend]);

  // CORRECTED (S5.9 final whole-branch review) — this used to say the restriction was "UI-only"
  // and that "the server still accepts a re-quote on a PENDING_APPROVAL leg and resets its
  // decision to DRAFT" (design consequence C1, true when S5.7 T5 wrote it). D5 removed exactly
  // that: `negotiation.service.ts` now refuses a re-quote on any leg whose decision is
  // PENDING_APPROVAL, with a 409 and this same "reject it first" reasoning — checked at the LEG
  // level, so a still-QUOTED sibling quote cannot slip past it either. This copy therefore states
  // the server's actual rule rather than softening a rule the server does not have.
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
      {/* One toggle `<button>` (S5.9.1 — back to `rfq-workspace/LegPanel`'s single-header shape).
          T10's split into a toggle button plus a trailing, non-toggling badge sibling existed only
          because the now-deleted `DecisionChip` needed independent focus for its own tooltip; a
          focusable non-button element couldn't nest inside this button without the same
          "interactive inside interactive" problem `asChild` avoided elsewhere. `LegStatusBadge`
          carries no tooltip and renders a plain, non-focusable `<div>` (`Badge`'s own `forwardRef`
          exists for a `Slot`/`asChild` consumer, not for this), so nothing in the trailing area
          needs to sit outside the button any more — confirmed before moving it back in, not
          assumed. Whole-row click/hover is restored as a side effect. */}
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
        {legStatus && (
          <span className="ml-auto">
            <LegStatusBadge status={legStatus} />
          </span>
        )}
      </button>

      {open && (
        <div data-testid="leg-body" className="space-y-4 border-t border-border p-4">
          {/* Left: offer count. Right: the view-mode toggle — the wrapper Task 2 left room for.
              The maker action bar (S5.9 T9) moved below the grid; this line is purely informational
              now. */}
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {offerCount} offer{offerCount === 1 ? "" : "s"} received
            </p>
            <ViewModeToggle mode={viewMode} onChange={onViewModeChange} />
          </div>
          <ComparisonGrid
            leg={leg}
            selectedOfferKey={selectedOfferKey}
            onSelectOffer={handleSelectOffer}
            locked={locked}
            viewMode={viewMode}
          />
          {/* The maker's action bar (S5.9 T9) — Negotiate + Send for approval, both withheld
              entirely (not merely disabled) once locked, per this component's own `locked`
              contract; Send is further gated on `canSend` alone, same as the dialog it opens. */}
          {!locked && (
            <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
              {negotiateDisabledReason && (
                <span className="text-xs text-muted-foreground">{negotiateDisabledReason}</span>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={negotiateDisabledReason != null}
                onClick={() => setNegotiateOpen(true)}
              >
                Negotiate…
              </Button>
              {canSend && (
                <Button type="button" size="sm" onClick={() => setSendOpen(true)}>
                  Send for approval…
                </Button>
              )}
            </div>
          )}
          {canSend && (
            <SendForApprovalDialog
              open={sendOpen}
              onOpenChange={setSendOpen}
              queryId={queryId}
              leg={leg}
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
