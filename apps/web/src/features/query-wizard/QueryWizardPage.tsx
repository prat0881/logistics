import { useCallback, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import type { Finding, QueryForValidation, CargoForValidation, QuerySaveInput } from "@svyft/shared";
import {
  collectCreateFindings,
  validateRoute,
  dedupeFindings,
} from "@svyft/shared";
import { ApiError } from "@/lib/api";
import { WizardProvider, STEPS, useWizard } from "./WizardContext";
import { WizardShell } from "./WizardShell";
import { useSaveQuery, useCreateQuery } from "./useQueryDetail";
import {
  Step1Client,
  Step2Shipment,
  Step3Cargo,
  LegsStep,
  Step5Notes,
} from "./steps";
import type { StepSaveFn } from "./steps";
import { toRouteGraph } from "./steps/legs/routeGraph";
import { CreateQueryDialog } from "./CreateQueryDialog";
import type { CreateQueryDialogResult, UncheckedItem } from "./CreateQueryDialog";
import { CHECKLIST_LABELS, DG_CONDITIONAL_KEY } from "./steps/Step5Notes";

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

function toCargoForValidation(
  cargo: NonNullable<ReturnType<typeof useWizard>["detail"]>["cargo"][number],
): CargoForValidation {
  return {
    id: cargo.id,
    isDangerous: cargo.isDangerous,
    msdsFileId: cargo.msdsFileId,
    poReference: cargo.poReference,
  };
}

// ── Inner component — has access to WizardContext ─────────────────────────────

/** Inner component — has access to WizardContext */
function WizardInner({ id }: { id?: string }) {
  const navigate = useNavigate();
  const { isNew, step, detail, refresh } = useWizard();
  const { create, patch } = useSaveQuery();
  const createQuery = useCreateQuery();
  const [findings, setFindings] = useState<Finding[]>([]);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  // Optional-gaps dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogItems, setDialogItems] = useState<UncheckedItem[]>([]);
  // A promise resolver to await the dialog result imperatively
  const dialogResolveRef = useRef<((r: CreateQueryDialogResult) => void) | null>(null);

  // Holds the current step's save fn
  const stepSaveRef = useRef<StepSaveFn | null>(null);

  const registerSave = useCallback((fn: StepSaveFn) => {
    stepSaveRef.current = fn;
  }, []);

  /**
   * confirmCreateDialog — opens the optional-gaps dialog and waits for user choice.
   */
  const confirmCreateDialog = useCallback(
    (unchecked: NonNullable<typeof detail>["checklist"]): Promise<CreateQueryDialogResult> => {
      const items: UncheckedItem[] = unchecked.map((c) => ({
        itemKey: c.itemKey,
        label: CHECKLIST_LABELS[c.itemKey] ?? c.itemKey,
      }));
      setDialogItems(items);
      setDialogOpen(true);
      return new Promise<CreateQueryDialogResult>((resolve) => {
        dialogResolveRef.current = resolve;
      });
    },
    [],
  );

  const handleDialogResult = useCallback(
    (result: CreateQueryDialogResult) => {
      setDialogOpen(false);
      if (dialogResolveRef.current) {
        dialogResolveRef.current(result);
        dialogResolveRef.current = null;
      }
    },
    [],
  );

  /**
   * handleSave — called by the shell's Save (and Next).
   * - new query: call the step's save, then POST → navigate to /queries/:id?step=0
   * - existing query: call the step's save (step returns a QuerySaveInput patch or void)
   */
  const handleSave = useCallback(
    async () => {
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
        navigate(`/queries/${d.id}?step=0`, { replace: true });
        return;
      }
      const input = stepSaveRef.current ? await stepSaveRef.current() : undefined;
      if (id && input) {
        await patch(id, input);
        await refresh();
      }
    },
    [isNew, id, create, patch, navigate, refresh],
  );

  /**
   * handleCreateQuery — fired on the final step's "Create Query" button.
   *
   * Flow:
   *   1. Client-side preview: compute blocking findings from collectCreateFindings +
   *      validateRoute. If any blocking → render them inline and abort.
   *   2. Optional-gaps prompt: if no blocking but checklist has unchecked items →
   *      open CreateQueryDialog. User can cancel, save draft, or send anyway.
   *   3. POST /api/queries/:id/create. On 422 → store server findings.
   *      On 201 → re-GET (refresh) → banner.
   */
  const handleCreateQuery = useCallback(async () => {
    if (!id || !detail) return;
    setFindings([]);
    setSuccessBanner(null);

    // ── 1. Client-side preview ───────────────────────────────────────────────
    const graph = toRouteGraph(detail);
    const preview = dedupeFindings([
      ...collectCreateFindings(
        toQueryForValidation(detail),
        detail.cargo.map(toCargoForValidation),
      ),
      ...validateRoute(graph, "create"),
    ]);
    const blocking = preview.filter((f) => f.severity === "blocking");
    if (blocking.length) {
      setFindings(blocking);
      return; // Hard block — do NOT call the server
    }

    // ── 2. Optional-gaps prompt ──────────────────────────────────────────────
    // G5: the DG-conditional MSDS item is un-checkable on a non-DG query, so it must
    // not count as a "missing optional" gap (else the prompt always nags about it).
    const uncheckedOptional = detail.checklist.filter(
      (c) => !c.checked && !(c.itemKey === DG_CONDITIONAL_KEY && !detail.dgIndicator),
    );
    if (uncheckedOptional.length) {
      const choice = await confirmCreateDialog(uncheckedOptional);
      if (choice === "cancel") return; // User bailed
      if (choice === "draft") {
        // G2: persist the current step before closing (previously this saved nothing).
        await handleSave();
        return;
      }
      // choice === "send" → fall through to create
    }

    // ── 3. POST /create ──────────────────────────────────────────────────────
    try {
      await createQuery.mutateAsync(id);
      // On success, re-GET to refresh status (POST only returns { id, status })
      await refresh();
      // detail may not have updated yet after refresh; use whatever code is available
      const code = detail?.queryCode ?? id;
      setSuccessBanner(`Query ${code} created successfully.`);
    } catch (err) {
      if (err instanceof ApiError && err.findings) {
        setFindings(err.findings);
      } else {
        throw err;
      }
    }
  }, [id, detail, createQuery, refresh, confirmCreateDialog, handleSave]);

  const currentStepKey = STEPS[step]?.key ?? STEPS[0].key;
  const StepComponent = stepComponents[currentStepKey];

  return (
    <>
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

      {/* Optional-gaps dialog — rendered outside WizardShell to avoid nesting issues */}
      <CreateQueryDialog
        open={dialogOpen}
        items={dialogItems}
        onResult={handleDialogResult}
      />
    </>
  );
}

/**
 * QueryWizardPage — top-level page for /queries/new and /queries/:id.
 */
export function QueryWizardPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <WizardProvider id={id}>
      <WizardInner id={id} />
    </WizardProvider>
  );
}
