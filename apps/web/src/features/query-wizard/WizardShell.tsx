import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PRIORITIES } from "@svyft/shared";
import type { Finding } from "@svyft/shared";
import { Stepper } from "@/components/ui/stepper";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { FindingsPanel } from "@/components/FindingsPanel";
import { STEPS } from "./WizardContext";
import { useWizard } from "./WizardContext";
import { useSaveQuery } from "./useQueryDetail";

interface WizardShellProps {
  children: ReactNode;
  /** Called when Save or Next is pressed — provided by QueryWizardPage. */
  onSave: () => Promise<void>;
  findings?: Finding[];
  onClearFindings?: () => void;
  /** Called by the final step's "Create Query" button — provided by QueryWizardPage */
  onCreateQuery?: () => Promise<void>;
}

/**
 * WizardShell — the frame around all 5 steps.
 * - Header: queryCode / status badge / priority select
 * - Stepper (jump-to enabled once detail exists)
 * - Body slot (children = current step)
 * - Action bar: Cancel | Back | Save | Next | Create Query
 * - FindingsPanel
 */
export function WizardShell({
  children,
  onSave,
  findings = [],
  onClearFindings,
  onCreateQuery,
}: WizardShellProps) {
  const navigate = useNavigate();
  const { detail, queryId, step, setStep, goNext, goBack } = useWizard();
  const { patch } = useSaveQuery();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const completedSteps = new Set<string>(
    STEPS.slice(0, step).map((s) => s.key),
  );

  const runSave = async (): Promise<boolean> => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      await onSave();
      return true;
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "unknown error");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    if (await runSave()) setSaveSuccess("Changes saved."); // U3
  };

  const handleNext = async () => {
    // Round-1 Common #5: Next never blocks. Best-effort save, then advance regardless.
    // Swallow a save rejection here (inline field errors already surface format issues
    // on the step) so we don't raise a confusing top-notice on the step we just left.
    setSaveError(null);
    setSaveSuccess(null);
    try {
      await onSave();
    } catch {
      /* never block navigation */
    }
    goNext();
  };

  const handleCancel = () => {
    const confirmed = window.confirm("Discard unsaved changes?");
    if (!confirmed) return;
    // U2: Cancel always returns to the Queries list (previously an existing query
    // just reverted in place).
    navigate("/queries");
  };

  const handlePriorityChange = async (value: string) => {
    if (!queryId) return;
    setSaveError(null);
    try {
      await patch(queryId, { priority: value as (typeof PRIORITIES)[number] });
    } catch (err) {
      // G4: surface a failed priority change instead of failing silently.
      setSaveError(err instanceof Error ? err.message : "unknown error");
    }
  };

  const isFinalStep = step === STEPS.length - 1;

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <div className="border-b bg-background px-4 sm:px-6 py-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="font-display text-lg font-semibold">
          <span className="font-mono">{detail?.queryCode ?? "New Query"}</span>
        </span>
        <Badge variant={detail?.status === "RFQ_READY" ? "success" : "pending"}>
          {detail?.status ?? "DRAFT"}
        </Badge>
        {queryId && (
          <Select
            value={detail?.priority ?? "MEDIUM"}
            onValueChange={handlePriorityChange}
            disabled={saving}
          >
            <SelectTrigger className="w-32 h-8 text-xs">
              <SelectValue placeholder="Priority" />
            </SelectTrigger>
            <SelectContent>
              {PRIORITIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Stepper */}
      <div className="border-b px-4 sm:px-6 py-3 overflow-x-auto">
        <Stepper
          steps={STEPS.map((s) => ({ key: s.key, label: s.label }))}
          current={STEPS[step]?.key ?? STEPS[0].key}
          completed={completedSteps}
          onStepClick={detail ? (key) => {
            const idx = STEPS.findIndex((s) => s.key === key);
            if (idx !== -1) setStep(idx);
          } : undefined}
        />
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-4 sm:px-6 py-6">
        {/* Notices (U4): success, errors, and findings all render here — at the top
            of the page (below the nav/stepper, above the step fields). */}
        {saveSuccess && (
          <div
            role="status"
            className="mb-4 rounded-md bg-success/10 px-4 py-3 text-sm font-medium text-success"
          >
            {saveSuccess}
          </div>
        )}
        {saveError && (
          <div
            role="alert"
            className="mb-4 rounded-md bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive"
          >
            {saveError}
          </div>
        )}
        {/* Findings */}
        {findings.length > 0 && (
          <div className="mb-4">
            <FindingsPanel findings={findings} phase="create" />
            {onClearFindings && (
              <button
                type="button"
                className="mt-2 rounded-sm text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                onClick={onClearFindings}
              >
                Dismiss
              </button>
            )}
          </div>
        )}
        {children}
      </div>

      {/* Sticky action bar */}
      <div className="sticky bottom-0 border-t bg-background px-4 sm:px-6 py-3 flex flex-wrap items-center justify-end gap-2 sm:gap-3">
        <Button variant="ghost" onClick={handleCancel} disabled={saving}>
          Cancel
        </Button>
        {step > 0 && (
          <Button variant="outline" onClick={goBack} disabled={saving}>
            Back
          </Button>
        )}
        <Button variant="outline" onClick={handleSave} disabled={saving}>
          Save
        </Button>
        {isFinalStep ? (
          <Button
            onClick={async () => {
              if (!onCreateQuery) return;
              setSaving(true);
              setSaveError(null);
              setSaveSuccess(null);
              try {
                await onCreateQuery();
              } catch (err) {
                // G3: surface non-422 create failures instead of swallowing them.
                setSaveError(err instanceof Error ? err.message : "unknown error");
              } finally {
                setSaving(false);
              }
            }}
            disabled={saving || !queryId}
          >
            Create Query
          </Button>
        ) : (
          <Button onClick={handleNext} disabled={saving}>
            Next
          </Button>
        )}
      </div>
    </div>
  );
}
