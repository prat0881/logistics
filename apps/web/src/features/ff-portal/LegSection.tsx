import { useMemo, useState } from "react";
import { useForm, FormProvider, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { FfPortalLegDto, FfPortalRfqDto, QuoteDraft, Finding } from "@svyft/shared";
import { quoteDraftSchema, validateQuote, computeQuoteTotals } from "@svyft/shared";
import { draftFromDto } from "./draftFromDto";
import { useSaveDraft, useSubmit } from "./useFfPortal";
import { PortalError } from "./portalClient";
import { CargoManifestTable } from "./CargoManifestTable";
import { DensityChargeableGrid } from "./DensityChargeableGrid";
import { ChargeZonePanel } from "./ChargeZonePanel";
import { RoadChargesPanel } from "./RoadChargesPanel";
import { TruckingBlocks } from "./TruckingBlocks";
import { WarehouseStaging } from "./WarehouseStaging";
import { TransitPlanForm } from "./TransitPlanForm";
import { QuoteSummary } from "./QuoteSummary";
import { QuoteFindingsSummary } from "./QuoteFindingsSummary";
import { SubmissionBar } from "./SubmissionBar";
import { AlreadySubmittedSummary } from "./terminalStates";
import { sectionAnchorId } from "./findingNav";
import type { PortalSection } from "./findingNav";

export interface LegSectionProps {
  token: string;
  rfq: FfPortalRfqDto;
  leg: FfPortalLegDto;
  currency: string | null;            // page-level (source of truth)
  quoteValidityUntil: string | null;  // page-level (source of truth)
  readOnly: boolean;                   // deadline passed OR leg not RFQ_SENT
}

export function LegSection({
  token,
  rfq,
  leg,
  currency,
  quoteValidityUntil,
  readOnly,
}: LegSectionProps): JSX.Element {
  // ── Status branch: QUOTED ──────────────────────────────────────────────
  if (leg.status === "QUOTED") {
    return <AlreadySubmittedSummary leg={leg} rfq={rfq} />;
  }

  // ── Status branch: not RFQ_SENT (e.g. CANCELLED, DRAFT, etc.) ─────────
  if (leg.status !== "RFQ_SENT") {
    return (
      <div className="space-y-4">
        <CargoManifestTable cargo={leg.manifest.cargo} />
        <p className="text-sm text-muted-foreground">
          This leg is not open for quoting.
        </p>
      </div>
    );
  }

  // ── Editable form (RFQ_SENT) ───────────────────────────────────────────
  return (
    <LegSectionForm
      token={token}
      rfq={rfq}
      leg={leg}
      currency={currency}
      quoteValidityUntil={quoteValidityUntil}
      readOnly={readOnly}
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
}: LegSectionProps): JSX.Element {
  const form = useForm<QuoteDraft>({
    resolver: zodResolver(quoteDraftSchema),
    defaultValues: draftFromDto(leg, rfq),
  });

  // Live draft: merge page-level currency & validity (source of truth)
  const watched = useWatch({ control: form.control });
  const draft = useMemo(
    () => ({ ...(watched as QuoteDraft), currency, quoteValidityUntil }),
    [watched, currency, quoteValidityUntil],
  );

  // Findings state
  const [attempted, setAttempted] = useState(false);
  const [serverFindings, setServerFindings] = useState<Finding[] | null>(null);

  const clientFindings = attempted
    ? validateQuote(draft, rfq.submissionDeadline, new Date().toISOString())
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
    setAttempted(true);
    const d = buildDraft();
    const f = validateQuote(d, rfq.submissionDeadline, new Date().toISOString());
    if (f.length > 0) return; // client-invalid: show findings, do NOT hit network

    try {
      await saved.mutateAsync(d);   // save first
      await submit.mutateAsync();   // then submit (server reads stored draft)
      // on success: query invalidation in hooks triggers refetch → leg becomes QUOTED
    } catch (e) {
      if (e instanceof PortalError && e.status === 422) {
        setServerFindings(e.findings ?? []);
      }
      // 409 already-submitted: invalidation/refetch will surface QUOTED state
    }
  };

  // Anchor navigation handler
  const handleNavigate = (section: PortalSection) => {
    const id = section === "rfq" ? "rfq-fields" : sectionAnchorId(leg.legId, section);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  // DG note visibility
  const showDgNote = draft.cargo?.some((c) => c.isDangerous) ?? false;

  // Grand total
  const { grandTotal } = computeQuoteTotals(draft);

  return (
    <FormProvider {...form}>
      <div className="space-y-8">
        {/* Cargo manifest — always visible at top */}
        <section>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Cargo manifest
          </h3>
          <CargoManifestTable cargo={leg.manifest.cargo} />
        </section>

        {/* Density & chargeable weight */}
        <section id={sectionAnchorId(leg.legId, "density")}>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Density &amp; chargeable weight
          </h3>
          <DensityChargeableGrid cargo={leg.manifest.cargo} />
        </section>

        {/* Mode pricing: AIR/SEA → ChargeZonePanel, ROAD → TruckingBlocks */}
        <section id={sectionAnchorId(leg.legId, "charges")}>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {leg.mode === "ROAD" ? "Trucking" : "Charges"}
          </h3>
          {leg.mode === "ROAD" ? (
            <>
              <TruckingBlocks endpoints={leg.endpoints} />
              <RoadChargesPanel />
            </>
          ) : (
            <ChargeZonePanel />
          )}
        </section>

        {/* Warehouse staging */}
        <section id={sectionAnchorId(leg.legId, "warehouse")}>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Warehousing
          </h3>
          <WarehouseStaging />
        </section>

        {/* Transit plan */}
        <section id={sectionAnchorId(leg.legId, "transit")}>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Transit plan
          </h3>
          <TransitPlanForm />
        </section>

        {/* Quote summary */}
        <QuoteSummary draft={draft} currency={currency} />

        {/* Findings summary */}
        <QuoteFindingsSummary findings={displayedFindings} onNavigate={handleNavigate} />

        {/* Submission bar — anchored for "terms" navigation */}
        <section id={sectionAnchorId(leg.legId, "terms")}>
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
