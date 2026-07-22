import type { StepSaveFn } from "./Step1Client";
import { LegsStep as LegsStepImpl } from "./legs/LegsStep";

interface LegsStepProps {
  registerSave: (fn: StepSaveFn) => void;
}

/**
 * Step 4 — Leg & Route. Thin pass-through to the full implementation in
 * ./legs/LegsStep. Legs/points persist eagerly and validation is deferred to
 * Create Query; there is no Save/Next gate blocking advancement on route errors.
 */
export function LegsStep({ registerSave }: LegsStepProps) {
  return <LegsStepImpl registerSave={registerSave} />;
}
