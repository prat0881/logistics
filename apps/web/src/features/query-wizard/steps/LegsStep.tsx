import { useEffect } from "react";
import type { StepSaveFn } from "./Step1Client";

interface LegsStepProps {
  registerSave: (fn: StepSaveFn) => void;
}

/**
 * Step 4 — Legs / Route (placeholder)
 * Full implementation coming in a later task.
 */
export function LegsStep({ registerSave }: LegsStepProps) {
  useEffect(() => {
    registerSave(async () => undefined);
  }, [registerSave]);

  return (
    <div className="p-4">
      <p className="text-sm text-muted-foreground">Step 4 — Legs / Route (placeholder, full form coming in a later task)</p>
    </div>
  );
}
