import { useEffect } from "react";
import type { StepSaveFn } from "./Step1Client";

interface Step2ShipmentProps {
  registerSave: (fn: StepSaveFn) => void;
}

/**
 * Step 2 — Shipment (placeholder)
 * Full implementation coming in a later task.
 */
export function Step2Shipment({ registerSave }: Step2ShipmentProps) {
  useEffect(() => {
    registerSave(async () => undefined);
  }, [registerSave]);

  return (
    <div className="p-4">
      <p className="text-sm text-muted-foreground">Step 2 — Shipment (placeholder, full form coming in a later task)</p>
    </div>
  );
}
