import type { StepSaveFn } from "./Step1Client";
import { LegsStep as LegsStepImpl } from "./legs/LegsStep";

interface LegsStepProps {
  registerSave: (fn: StepSaveFn) => void;
}

/**
 * Step 4 — Legs / Route. Thin pass-through to the full implementation in
 * ./legs/LegsStep, which registers the Save/Next validation gate: Save persists +
 * surfaces route findings; Next blocks advancing on any create-phase route error.
 */
export function LegsStep({ registerSave }: LegsStepProps) {
  return <LegsStepImpl registerSave={registerSave} />;
}
