import { useEffect, useState } from "react";
import type { LegComparisonDto, LegStatus } from "@svyft/shared";
import { Role } from "@svyft/shared";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "@/features/auth/AuthProvider";
import { LegStatusBadge } from "@/features/rfq-workspace/statusBadges";
import { ComparisonGrid } from "./ComparisonGrid";
// From the leaf module it actually lives in (final review MINOR #8), not `./ComparisonGrid`'s
// re-export.
import { offerKey } from "./comparisonRowModel";
import { ChargeBreakdownDialog } from "./ChargeBreakdownDialog";
import { SendForApprovalDialog } from "./SendForApprovalDialog";
import { NegotiateDialog } from "./NegotiateDialog";
import { ApproveDialog } from "./ApproveDialog";
import { RejectDialog } from "./RejectDialog";
import { MakerPanel } from "./MakerPanel";
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
   *  query is QUOTING_CLIENT). `MakerPanel`, the whole checker action bar (Approve/Reject) AND the
   *  dialogs those buttons open are NOT MOUNTED at all while locked (not merely disabled) — the
   *  final whole-branch review found this sentence true of the BAR but not of `ApproveDialog`/
   *  `RejectDialog`, which were gated on `canCheck` alone while their maker counterparts also
   *  carried `!locked`; `canCheck` now carries the `!locked` term itself (see its definition
   *  below), so the claim holds for every checker surface rather than describing a guard the code
   *  lacked. `CompareQuotesPage` computes this ONE
   *  boolean and threads it straight
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
 * ONE action bar (`data-testid="leg-action-bar"`) shared by maker and checker roles, composed by
 * role rather than swapped wholesale (S5.9.1 Task 2, product decision): "Negotiate…" opens
 * `NegotiateDialog` (S5.7 T5) for an EXECUTIVE viewer only — Manager/Admin never see it, because
 * their path to a revised price is Reject with a reason (product item 1), not a per-condition
 * disable the way `negotiateDisabledReason` handles PENDING_APPROVAL for an Executive. "Send for
 * approval…" opens `SendForApprovalDialog` (S5.9 T9) and stays available to EVERY role the
 * `canSend` gate allows, Manager/Admin included — deliberately: the four-eyes rule needs a Manager
 * able to send a leg for a *different* Manager to check, so Send is not checker-exclusive the way
 * Negotiate is maker-exclusive. "Approve"/"Reject" (S5.9.1 Task 2) render only for Manager/Admin
 * once `decision.status === "PENDING_APPROVAL"` (`canCheck`, absorbing what used to be the
 * standalone `CheckerPanel`'s self-gate), each opening its own confirmation — `ApproveDialog`
 * names the shortlisted forwarder before firing `useApprove`, `RejectDialog` collects the required
 * reason before firing `useReject` — never mutating from the bar directly. Four-eyes
 * (`decision.sentByUserId === user.id`) disables both WITHOUT hiding them, with the same visible
 * hint `CheckerPanel` carried since S5.6; `CheckerPanel.tsx` itself is deleted (Task 2's judgement
 * call — see its own removal note atop `GenerateGate.test.tsx`, the file `CheckerPanel.test.tsx`
 * was renamed to once nothing `CheckerPanel`-shaped was left in it) since every line it rendered (the
 * hint, the two buttons, the reason form) now lives directly in this bar or in the two dialogs it
 * opens, leaving nothing for a separate component to own. `MakerPanel` below keeps only the
 * rejection alert (or renders nothing) — the two locked-state explanations `DecisionChip` used to
 * carry as tooltip copy are simply gone with it (S5.9.1).
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
  const { user } = useAuth();
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
  // S5.9.1 Task 2 — same shape again, for `ApproveDialog`/`RejectDialog`. Both dialogs resolve
  // everything they need (the shortlisted offer, the reason form) straight off `leg`/their own
  // hooks, so these are likewise nothing more than "is this dialog open".
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);

  const [selectedOfferKey, setSelectedOfferKey] = useState<string | undefined>(undefined);
  const selectedOffer = leg.offers.find((o) => offerKey(o.quoteId, o.variant) === selectedOfferKey);

  // Once the leg's decision has left DRAFT the server 409s a re-send (award.service.ts's B2 guard),
  // so the Send affordance is withheld entirely rather than offered and rejected. `REJECTED` is
  // never persisted — `reject()` writes DRAFT + `rejectionReason` in one update — so a returned leg
  // is an editable DRAFT and keeps Send available (final review I2).
  const decisionStatus = leg.decision?.status;
  const canSend = !locked && decisionStatus !== "PENDING_APPROVAL" && decisionStatus !== "APPROVED";

  // S5.9.1 Task 2 (R3/R5) — `isChecker` gates Negotiate OFF (product item 1: Manager/Admin reject
  // with a reason instead) and gates Approve/Reject ON once there's something to check. This is
  // the SAME `user?.role === Role.ADMINISTRATOR || user?.role === Role.MANAGER` test
  // `CheckerPanel` used to self-gate on and `CompareQuotesPage`'s `canCheck` (for `GenerateGate`)
  // already uses — one predicate, computed identically wherever "is this viewer a checker?" comes
  // up, so the three call sites can't quietly drift apart on who counts.
  const isChecker = user?.role === Role.ADMINISTRATOR || user?.role === Role.MANAGER;
  // The `!locked` term is the final whole-branch review's fix: this component's `locked` contract
  // says the checker surfaces are NOT MOUNTED while locked, and the action BAR honoured that
  // (`!locked && hasActionBarControls`) — but `ApproveDialog`/`RejectDialog` below were gated on
  // `canCheck` alone, unlike the maker's own `NegotiateDialog`/`MakerPanel`, which carry `!locked`
  // explicitly. Unreachable today (a locked query's decisions are all APPROVED, so `canCheck` is
  // already false), which is exactly why it had to be fixed as a stated guard rather than left to
  // an incidental one. Folded into `canCheck` itself rather than repeated at each mount so there is
  // ONE definition of "this viewer may check this leg now" — which also makes the reset effect
  // below cover a `locked` transition without a second dependency.
  const canCheck = isChecker && !locked && decisionStatus === "PENDING_APPROVAL";
  // Four-eyes (S5.6) — disables Approve/Reject WITHOUT hiding them when this viewer is the same
  // one who sent the leg for approval. `leg.decision` is guaranteed non-null whenever `canCheck` is
  // true (PENDING_APPROVAL only exists once a decision row does), but this reads directly off
  // `leg.decision` rather than assuming that, so it degrades to `false` (never a crash) if the two
  // ever come apart.
  const isSelf = user != null && leg.decision != null && leg.decision.sentByUserId === user.id;

  // Same class of bug the `canSend`/`sendOpen` effect below fixes, on the two new booleans: a
  // checker who opens Approve or Reject, then has the read model refetch out from under them
  // (another checker decides first, or `locked` engages) must not silently reopen the same dialog
  // if `canCheck` later becomes true again on a DIFFERENT pending decision. `{canCheck && (...)}`
  // already unmounts both dialogs the instant `canCheck` goes false; this clears the boolean that
  // drives their `open` prop too, so a later remount starts closed.
  useEffect(() => {
    if (!canCheck) {
      setApproveOpen(false);
      setRejectOpen(false);
    }
  }, [canCheck]);

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

  // Review round (Minor) — a checker viewing an already-APPROVED leg (one leg approved while
  // siblings are still pending, so `locked` hasn't engaged yet) has none of the three controls:
  // `!isChecker` is false (no Negotiate), `canCheck` is false (status isn't PENDING_APPROVAL any
  // more), and `canSend` is false (APPROVED is one of the two statuses that turns it off). Without
  // this check the bar below still rendered — a bare `border-t`/`pt-3` div with nothing in it, a
  // stray rule-and-padding with no controls. `hasActionBarControls` names the exact same three
  // conditions the JSX already gates each control on, so it can't drift from what actually renders
  // inside.
  const hasActionBarControls = !isChecker || canCheck || canSend;

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
          {/* ONE action bar shared by maker and checker roles (S5.9.1 Task 2), withheld entirely
              (not merely disabled) once locked, per this component's own `locked` contract. Each
              control keeps its own gate — Negotiate to `!isChecker`, Send to `canSend` for every
              role, Approve/Reject to `canCheck` — rather than swapping the whole bar by role: see
              this component's doc comment for why. `hasActionBarControls` withholds the bar itself
              (not just each button) once none of the three would render — e.g. a checker viewing an
              already-APPROVED leg — so it never renders as a bare, control-less rule with padding. */}
          {!locked && hasActionBarControls && (
            <div
              data-testid="leg-action-bar"
              className="flex items-center justify-end gap-2 border-t border-border pt-3"
            >
              {!isChecker && negotiateDisabledReason && (
                <span className="text-xs text-muted-foreground">{negotiateDisabledReason}</span>
              )}
              {!isChecker && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={negotiateDisabledReason != null}
                  onClick={() => setNegotiateOpen(true)}
                >
                  Negotiate…
                </Button>
              )}
              {canCheck && isSelf && (
                <span className="text-xs text-muted-foreground">
                  You sent this for approval — another manager must decide.
                </span>
              )}
              {canCheck && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isSelf}
                  onClick={() => setRejectOpen(true)}
                >
                  Reject
                </Button>
              )}
              {canCheck && (
                <Button
                  type="button"
                  size="sm"
                  disabled={isSelf}
                  onClick={() => setApproveOpen(true)}
                >
                  Approve
                </Button>
              )}
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
          {canCheck && (
            <ApproveDialog
              open={approveOpen}
              onOpenChange={setApproveOpen}
              queryId={queryId}
              leg={leg}
            />
          )}
          {canCheck && (
            <RejectDialog
              open={rejectOpen}
              onOpenChange={setRejectOpen}
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
          {/* `!isChecker` alongside `!locked` (final whole-branch review): the "Negotiate…" button
              is hidden for Manager/Admin (R3 — their path to a revised price is Reject-with-reason),
              so mounting the dialog for them was a dead mount with no way to open it. Mirrors the
              button's own gate exactly, the same way `canCheck` now gates both the Approve/Reject
              buttons and their dialogs. */}
          {!locked && !isChecker && (
            <NegotiateDialog
              open={negotiateOpen}
              onOpenChange={setNegotiateOpen}
              queryId={queryId}
              legId={leg.legId}
              leg={leg}
            />
          )}
          {!locked && <MakerPanel leg={leg} />}
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
function ViewModeToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
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
