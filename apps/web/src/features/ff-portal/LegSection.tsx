import { useMemo, useState } from "react";
import { useForm, FormProvider, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  FfPortalLegDto,
  FfPortalRfqDto,
  QuoteDraft,
  Finding,
  ResolvedChargeLine,
} from "@svyft/shared";
import { quoteDraftSchema, validateQuote, computeQuoteTotals } from "@svyft/shared";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import type { BadgeProps } from "@/components/ui/badge";
import { draftFromDto } from "./draftFromDto";
import { useSaveDraft, useSubmit } from "./useFfPortal";
import { PortalError } from "./portalClient";
import { CargoManifestTable } from "./CargoManifestTable";
import { CargoWeightTable } from "./CargoWeightTable";
import { ChargeMatrix } from "./ChargeMatrix";
import { WarehouseStaging } from "./WarehouseStaging";
import { TransitPlanForm } from "./TransitPlanForm";
import { QuoteSummary } from "./QuoteSummary";
import { QuoteFindingsSummary } from "./QuoteFindingsSummary";
import { SubmissionBar } from "./SubmissionBar";
import { AlreadySubmittedSummary, ManifestUnavailableCard } from "./terminalStates";
import { isV2Manifest } from "./manifestGuard";
import { sectionAnchorId, navigateToFindingSection } from "./findingNav";
import type { PortalSection } from "./findingNav";

export interface LegSectionProps {
  token: string;
  rfq: FfPortalRfqDto;
  leg: FfPortalLegDto;
  currency: string | null; // page-level (source of truth)
  quoteValidityUntil: string | null; // page-level (source of truth)
  readOnly: boolean; // deadline passed OR leg not RFQ_SENT
  open: boolean; // accordion: is this leg's body expanded (design §4.8 finding #1)
  onOpen: () => void; // force this leg open — header click, or a finding's force-open
}

export function LegSection({
  token,
  rfq,
  leg,
  currency,
  quoteValidityUntil,
  readOnly,
  open,
  onOpen,
}: LegSectionProps): JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <LegSectionHeader leg={leg} open={open} onOpen={onOpen} />
      {open && (
        <div className="border-t border-border p-4">
          <LegSectionBody
            token={token}
            rfq={rfq}
            leg={leg}
            currency={currency}
            quoteValidityUntil={quoteValidityUntil}
            readOnly={readOnly}
            onOpen={onOpen}
          />
        </div>
      )}
    </div>
  );
}

