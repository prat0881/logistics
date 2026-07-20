import { useEffect } from "react";
import type { StepSaveFn } from "./Step1Client";
import { LegsStep as LegsStepImpl } from "./legs/LegsStep";

interface LegsStepProps {
  registerSave: (fn: StepSaveFn) => void;
}

/**
 * Step 4 — Legs / Route.
 * Delegates to the full implementation in ./legs/LegsStep.
 * registerSave is a no-op here — leg writes happen immediately via useLegs.
 */
export function LegsStep({ registerSave }: LegsStepProps) {
  useEffect(() => {
    registerSave(async () => undefined);
  }, [registerSave]);

  return <LegsStepImpl />;
}
