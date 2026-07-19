import { useCallback, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import type { Finding } from "@svyft/shared";
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

/** Inner component — has access to WizardContext */
function WizardInner({ id }: { id?: string }) {
  const navigate = useNavigate();
  const { isNew, step, detail, refresh } = useWizard();
  const { create, patch } = useSaveQuery();
  const createQuery = useCreateQuery();
  const [findings, setFindings] = useState<Finding[]>([]);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  // Holds the current step's save fn
  const stepSaveRef = useRef<StepSaveFn | null>(null);

  const registerSave = useCallback((fn: StepSaveFn) => {
    stepSaveRef.current = fn;
  }, []);

  /**
   * handleSave — called by the shell's Save (and Next).
   * - new query: call the step's save, then POST → navigate to /queries/:id?step=0
   * - existing query: call the step's save (step returns a QuerySaveInput patch or void)
   */
  const handleSave = useCallback(async () => {
    const input = stepSaveRef.current ? await stepSaveRef.current() : undefined;
    if (isNew) {
      // First save mints the queryCode; even an empty body is valid
      const d = await create(input ?? {});
      navigate(`/queries/${d.id}?step=0`, { replace: true });
    } else if (id && input) {
      await patch(id, input);
      await refresh();
    }
  }, [isNew, id, create, patch, navigate, refresh]);

  /**
   * handleCreateQuery — fired on the final step's "Create Query" button.
   * POSTs to /api/queries/:id/create; on 422 stores findings; on success refreshes.
   */
  const handleCreateQuery = useCallback(async () => {
    if (!id) return;
    setFindings([]);
    setSuccessBanner(null);
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
  }, [id, createQuery, detail, refresh]);

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

  return (
    <WizardProvider id={id}>
      <WizardInner id={id} />
    </WizardProvider>
  );
}
