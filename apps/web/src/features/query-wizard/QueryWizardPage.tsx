import { useCallback, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { StageRail, isRfqStageEnabled } from "@/features/rfq-workspace/StageRail";
import type {
  Finding,
  QueryForValidation,
  PackageForValidation,
  PackageDto,
  QuerySaveInput,
  QueryDetail,
} from "@svyft/shared";
import {
  collectCreateFindings,
  collectChecklistFindings,
  validateRoute,
  dedupeFindings,
} from "@svyft/shared";
import { ApiError } from "@/lib/api";
import { WizardProvider, STEPS, useWizard } from "./WizardContext";
import { WizardShell } from "./WizardShell";
import { useQueryDetail, useSaveQuery, useCreateQuery } from "./useQueryDetail";
import { Step1Client, Step2Shipment, Step3Cargo, LegsStep, Step5Notes } from "./steps";
import type { StepSaveFn } from "./steps";
import { toRouteGraph } from "./steps/legs/routeGraph";
import { CHECKLIST_LABELS } from "./steps/Step5Notes";

/**
 * stepComponents registry — keyed by step key (order O2: client · shipment · cargo · legs · notes).
 * Later tasks (6–12) swap one entry by updating the named component file;
 * this map and the shell remain stable.
 */
const stepComponents: Record<
  (typeof STEPS)[number]["key"],
  React.ComponentType<{ registerSave: (fn: StepSaveFn) => void }>
> = {
  client: Step1Client,
  shipment: Step2Shipment,
  cargo: Step3Cargo,
  legs: LegsStep,
  notes: Step5Notes,
};

// ── Mappers for the client-side preview ──────────────────────────────────────

function toQueryForValidation(
  detail: NonNullable<ReturnType<typeof useWizard>["detail"]>,
): QueryForValidation {
  return {
    id: detail.id,
    clientId: detail.clientId,
    contactName: detail.contactName,
    contactEmail: detail.contactEmail,
    contactPhone: detail.contactPhone,
    readyDate: detail.readyDate,
    targetDelivery: detail.targetDelivery,
    incoterms: (detail.incoterms as QueryForValidation["incoterms"]) ?? null,
  };
}

function toPackageForValidation(p: PackageDto): PackageForValidation {
  return {
    id: p.id,
    packageNo: p.packageNo,
    effectiveTags: p.effectiveTags, // already the union (own ∪ items) from shapePackage
    msdsFileId: p.msdsFileId,
    dimL: Number(p.dimL),
    dimW: Number(p.dimW),
    dimH: Number(p.dimH),
    grossWt: Number(p.grossWt),
  };
}

// ── Inner component — has access to WizardContext ─────────────────────────────

/** Inner component — has access to WizardContext */
function WizardInner({ id }: { id?: string }) {
  const navigate = useNavigate();
  const { isNew, step, detail, refresh } = useWizard();
  const { create, patch } = useSaveQuery();
  const createQuery = useCreateQuery();
  const qc = useQueryClient();
  const [findings, setFindings] = useState<Finding[]>([]);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  // Holds the current step's save fn
  const stepSaveRef = useRef<StepSaveFn | null>(null);

  const registerSave = useCallback((fn: StepSaveFn) => {
    stepSaveRef.current = fn;
  }, []);

  /**
   * handleSave — called by the shell's Save (and Next).
   * - new query: call the step's save, then POST → navigate to /queries/:id (no
   *   ?step= — S3.4: the wizard's `localStep` is authoritative and survives this
   *   navigate uninterrupted, so a Next that triggered the mint can advance the
   *   step in the same click instead of being reset back to step 0. Save uses the
   *   same branch but never calls goNext, so it still stays put on the new query.)
   * - existing query: call the step's save (step returns a QuerySaveInput patch or void)
   */
  const handleSave = useCallback(async () => {
    if (isNew) {
      // A new query mints on the first Save/Next even if the step's own format
      // validation rejected (Next never blocks; the query must exist before we can
      // advance). Inline field errors still surface the format issue.
      let input: QuerySaveInput | void;
      try {
        input = stepSaveRef.current ? await stepSaveRef.current() : undefined;
      } catch {
        input = undefined;
      }
      const d = await create(input ?? {});
      navigate(`/queries/${d.id}`, { replace: true });
      return;
    }
    const input = stepSaveRef.current ? await stepSaveRef.current() : undefined;
    if (id && input) {
      await patch(id, input);
      await refresh();
    }
  }, [isNew, id, create, patch, navigate, refresh]);

  /**
   * handleCreateQuery — fired on the final step's "Create Query" button.
   *
   * Flow:
   *   0. S3.3 — save the current step first (same as the Save button), then
   *      refresh, so the gate reads freshly-persisted state. Checklist ticks
   *      live in Step5Notes' local state and only reach the server via the
   *      step's save (PATCH /checklist); without this the gate reads a stale
   *      `detail` and blocks Create even though the boxes are ticked.
   *   1. Client-side preview (against the FRESH detail): compute blocking
   *      findings from collectCreateFindings + validateRoute +
   *      collectChecklistFindings. If any blocking → render them inline and
   *      abort (Create is the single gate).
   *   2. POST /api/queries/:id/create. On 422 → store server findings.
   *      On 201 → re-GET (refresh) → banner.
   */
  const handleCreateQuery = useCallback(async () => {
    if (!id || !detail) return;
    setFindings([]);
    setSuccessBanner(null);

    // ── 0. Save the current step, then re-fetch so the gate is fresh ─────────
    try {
      await handleSave();
    } catch {
      /* best-effort: inline field errors already surface any format issue */
    }
    await refresh();
    const fresh = qc.getQueryData<QueryDetail>(["query", id]) ?? detail;

    // ── 1. Client-side preview (against the FRESH detail) ────────────────────
    const graph = toRouteGraph(fresh);
    const checklistItems = fresh.checklist.map((c) => ({
      key: c.itemKey,
      checked: c.checked,
      label: CHECKLIST_LABELS[c.itemKey] ?? c.itemKey,
    }));
    const preview = dedupeFindings([
      ...collectCreateFindings(
        toQueryForValidation(fresh),
        fresh.cargos.flatMap((c) => c.packages).map(toPackageForValidation),
      ),
      ...validateRoute(graph, "create"),
      ...collectChecklistFindings(checklistItems, fresh.internalNotes),
    ]);
    const blocking = preview.filter((f) => f.severity === "blocking");
    if (blocking.length) {
      setFindings(blocking);
      return; // Create is the single gate — abort before the server call
    }

    // ── 2. POST /create ──────────────────────────────────────────────────────
    try {
      await createQuery.mutateAsync(id);
      // On success, re-GET to refresh status (POST only returns { id, status })
      await refresh();
      // detail may not have updated yet after refresh; use whatever code is available
      const code = fresh.queryCode ?? id;
      setSuccessBanner(`Query ${code} created successfully.`);
    } catch (err) {
      if (err instanceof ApiError && err.findings) {
        setFindings(err.findings);
      } else {
        throw err;
      }
    }
  }, [id, detail, createQuery, refresh, handleSave, qc]);

  const currentStepKey = STEPS[step]?.key ?? STEPS[0].key;
  const StepComponent = stepComponents[currentStepKey];

  return (
    <WizardShell
      findings={findings}
      onClearFindings={() => setFindings([])}
      onCreateQuery={handleCreateQuery}
      onSave={handleSave}
    >
      {successBanner && (
        <div
          role="status"
          className="mb-4 rounded-md bg-success/10 px-4 py-3 text-sm text-success font-medium"
        >
          {successBanner}
        </div>
      )}
      <StepComponent registerSave={registerSave} />
    </WizardShell>
  );
}

/**
 * QueryWizardPage — top-level page for /queries/new and /queries/:id.
 */
export function QueryWizardPage() {
  const { id } = useParams<{ id: string }>();
  const { data: railDetail } = useQueryDetail(id);

  return (
    <>
      {id && railDetail && (
        <div className="mb-4">
          <StageRail
            queryId={id}
            active="create"
            rfqEnabled={isRfqStageEnabled(railDetail.status)}
          />
        </div>
      )}
      <WizardProvider id={id}>
        <WizardInner id={id} />
      </WizardProvider>
    </>
  );
}