// ── Accordion header — leg code · route summary · status (design §4.8, port of the executive
//    RfqWorkspace/LegPanel header pattern). Always rendered, regardless of `open` — even a
//    QUOTED/terminal leg is collapsible (design §4.8 finding #1) — only the body below is gated.
function LegSectionHeader({
  leg,
  open,
  onOpen,
}: {
  leg: FfPortalLegDto;
  open: boolean;
  onOpen: () => void;
}): JSX.Element {
  const status = legStatusBadge(leg.status);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={open}
      className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
    >
      {open ? (
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <span className="shrink-0 rounded bg-primary/10 px-2 py-0.5 font-mono text-xs font-semibold text-primary">
        {leg.manifest.legCode}
      </span>
      <span className="truncate text-sm font-medium">{routeSummary(leg)}</span>
      <span className="ml-auto shrink-0">
        <Badge variant={status.variant}>{status.label}</Badge>
      </span>
    </button>
  );
}

/** name → city → country fallback, matching the executive LegPanel's own point-label precedence
 *  (packages/shared re-exposes nothing street/contact-level here — ManifestSnapshot's origin /
 *  destination are already the same masked whitelist ScopedRouteDiagram / RfqPrintView use). */
function routeSummary(leg: FfPortalLegDto): string {
  const label = (
    loc: { name: string | null; city: string | null; country: string | null } | null,
  ): string => loc?.name ?? loc?.city ?? loc?.country ?? "—";
  return `${label(leg.manifest.origin)} → ${label(leg.manifest.destination)}`;
}

const LEG_STATUS_BADGE: Record<string, { label: string; variant: BadgeProps["variant"] }> = {
  RFQ_SENT: { label: "Open for quoting", variant: "secondary" },
  QUOTED: { label: "Quoted", variant: "success" }, // distinct from AlreadySubmittedSummary's own
  // "Quote submitted" badge text (inside the gated body) so the two don't collide when both render
  SELECT: { label: "Not yet sent", variant: "pending" },
  EXPIRED: { label: "Expired", variant: "warning" },
  INVALID: { label: "Invalid", variant: "destructive" },
  REQUOTED: { label: "Requote requested", variant: "warning" },
  CLOSED: { label: "Closed", variant: "pending" },
  // D9 — the forwarder must never learn a commercial outcome from this screen. Approval selects
  // a forwarder with NO forwarder notification and stays reversible until the client accepts
  // (design D5), and a leading forwarder who knows they are leading has no reason to sharpen.
  // Both internal states therefore read as one neutral label.
  PENDING_APPROVAL: { label: "Under review", variant: "secondary" },
  APPROVED: { label: "Under review", variant: "secondary" },
};
function legStatusBadge(status: string): { label: string; variant: BadgeProps["variant"] } {
  return LEG_STATUS_BADGE[status] ?? { label: status, variant: "outline" };
}

// ── Body — the original per-status branches (Round-4 Task 4's warehouse conditional, the charge
//    table, etc.), unchanged; only mounted while the accordion header above is open. ───────────
interface LegSectionBodyProps {
  token: string;
  rfq: FfPortalRfqDto;
  leg: FfPortalLegDto;
  currency: string | null;
  quoteValidityUntil: string | null;
  readOnly: boolean;
  onOpen: () => void;
}

function LegSectionBody({
  token,
  rfq,
  leg,
  currency,
  quoteValidityUntil,
  readOnly,
  onOpen,
}: LegSectionBodyProps): JSX.Element {
  // ── Guard: pre-v2 (legacy) manifest snapshot ───────────────────────────
  // RFQs distributed before the Cargo→Package re-model can carry a frozen manifest.cargo in the
  // old shape. Every branch below (QUOTED's AlreadySubmittedSummary, "not open for quoting", and
  // the editable RFQ_SENT form) reads leg.manifest.cargo assuming the v2 per-package shape and
  // will throw on the old one — check this first so a legacy leg degrades on its own instead of
  // white-screening the whole portal. Sibling legs on the same portal are unaffected.
  if (!isV2Manifest(leg.manifest)) {
    return <ManifestUnavailableCard />;
  }

  // ── Status branch: QUOTED ──────────────────────────────────────────────
  if (leg.status === "QUOTED") {
    return <AlreadySubmittedSummary leg={leg} rfq={rfq} />;
  }

  // ── Status branch: not open ────────────────────────────────────────────
  // REQUOTED belongs with RFQ_SENT, not here: ff-portal.service.ts's submit guard accepts both,
  // and a re-quote request exists precisely so the forwarder can revise. Omitting it dead-ended
  // the whole negotiate flow — the forwarder was told the leg was closed (S5.9 §1).
  if (leg.status !== "RFQ_SENT" && leg.status !== "REQUOTED") {
    return (
      <div className="space-y-4">
        <CargoManifestTable cargo={leg.manifest.cargo} />
        <p className="text-sm text-muted-foreground">This leg is not open for quoting.</p>
      </div>
    );
  }

  // ── Editable form (RFQ_SENT | REQUOTED) ────────────────────────────────
  return (
    <LegSectionForm
      token={token}
      rfq={rfq}
      leg={leg}
      currency={currency}
      quoteValidityUntil={quoteValidityUntil}
      readOnly={readOnly}
      onOpen={onOpen}
    />
  );
}

// Split into inner form component so hooks are always called at the same level
function LegSectionForm({
  token,
  rfq,
  leg,
  currency,
  quoteValidityUntil,
  readOnly,
  onOpen,
}: LegSectionBodyProps): JSX.Element {
  const form = useForm<QuoteDraft>({
    resolver: zodResolver(quoteDraftSchema),
    defaultValues: draftFromDto(leg, rfq),
  });

  // Active charge lines for the client-side Q_PRICED gate — mirrors the server's frozen
  // ChargeConfigSnapshot.lines (ff-portal.service.ts's `snap.lines`, passed to validateQuote at
  // submit). Only seeded lines carrying a definitionKey are catalogue lines subject to the gate
  // (a genuine custom [+ Add line] row has none and is gated separately, by Q_CUSTOM_*).
  const activeLines: ResolvedChargeLine[] = useMemo(
    () =>
      leg.seededCharges
        .filter((s): s is typeof s & { definitionKey: string } => s.definitionKey != null)
        .map((s) => ({
          definitionKey: s.definitionKey,
          role: "CORE" as const, // unused by validateQuote; shape-fill only
          inputType: s.inputType ?? "PLAIN",
          zone: s.zone,
          label: s.label,
        })),
    [leg.seededCharges],
  );

  // Live draft: merge page-level currency & validity (source of truth)
  const watched = useWatch({ control: form.control });
  const draft = useMemo(
    () => ({ ...(watched as QuoteDraft), currency, quoteValidityUntil }),
    [watched, currency, quoteValidityUntil],
  );

  // Findings state
  const [attempted, setAttempted] = useState(false);
  const [serverFindings, setServerFindings] = useState<Finding[] | null>(null);
  // Stale-page guard (S5.9 D10): the server's own message ("please refresh…") for a 409 whose
  // basis moved out from under this open page — surfaced inline rather than swallowed.
  const [submitError, setSubmitError] = useState<string | null>(null);

  const clientFindings = attempted
    ? validateQuote(draft, rfq.submissionDeadline, new Date().toISOString(), activeLines)
    : [];
  const displayedFindings = serverFindings ?? clientFindings;

  // Mutations
  const saved = useSaveDraft(token, leg.legId);
  const submit = useSubmit(token, leg.legId);

  // savedAt timestamp
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Build draft from current form values (with page-level overrides)
  const buildDraft = (): QuoteDraft => ({
    ...form.getValues(),
    currency,
    quoteValidityUntil,
  });

  // Save draft handler (no validation)
  const onSaveDraft = () => {
    setServerFindings(null);
    saved.mutate(buildDraft(), {
      onSuccess: () => setSavedAt(Date.now()),
    });
  };

  // Submit handler
  const onSubmit = async () => {
    setServerFindings(null);
    setSubmitError(null);
    setAttempted(true);
    const d = buildDraft();
    const f = validateQuote(d, rfq.submissionDeadline, new Date().toISOString(), activeLines);
    if (f.length > 0) return; // client-invalid: show findings, do NOT hit network

    try {
      await saved.mutateAsync(d); // save first
      // `leg.version` — echoed verbatim from the same DTO this form is rendering, never a value
      // cached elsewhere (S5.9 D10): the guard is only meaningful if it checks THIS page's basis.
      await submit.mutateAsync(leg.version); // then submit (server reads stored draft)
      // on success: query invalidation in hooks triggers refetch → leg becomes QUOTED
    } catch (e) {
      if (e instanceof PortalError && e.status === 422) {
        setServerFindings(e.findings ?? []);
      } else if (e instanceof PortalError && e.status === 409) {
        // Stale-page guard (or the pre-existing already-submitted guard) — show the server's own
        // message inline (design D10) instead of failing silently; the forwarder is told to
        // refresh, which re-fetches the leg DTO and its current `version`.
        setSubmitError(
          e.serverMessage ?? "This RFQ has been updated — please refresh the page before submitting.",
        );
      }
    }
  };

  // Anchor navigation handler — force-opens this leg (design §4.8 finding #1: the accordion
  // gates the body below on `open`, so a collapsed leg's section anchors aren't mounted at all)
  // before scrolling to the target section.
  const handleNavigate = (section: PortalSection) =>
    navigateToFindingSection(leg.legId, section, onOpen);

  // DG note visibility — DG is a package reference tag (frozen manifest), not a cargo-draft field
  const showDgNote = leg.manifest.cargo.some((c) => c.tags.includes("DG"));

  // Grand total (sticky SubmissionBar figure): v2 is dual-rate (one grandTotal per variant —
  // see QuoteSummary for the full side-by-side breakdown); the sticky bar needs one number, so
  // show the highest variant total. Same reduction as the server-side summary field
  // (ff-portal.service.ts's Quote.grandTotal at submit).
  const { variants } = computeQuoteTotals(draft);
  const grandTotal = Math.max(...variants.map((v) => v.grandTotal), 0);

  // design §6C finding #7: the Warehousing section+heading only renders when the leg actually has
  // warehouse rows to price — `draft.warehouse` is draftFromDto's seed of the leg's frozen
  // warehouseIncluded decision (design §9), the same source WarehouseStaging itself reads, so this
  // can't disagree with whether that component would render anything.
  const hasWarehouse = draft.warehouse.length > 0;

  return (
    <FormProvider {...form}>
      <div className="space-y-8">
        {/* Cargo & chargeable weight — merged table (design §6 finding #2): per-package rows,
            a Totals row, and the one leg-level Chargeable Weight (kg) input, all in one table. */}
        <section id={sectionAnchorId(leg.legId, "density")}>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Cargo & weight
          </h3>
          <CargoWeightTable manifest={leg.manifest.cargo} legId={leg.legId} />
        </section>

        {/* Mode pricing: the per-variant charge matrix (design §3.1/§6 finding #3/#6) — rows are
            the seeded charge headers + the mode's freight-rate row, columns are variantsForMode
            (Road: Dedicated/Groupage, Sea: FCL/LCL, Air: a single column). Replaces the old
            ChargeZonePanel/RoadChargesPanel/TruckingBlocks/SeaChargesPanel entry. */}
        <section id={sectionAnchorId(leg.legId, "charges")}>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Charges
          </h3>
          <ChargeMatrix seededCharges={leg.seededCharges} mode={leg.mode} />
        </section>

        {/* Warehouse staging — entire section (heading included) hidden when the leg has no
            warehouse (design §6C finding #7); today WarehouseStaging itself already renders
            nothing for an empty list, but the wrapper used to render regardless. */}
        {hasWarehouse && (
          <section id={sectionAnchorId(leg.legId, "warehouse")}>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Warehousing
            </h3>
            <WarehouseStaging />
          </section>
        )}

        {/* Transit plan */}
        <section id={sectionAnchorId(leg.legId, "transit")}>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Transit plan
          </h3>
          <TransitPlanForm mode={leg.mode} legId={leg.legId} />
        </section>

        {/* Quote summary */}
        <QuoteSummary draft={draft} currency={currency} />

        {/* Findings summary */}
        <QuoteFindingsSummary findings={displayedFindings} onNavigate={handleNavigate} />

        {/* Notes (design §6 finding #5): FF free-text notes, rendered immediately before the
            Accept-terms control — the very next section opens with SubmissionBar's own
            "I accept the terms & conditions" checkbox. Distinct from dgSurchargeNote (below, DG
            only) and termsConditions. */}
        <section id={sectionAnchorId(leg.legId, "notes")}>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Notes
          </h3>
          <Textarea
            aria-label="Notes"
            placeholder="Add any notes for this quote..."
            {...form.register("notes")}
          />
        </section>

        {/* Submission bar — anchored for "terms" navigation */}
        <section id={sectionAnchorId(leg.legId, "terms")}>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Terms
          </h3>
          {/* Stale-page / already-submitted 409 (design D10) — the server's own message, shown
              inline right above the Submit button rather than as a silent/generic failure. */}
          {submitError && (
            <p
              role="alert"
              className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            >
              {submitError}
            </p>
          )}
          <SubmissionBar
            showDgNote={showDgNote}
            currency={currency}
            grandTotal={grandTotal}
            saving={saved.isPending}
            submitting={submit.isPending}
            savedAt={savedAt}
            disabled={readOnly}
            onSaveDraft={onSaveDraft}
            onSubmit={onSubmit}
          />
        </section>
      </div>
    </FormProvider>
  );
}
