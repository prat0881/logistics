import { useEffect, useState } from "react";
import type { LegComparisonDto, LegStatus } from "@svyft/shared";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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

type BadgeVariant =
  | "default" | "secondary" | "success" | "warning"
  | "accent" | "destructive" | "outline" | "pending";

type AwardDecision = NonNullable<LegComparisonDto["decision"]>;

interface DecisionBadge {
  label: string;
  variant: BadgeVariant;
  /** S5.9 T10 (product item 7) — the two locked-state explanations that used to render as
   *  standing paragraphs in `MakerPanel` moved here, onto the chip itself, as hover-only copy. Only
   *  the two locked statuses carry one; `DecisionChip` below renders a bare, tooltip-free badge for
   *  everything else. Copy is unchanged from what `MakerPanel` used to render — this is a location
   *  change, not a rewrite. */
  hint?: string;
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
    // Two genuinely different dead-ends, so two hints (final review I1, carried from MakerPanel).
    // PENDING_APPROVAL is recoverable: a checker's Reject writes the decision back to DRAFT and
    // clears `sentByUserId`, restoring the grid's Send affordance. APPROVED is NOT — `reject`
    // 409s on anything that isn't PENDING_APPROVAL (`requireDecidable`) and Reopen only clears the
    // query's award snapshot, deliberately leaving every leg APPROVED (`reopenComparison`).
    case "PENDING_APPROVAL":
      return {
        label: "Pending approval",
        variant: "warning",
        hint: "Locked while this leg is pending approval — a checker has to reject it (which returns it to draft) before the shortlist can change.",
      };
    case "APPROVED":
      return {
        label: "Approved",
        variant: "success",
        hint: "This leg is approved — its shortlist is final here. Revising the award needs a change request or a fresh negotiation with the forwarder.",
      };
    default:
      return decision.rejectionReason
        ? { label: "Rejected — revise", variant: "destructive" }
        : { label: "Shortlisted", variant: "secondary" };
  }
}

/**
 * DecisionChip — the badge itself, wrapped in a hover-**and-focus** tooltip when `decisionBadge`
 * gives it a `hint` (S5.9 T10; keyboard/AT reachability fixed in T10's review round).
 *
 * Two accessibility constraints, both load-bearing:
 *   1. `TooltipTrigger` uses `asChild` on the `Badge` rather than rendering its own (default)
 *      `<button>` — `Badge` is a plain `<div>` (`forwardRef` specifically so Radix's `Slot` can
 *      attach the ref it needs to anchor the popper), so `asChild` merges the trigger's
 *      pointer/focus handlers onto it instead of introducing a second element.
 *   2. The hint-bearing chip carries `tabIndex={0}` so it's reachable by `Tab`, not just a mouse —
 *      Radix's `TooltipTrigger` opens on `focus` (immediately, no hover delay) and closes on
 *      `blur`, so a focusable trigger gets full keyboard support for free. This is why the chip
 *      MUST render as a sibling of the leg header's own `onToggle` `<button>`, not a child of it
 *      (see `CompareLegPanel`'s header JSX below): a focusable, non-button element nested inside a
 *      `<button>` is exactly the same "interactive-inside-interactive" problem asChild was already
 *      avoiding, just via `tabIndex` instead of a second `<button>` tag. A leg with no hint (plain
 *      `DRAFT`) renders a bare, non-focusable badge — there's nothing to reveal, so it isn't given
 *      a tab stop.
 */
function DecisionChip({ decision }: { decision: AwardDecision }) {
  const { label, variant, hint } = decisionBadge(decision);

  if (!hint) {
    return (
      <Badge variant={variant} data-testid="decision-chip">
        {label}
      </Badge>
    );
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant={variant} data-testid="decision-chip" tabIndex={0}>
            {label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
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
 * `ChargeBreakdownDialog` modal (S5.7 T3; used to be an inline detail block). Below the grid sits
 * one action bar (S5.9 T9): "Negotiate…" opens `NegotiateDialog`, a multi-forwarder rewrite of
 * what used to be per-forwarder buttons inside `MakerPanel` (S5.7 T5); "Send for approval…" opens
 * `SendForApprovalDialog`, which lists every priced offer itself and picks + sends in one call —
 * there is no more per-offer `Select` button inside the grid (S5.7 T4's affordance, retired this
 * task). `MakerPanel` below keeps only the rejection alert (or renders nothing) — its two former
 * locked-state paragraphs now live on the decision chip itself, as a hover tooltip (`DecisionChip`,
 * S5.9 T10, product item 7); `CheckerPanel` sits alongside in the same body.
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
      {/* Split into a toggle `<button>` (chevron/code/route/mode) plus a trailing, non-toggling
          badge area (T10 review round) — the decision chip needs to be independently focusable
          for its tooltip (see `DecisionChip`'s doc comment), and a focusable non-button element
          can't nest inside this button without repeating the exact "interactive inside
          interactive" problem `asChild` exists to avoid. Trade-off: clicking directly on the
          decision/status badges no longer toggles the accordion — only the left/main portion of
          the row does now. The row's hover affordance moves with it, onto just the button. */}
      <div className="flex w-full items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex flex-1 items-center gap-3 rounded text-left hover:bg-muted/50"
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <span className="rounded bg-primary/10 px-2 py-0.5 font-mono text-xs font-semibold text-primary">
            {leg.legCode}
          </span>
          <span className="font-medium">{route}</span>
          {leg.mode && <Badge variant="secondary">{leg.mode}</Badge>}
        </button>
        <span className="flex items-center gap-2">
          {leg.decision && <DecisionChip decision={leg.decision} />}
          {legStatus && <LegStatusBadge status={legStatus} />}
        </span>
      </div>

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
