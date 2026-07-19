import { useEffect } from "react";
import type { StepSaveFn } from "./Step1Client";

interface Step3CargoProps {
  registerSave: (fn: StepSaveFn) => void;
}

/**
 * Step 3 — Cargo (placeholder)
 * Full implementation coming in a later task.
 */
export function Step3Cargo({ registerSave }: Step3CargoProps) {
  useEffect(() => {
    registerSave(async () => undefined);
  }, [registerSave]);

  return (
    <div className="p-4">
      <p className="text-sm text-muted-foreground">Step 3 — Cargo (placeholder, full form coming in a later task)</p>
    </div>
  );
}
