/**
 * Step component registry — keyed by STEPS[n].key.
 * Later tasks (6–12) swap one entry by replacing the named component
 * in the corresponding file; no change to this index or the shell required.
 */
export { Step1Client } from "./Step1Client";
export { Step2Shipment } from "./Step2Shipment";
export { Step3Cargo } from "./Step3Cargo";
export { LegsStep } from "./LegsStep";
export { Step5Notes } from "./Step5Notes";
export type { StepSaveFn } from "./Step1Client";
